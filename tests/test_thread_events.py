"""Exercise the PHP stream loop itself, including session reopening and SQLite changes."""
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]


class ThreadEventLoopTests(unittest.TestCase):
    def test_sqlite_invalidations_session_reopen_and_maintenance(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(shlex.split(os.environ.get('PHP_BIN', 'php')) + ['-r', r'''
                $config = require 'src/bootstrap.php';
                $config['live_enabled'] = true;
                mkdir($config['storage'].'/sessions');
                mkdir($config['storage'].'/site-update');
                ini_set('session.save_path', $config['storage'].'/sessions');
                session_start(); $_SESSION['test_scope'] = 'public';
                $db = \ForBirds\Database::connect($config['storage'].'/loop.sqlite');
                $db->exec("CREATE TABLE sample (body TEXT); INSERT INTO sample VALUES ('initial private body')");
                $writer = \ForBirds\Database::connect($config['storage'].'/loop.sqlite');
                $calls = 0;
                $scope = function (?string $id) use (&$calls, $writer, $config): string {
                    if ($id !== null) {
                        session_id($id);
                        if (!session_start(['read_and_close' => true])) throw new RuntimeException('Session reopen failed');
                    }
                    if (++$calls === 3) $writer->exec("UPDATE sample SET body='new private body'");
                    if ($calls === 5) file_put_contents($config['storage'].'/site-update/maintenance', 'test');
                    return $_SESSION['test_scope'];
                };
                (new \ForBirds\ThreadEvents($db, $config))->run($scope, fn () => [
                    'body' => $db->query('SELECT body FROM sample')->fetchColumn(), 'live_scope' => 'public'
                ]);
            '''], cwd=ROOT, env={**os.environ, 'FORBIRDS_STORAGE': directory}, capture_output=True, text=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
            self.assertEqual(result.stderr, '')
            events = []
            for packet in result.stdout.split('\n\n'):
                lines = packet.splitlines()
                if lines and lines[0].startswith('event: '):
                    events.append((lines[0][7:], json.loads(lines[1][6:])))
            self.assertEqual([name for name, _ in events], ['change', 'change', 'maintenance'], result.stdout)
            self.assertNotEqual(events[0][1]['version'], events[1][1]['version'])
            self.assertEqual(set(events[0][1]), {'scope', 'version'})
            self.assertNotIn('private body', result.stdout)
