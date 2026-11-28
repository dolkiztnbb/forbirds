"""Real Git and SQLite fixtures, never the application's own checkout/branch."""
import fcntl
import json
import os
from pathlib import Path
import shlex
import sqlite3
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PHP = shlex.split(os.environ.get('PHP_BIN', 'php'))


class SiteUpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='forbirds-updater-')
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.origin, self.seed, self.deploy, self.storage = [self.base / n for n in ['origin.git', 'seed', 'deploy', 'storage']]
        self.storage.mkdir()
        (self.storage / 'app.key').write_text('fixture-key')
        db = sqlite3.connect(self.storage / 'forum.sqlite')
        db.execute('CREATE TABLE original (value TEXT)')
        db.execute("INSERT INTO original VALUES ('preserve me')")
        db.commit(); db.close()
        self.git('init', '--bare', '--initial-branch=main', str(self.origin))
        self.git('init', '--initial-branch=main', str(self.seed))
        self.git('-C', str(self.seed), 'config', 'user.email', 'tests@example.invalid')
        self.git('-C', str(self.seed), 'config', 'user.name', 'Updater fixture')
        (self.seed / 'bin').mkdir()
        (self.seed / 'bin/console.php').write_text('<?php exit(0);')
        (self.seed / 'revision.txt').write_text('old')
        self.commit('initial')
        self.git('-C', str(self.seed), 'remote', 'add', 'origin', str(self.origin))
        self.git('-C', str(self.seed), 'push', 'origin', 'main')
        self.git('clone', str(self.origin), str(self.deploy))
        self.before = self.git('-C', str(self.deploy), 'rev-parse', 'HEAD').strip()

    def git(self, *args, check=True):
        result = subprocess.run(['git', *args], cwd=self.base, text=True, capture_output=True, timeout=20)
        if check: self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def commit(self, name):
        self.git('-C', str(self.seed), 'add', '.')
        self.git('-C', str(self.seed), 'commit', '-m', name)

    def publish(self, failing=False):
        (self.seed / 'revision.txt').write_text('new')
        (self.seed / 'bin/console.php').write_text('''<?php
        $storage = getenv('FORBIRDS_STORAGE');
        file_put_contents($storage . '/migration-called', $argv[1]);
        if (''' + ('true' if failing else 'false') + ''') exit(7);
        $db = new PDO('sqlite:' . $storage . '/forum.sqlite');
        $db->exec('CREATE TABLE migrated (value TEXT)');
        ''')
        self.commit('new migration')
        self.git('-C', str(self.seed), 'push', 'origin', 'main')

    def call(self, action, enabled=True):
        script = '''require getenv('UPDATER_SOURCE');
        $u = new ForBirds\\SiteUpdater(['storage'=>getenv('UPDATE_STORAGE'), 'database'=>getenv('UPDATE_STORAGE').'/forum.sqlite', 'updates_enabled'=>getenv('UPDATE_ENABLED')==='1'], getenv('UPDATE_ROOT'));
        $action=getenv('UPDATE_ACTION');
        try { if ($action==='enter') { $lock=$u->enterRequest(); echo json_encode(['entered'=>true]); }
        elseif ($action==='queue') echo json_encode($u->enqueue(123));
        elseif ($action==='run') { $code=$u->run(); echo json_encode(['code'=>$code, 'state'=>$u->status()]); }
        else echo json_encode($u->status()); } catch (Throwable $e) { echo json_encode(['exception'=>$e->getMessage()]); }'''
        result = subprocess.run(PHP + ['-r', script], cwd=self.deploy, env={**os.environ, 'FORBIRDS_STORAGE': str(self.storage), 'UPDATER_SOURCE': str(ROOT / 'src/SiteUpdater.php'),
            'UPDATE_STORAGE': str(self.storage), 'UPDATE_ROOT': str(self.deploy), 'UPDATE_ACTION': action, 'UPDATE_ENABLED': '1' if enabled else '0'}, capture_output=True, text=True, timeout=60)
        return result

    def ok(self, action, enabled=True):
        result = self.call(action, enabled)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_queue_is_opt_in_single_slot_and_private(self):
        self.assertEqual(self.ok('status', False), {'enabled': False, 'maintenance': False, 'status': 'idle'})
        self.assertEqual(self.ok('queue', False)['exception'], 'updates_disabled')
        queued = self.ok('queue')
        self.assertEqual(queued['status'], 'queued')
        self.assertNotIn('actor_id', queued)
        self.assertEqual(self.ok('queue')['exception'], 'update_busy')
        self.assertEqual(self.ok('status')['id'], queued['id'])
        self.assertEqual((self.storage / 'site-update/state.json').stat().st_mode & 0o777, 0o600)
        self.assertEqual((self.storage / 'site-update').stat().st_mode & 0o777, 0o700)

    @unittest.skipIf('php-wasm' in os.environ.get('PHP_BIN', ''), 'WASM PHP_BINARY shim does not execute child PHP; covered by native CI')
    def test_fast_forward_backup_and_new_migration_process(self):
        self.publish()
        self.ok('queue')
        result = self.ok('run')
        self.assertEqual(result['code'], 0, result)
        self.assertEqual(result['state']['status'], 'succeeded')
        self.assertEqual(result['state']['before'], self.before)
        self.assertNotEqual(result['state']['after'], self.before)
        self.assertEqual((self.storage / 'migration-called').read_text(), 'migrate')
        self.assertEqual((self.deploy / 'revision.txt').read_text(), 'new')
        self.assertFalse(result['state']['maintenance'])
        backup = next((self.storage / 'site-update').glob('backup-*.sqlite'))
        db = sqlite3.connect(backup)
        self.assertEqual(db.execute('SELECT value FROM original').fetchone()[0], 'preserve me')
        self.assertIsNone(db.execute("SELECT name FROM sqlite_master WHERE name='migrated'").fetchone())
        db.close()
        db = sqlite3.connect(self.storage / 'forum.sqlite')
        self.assertIsNotNone(db.execute("SELECT name FROM sqlite_master WHERE name='migrated'").fetchone())
        db.close()
        self.assertEqual(self.ok('run')['code'], 0, 'idle workers do nothing')

    def test_dirty_checkout_does_not_pull_or_migrate(self):
        self.publish()
        (self.deploy / 'revision.txt').write_text('local edits')
        self.ok('queue')
        result = self.ok('run')
        self.assertEqual(result['state']['error'], 'dirty_checkout')
        self.assertFalse(result['state']['maintenance'])
        self.assertFalse((self.storage / 'migration-called').exists())
        self.assertEqual(self.git('-C', str(self.deploy), 'rev-parse', 'HEAD').strip(), self.before)

    def test_non_main_branch_is_rejected(self):
        # This is an isolated disposable fixture, not the session repository.
        self.git('-C', str(self.deploy), 'checkout', '-b', 'fixture-other')
        self.ok('queue')
        self.assertEqual(self.ok('run')['state']['error'], 'wrong_branch')
        self.assertFalse((self.storage / 'migration-called').exists())

    def test_pull_failure_never_migrates_and_keeps_maintenance(self):
        self.publish()
        self.git('-C', str(self.deploy), 'config', 'user.email', 'tests@example.invalid')
        self.git('-C', str(self.deploy), 'config', 'user.name', 'Updater fixture')
        (self.deploy / 'local.txt').write_text('local commit')
        self.git('-C', str(self.deploy), 'add', '.')
        self.git('-C', str(self.deploy), 'commit', '-m', 'diverged')
        self.ok('queue')
        state = self.ok('run')['state']
        self.assertEqual(state['error'], 'git_failed')
        self.assertTrue(state['maintenance'])
        self.assertFalse((self.storage / 'migration-called').exists())
        self.assertEqual(self.ok('queue')['exception'], 'update_busy')

    @unittest.skipIf('php-wasm' in os.environ.get('PHP_BIN', ''), 'WASM PHP_BINARY shim does not execute child PHP; covered by native CI')
    def test_migration_failure_keeps_maintenance_without_rollback(self):
        self.publish(failing=True)
        self.ok('queue')
        state = self.ok('run')['state']
        self.assertEqual(state['error'], 'migration_failed')
        self.assertTrue(state['maintenance'])
        self.assertEqual((self.deploy / 'revision.txt').read_text(), 'new')
        self.assertTrue(next((self.storage / 'site-update').glob('backup-*.sqlite')).is_file())

    def test_worker_and_request_locks_are_exclusive(self):
        self.ok('queue')
        with open(self.storage / 'site-update/worker.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(self.ok('run')['exception'], 'update_busy')
        with open(self.storage / 'site-update/requests.lock', 'w') as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            self.assertEqual(self.ok('enter')['exception'], 'update_busy')
        self.assertTrue(self.ok('enter')['entered'])
        self.assertEqual(self.ok('status')['status'], 'queued')

    def test_http_request_lock_and_existing_maintenance(self):
        self.ok('queue')
        (self.storage / 'site-update/maintenance').write_text('older interrupted job')
        result = self.ok('run')
        self.assertEqual(result['state']['error'], 'maintenance')
        self.assertTrue(result['state']['maintenance'])
        self.assertEqual((self.storage / 'site-update/maintenance').read_text(), 'older interrupted job')


if __name__ == '__main__':
    unittest.main()
