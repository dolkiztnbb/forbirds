"""Native, concurrent PHP SSE integration. WASM cannot model PHP workers/file locks."""
import json
import os
import queue
import shlex
import subprocess
import threading
import time
import unittest
import test_api as base


class EventReader:
    def __init__(self, client, path):
        self.response = client.opener.open(client.base + path, timeout=8)
        self.events = queue.Queue()
        assert self.response.headers['Content-Type'].startswith('text/event-stream')
        assert self.response.headers['X-Accel-Buffering'] == 'no'
        threading.Thread(target=self.read, daemon=True).start()

    def read(self):
        event, data = None, None
        try:
            for raw in self.response:
                line = raw.decode().rstrip('\r\n')
                if line.startswith('event: '): event = line[7:]
                if line.startswith('data: '): data = json.loads(line[6:])
                if not line and event:
                    self.events.put((event, data)); event, data = None, None
        except (OSError, ValueError):
            pass

    def next(self):
        return self.events.get(timeout=6)


class LiveApiTests(unittest.TestCase):
    live_enabled = True
    cleanup = classmethod(base.ApiTests.cleanup.__func__)
    ok = base.ApiTests.ok
    topic = base.ApiTests.topic
    moderate = base.ApiTests.moderate

    @classmethod
    def setUpClass(cls):
        php = shlex.split(os.environ.get('PHP_BIN', 'php'))
        probe = subprocess.run(php + ['-r', "echo extension_loaded('wasm_memory_storage') ? 'wasm' : 'native';"], capture_output=True, text=True, check=True)
        if probe.stdout == 'wasm' or os.environ.get('FORBIRDS_LIVE_ENABLED') == '0':
            raise unittest.SkipTest('SSE concurrency requires native PHP and live enabled')
        base.ApiTests.setUpClass.__func__(cls)

    def setUp(self):
        # End any previous stream (including a reader that failed mid-test).
        marker = self.storage / 'site-update/maintenance'
        if marker.exists(): marker.unlink()
        base.ApiTests.setUp(self)
        self.readers = []

    def tearDown(self):
        (self.storage / 'site-update/maintenance').write_text('end test streams')
        # Wait for stream leases to close before removing the maintenance marker in setUp.
        time.sleep(.7)
        for reader in self.readers:
            reader.response.close()

    def stream(self, client, topic, public=False):
        reader = EventReader(client, f'/api/threads/{topic["thread_id"]}/events' + ('?public_view=1' if public else ''))
        self.readers.append(reader)
        event, payload = reader.next()
        self.assertEqual(event, 'change')
        self.assertEqual(set(payload), {'version', 'scope'})
        return reader, payload

    def test_publish_hide_and_gone_without_refresh_or_session_lock(self):
        topic = self.topic()
        path = f'/api/threads/{topic["thread_id"]}?live=1'
        reader, initial = self.stream(self.guest, topic)
        self.assertEqual(initial['version'], self.ok(self.guest.get(path))['live_version'])
        start = time.monotonic()
        self.ok(self.guest.get('/api/session'))
        self.assertLess(time.monotonic() - start, 3, 'SSE must release the session lock')
        pending = self.ok(self.normal.post(f'/api/threads/{topic["thread_id"]}/replies', {'body': 'Never broadcast this pending body'}), 201)
        with self.assertRaises(queue.Empty): reader.events.get(timeout=1.2)
        self.moderate(pending['post_id'])
        event, payload = reader.next()
        self.assertEqual(event, 'change')
        self.assertNotIn('body', payload)
        self.assertEqual(payload['version'], self.ok(self.guest.get(path))['live_version'])
        self.ok(self.mod.post(f'/api/posts/{pending["post_id"]}/restrict', {'action': 'hide', 'reason': 'Hide from live viewers'}))
        event, payload = reader.next()
        self.assertEqual(event, 'change')
        self.assertEqual(self.ok(self.guest.get(path))['live_tail'], [])
        self.moderate(topic['post_id'], 'delete')
        self.assertEqual(reader.next()[0], 'gone')

    def test_staff_public_view_and_permission_revocation(self):
        topic = self.topic()
        pending = self.ok(self.normal.post(f'/api/threads/{topic["thread_id"]}/replies', {'body': 'Staff only pending'}), 201)
        public, initial = self.stream(self.mod, topic, public=True)
        guest = self.ok(self.guest.get(f'/api/threads/{topic["thread_id"]}?live=1'))
        self.assertEqual(initial['version'], guest['live_version'])
        staff, _ = self.stream(self.mod, topic)
        self.ok(self.admin.post(f'/api/users/{self.ids["moderator"]}/role', {'role': 'user'}))
        self.assertEqual(staff.next()[0], 'reset')
        # Query downgrade remains public even though the cookie was authenticated.
        with self.assertRaises(queue.Empty): public.events.get(timeout=.8)
        self.ok(self.admin.post(f'/api/posts/{pending["post_id"]}/moderate', {'action': 'approve'}))
        self.assertEqual(public.next()[0], 'change')

    def test_stream_slot_limit_maintenance_and_updater_gate(self):
        topic = self.topic()
        first, _ = self.stream(self.guest, topic)
        self.stream(self.normal, topic)
        response = self.admin.opener.open(self.base + f'/api/threads/{topic["thread_id"]}/events', timeout=4)
        self.assertEqual(response.status, 204)
        response.close()
        # Long-lived SSE must not retain the updater's shared request lock.
        result = subprocess.run(self.php + ['-r', "$f=fopen(getenv('FORBIRDS_STORAGE').'/site-update/requests.lock','c'); echo flock($f, LOCK_EX|LOCK_NB) ? 'free' : 'busy';"],
                                cwd=base.ROOT, env=self.env, capture_output=True, text=True, timeout=5)
        self.assertEqual(result.stdout, 'free', result.stderr)
        (self.storage / 'site-update/maintenance').write_text('test update')
        self.assertEqual(first.next()[0], 'maintenance')
