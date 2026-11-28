"""Opt-in queue API tests; no worker is ever run against the session checkout."""
import json
import os
import sqlite3
import subprocess
import unittest
import test_api as base


class UpdateApiTests(unittest.TestCase):
    updates_enabled = True
    setUpClass = classmethod(base.ApiTests.setUpClass.__func__)
    cleanup = classmethod(base.ApiTests.cleanup.__func__)
    ok = base.ApiTests.ok

    def setUp(self):
        for name in ['state.json', 'maintenance']:
            (self.storage / 'site-update' / name).unlink(missing_ok=True)
        base.ApiTests.setUp(self)

    def test_enqueue_confirmation_password_single_slot_and_audit(self):
        job = self.ok(self.admin.post('/api/admin/update', {'password': base.PASSWORD, 'confirm': 'UPDATE'}), 202)
        self.assertEqual(job['status'], 'queued')
        self.assertEqual(len(job['id']), 32)
        self.assertNotIn('actor_id', job)
        self.assertNotIn('password', json.dumps(job))
        self.ok(self.admin.post('/api/admin/update', {'password': base.PASSWORD, 'confirm': 'UPDATE'}), 409)
        state = json.loads((self.storage / 'site-update/state.json').read_text())
        self.assertNotIn(base.PASSWORD, json.dumps(state))
        self.assertNotIn('password', state)
        db = sqlite3.connect(self.storage / 'forum.sqlite')
        audit = db.execute("SELECT details FROM audit_log WHERE action='site.update.requested'").fetchone()[0]
        db.close()
        self.assertIn(job['id'], audit)
        self.assertNotIn(base.PASSWORD, audit)
        self.assertEqual(self.ok(self.admin.get('/api/admin/update'))['id'], job['id'])
        self.assertFalse((self.storage / 'site-update/maintenance').exists())

    def test_reject_password_confirmation_and_arbitrary_options(self):
        self.ok(self.admin.post('/api/admin/update', {'password': 'Incorrect-password-123', 'confirm': 'UPDATE'}), 403)
        self.ok(self.admin.post('/api/admin/update', {'password': base.PASSWORD, 'confirm': 'yes'}), 422)
        self.ok(self.admin.post('/api/admin/update', {'password': base.PASSWORD, 'confirm': 'UPDATE', 'command': 'id'}), 422)
        self.ok(self.admin.post('/api/admin/update', {'password': base.PASSWORD, 'confirm': 'UPDATE', 'branch': 'main;id'}), 422)
        self.assertFalse((self.storage / 'site-update/state.json').exists())

    def test_password_attempts_are_rate_limited(self):
        for _ in range(5):
            self.ok(self.admin.post('/api/admin/update', {'password': 'Incorrect-password-123', 'confirm': 'UPDATE'}), 403)
        self.ok(self.admin.post('/api/admin/update', {'password': base.PASSWORD, 'confirm': 'UPDATE'}), 429)

    def test_maintenance_blocks_normal_reads_writes_but_not_status(self):
        directory = self.storage / 'site-update'
        directory.mkdir(exist_ok=True)
        (directory / 'maintenance').write_text('interrupted test job')
        for path in ['/api/threads', '/api/sections', '/api/posts/1', '/api/attachments/1/view']:
            self.ok(self.guest.get(path), 503)
        self.ok(self.admin.post('/api/sections', {'slug': 'no', 'title': 'blocked'}), 503)
        self.ok(self.guest.request('HEAD', '/api/attachments/1/view'), 503)
        response = self.guest.request('GET', '/api/threads', headers={'Accept-Language': 'en'})
        self.assertEqual(self.ok(response, 503)['error']['message'], 'The site is being updated. Try again later.')
        self.ok(self.admin.get('/api/session'))
        self.assertTrue(self.ok(self.admin.get('/api/admin/update'))['maintenance'])
        self.ok(self.normal.get('/api/admin/update'), 403)
        self.ok(self.admin.request('GET', '/api/admin/update', headers={'X-ForBirds-Public-View': '1'}), 401)
        self.ok(self.guest.get('/updates.js'))
        self.ok(self.guest.get('/storage/site-update/state.json'), 503)
        (directory / 'maintenance').unlink()
        self.ok(self.guest.get('/api/threads'))

    def test_network_read_only_still_blocks_update_requests(self):
        db = sqlite3.connect(self.storage / 'forum.sqlite')
        db.execute("INSERT INTO network_ranges VALUES ('tor','127.0.0.1/32',1)")
        db.commit(); db.close()
        self.ok(self.admin.get('/api/admin/update'))
        self.ok(self.admin.post('/api/admin/update', {'password': base.PASSWORD, 'confirm': 'UPDATE'}), 403)
        self.assertFalse((self.storage / 'site-update/state.json').exists())

    @unittest.skipUnless(os.environ.get('FORBIRDS_BROWSER') == '1', 'optional browser test; see README')
    def test_browser_site_updates(self):
        result = subprocess.run(['node', 'tests/test_updates_browser.cjs'], cwd=base.ROOT,
                                env={**os.environ, 'FORBIRDS_TEST_URL': self.base, 'FORBIRDS_TEST_PASSWORD': base.PASSWORD,
                                     'FORBIRDS_TEST_STORAGE': str(self.storage)},
                                text=True, capture_output=True, timeout=100)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
