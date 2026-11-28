"""HTTP integration tests against a real PHP server and an isolated SQLite database.

Run: python3 -m unittest discover -s tests -v
Override the PHP executable with PHP_BIN (shell-style command, no shell is invoked).
"""
import http.cookiejar
import hashlib
import concurrent.futures
import re
import struct
import zlib
import json
import os
from pathlib import Path
import shlex
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import urllib.parse
import uuid

ROOT = Path(__file__).resolve().parents[1]
PASSWORD = "ForBirds-test-password-123!"


def flash_fixture(compressed=False, actions=False):
    # Tiny self-contained AVM1 movie: 320x240, red stage, one frame.
    bits = '01110' + ''.join(format(value & 16383, '014b') for value in [0, 6400, 0, 4800])
    bits += '0' * ((-len(bits)) % 8)
    rect = int(bits, 2).to_bytes(len(bits) // 8, 'big')
    def tag(code, data):
        return struct.pack('<H', code << 6 | (len(data) if len(data) < 63 else 63)) + (struct.pack('<I', len(data)) if len(data) >= 63 else b'') + data
    body = rect + struct.pack('<HH', 12 << 8, 1) + tag(9, b'\xff\x00\x00')
    if actions:
        script = b''
        for url, target in [(b'javascript:parent.FLASH_ESCAPED=true', b'_self'),
                            (b'https://example.org/flash-must-not-load', b'_blank'),
                            (b'https://example.org/flash-must-not-load.swf', b'_level1')]:
            payload = url + b'\0' + target + b'\0'
            script += b'\x83' + struct.pack('<H', len(payload)) + payload
        body += tag(12, script + b'\0')
    body += tag(1, b'') + tag(0, b'')
    return (b'CWS' if compressed else b'FWS') + b'\x08' + struct.pack('<I', len(body) + 8) + (zlib.compress(body) if compressed else body)


class Client:
    def __init__(self, base):
        self.base = base
        self.auto_pow = True
        self.opener = urllib.request.build_opener(
            urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
        )
        self.csrf = self.get('/api/session')[1]['csrf_token']

    def request(self, method, path, data=None, headers=None, raw=None):
        headers = dict(headers or {})
        if method == 'POST':
            headers.setdefault('X-CSRF-Token', self.csrf)
        if raw is None and data is not None:
            raw = json.dumps(data).encode()
            headers.setdefault('Content-Type', 'application/json')
        request = urllib.request.Request(self.base + path, data=raw, headers=headers, method=method)
        try:
            response = self.opener.open(request, timeout=10)
        except urllib.error.HTTPError as error:
            response = error
        payload = response.read()
        try:
            decoded = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            decoded = payload
        if isinstance(decoded, dict) and 'data' in decoded:
            decoded = decoded['data']
            if isinstance(decoded, dict) and 'csrf_token' in decoded:
                self.csrf = decoded['csrf_token']
        return response.status, decoded, response.headers

    def get(self, path):
        return self.request('GET', path)

    @staticmethod
    def posting(path):
        return path == '/api/threads' or re.fullmatch(r'/api/threads/[1-9][0-9]*/replies', path)

    def proof(self, advance=False):
        # Ordinary feature tests advance the DB clock between posts; protection tests never do this implicitly.
        if advance:
            with sqlite3.connect(self.fixture_storage / 'forum.sqlite') as db:
                db.execute('UPDATE posting_limits SET last_post_at = 0')
            db.close()
        status, challenge, _ = self.post('/api/pow/challenge', {})
        assert status == 200, challenge
        nonce = 0
        while int.from_bytes(hashlib.sha256((challenge['prefix'] + ':' + str(nonce)).encode()).digest(), 'big') >> (256 - challenge['difficulty']):
            nonce += 1
        return {'pow_id': challenge['id'], 'pow_nonce': str(nonce)}

    def post(self, path, data):
        if self.auto_pow and self.posting(path):
            data = {**data, **self.proof(advance=True)}
        return self.request('POST', path, data=data)

    def upload(self, path, fields, files, file_field="files[]"):
        if self.auto_pow and self.posting(path):
            fields = {**fields, **self.proof(advance=True)}
        boundary = 'ForBirds' + uuid.uuid4().hex
        parts = []
        for name, value in fields.items():
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
        for name, content in files:
            parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{file_field}"; filename="{name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode() + content + b'\r\n')
        parts.append(f'--{boundary}--\r\n'.encode())
        return self.request('POST', path, raw=b''.join(parts), headers={
            'Content-Type': 'multipart/form-data; boundary=' + boundary,
        })


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='forbirds-tests-')
        cls.storage = Path(cls.temp.name)
        Client.fixture_storage = cls.storage
        cls.env = {**os.environ, 'FORBIRDS_STORAGE': str(cls.storage), 'FORBIRDS_SECURE_COOKIE': '0', 'FORBIRDS_POW_DIFFICULTY': '8'}
        cls.php = shlex.split(os.environ.get('PHP_BIN', 'php'))
        for args, stdin in [(['install'], None), (['migrate'], None),
                            (['create-admin', 'admin'], PASSWORD + '\n')]:
            result = subprocess.run(cls.php + ['bin/console.php'] + args, cwd=ROOT, env=cls.env,
                                    input=stdin, text=True, capture_output=True, timeout=30)
            if result.returncode:
                raise RuntimeError(result.stdout + result.stderr)
        cls.fixtures = cls.storage / 'fixtures'
        cls.fixtures.mkdir()
        fixture_code = r'''$dir = getenv('FORBIRDS_STORAGE') . '/fixtures/';
            $im = imagecreatetruecolor(512,128);
            imagefill($im,0,0,imagecolorallocate($im,80,150,220));
            imagepng($im,$dir.'wide.png'); imagejpeg($im,$dir.'wide.jpg');
            imagegif($im,$dir.'wide.gif'); imagewebp($im,$dir.'wide.webp');
            $im = imagecreatetruecolor(80,640); imagepng($im,$dir.'portrait.png');
            $im = imagecreatetruecolor(32,16); imagepng($im,$dir.'small.png');
            $im = imagecreatetruecolor(128,128);
            for ($y=0;$y<128;$y++) for ($x=0;$x<128;$x++) {
                imagesetpixel($im,$x,$y,imagecolorallocate($im,($x*19+$y*3)%256,($x*5+$y*13)%256,($x*$y)%256));
            }
            imagepng($im,$dir.'pattern.png');
            imagesetpixel($im,50,60,imagecolorallocate($im,255,255,255));
            imagepng($im,$dir.'pixel.png');
            $im = imagecreatetruecolor(128,128);
            for ($y=0;$y<128;$y++) for ($x=0;$x<128;$x++) {
                imagesetpixel($im,$x,$y,imagecolorallocate($im,($x*7)%256,($y*5)%256,($x+$y)%256));
            }
            imagepng($im,$dir.'other.png');'''
        result = subprocess.run(cls.php + ['-r', fixture_code], cwd=ROOT, env=cls.env,
                                text=True, capture_output=True, timeout=30)
        if result.returncode:
            raise RuntimeError(result.stdout + result.stderr)
        gif = (cls.fixtures / 'wide.gif').read_bytes()
        table_end = 13 + (3 * (2 ** ((gif[10] & 7) + 1)) if gif[10] & 128 else 0)
        frame = gif[table_end:-1]
        delay = b'\x21\xf9\x04\x00\x0a\x00\x00\x00'
        animation = b'GIF89a' + gif[6:table_end] + b'\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00' + delay + frame + delay + frame + b'\x3b'
        (cls.fixtures / 'animated.gif').write_bytes(animation)
        for filename in [p.name for p in (ROOT / 'tests/fixtures').glob('sample.*')]:
            (cls.fixtures / filename).write_bytes((ROOT / 'tests' / 'fixtures' / filename).read_bytes())
        with socket.socket() as sock:
            sock.bind(('0.0.0.0', 0))
            cls.port = sock.getsockname()[1]
        cls.base = f'http://127.0.0.1:{cls.port}'
        cls.log = open(cls.storage / 'server.log', 'w+')
        cls.server = subprocess.Popen(cls.php + [
            '-d', 'memory_limit=128M', '-d', 'upload_max_filesize=5M', '-d', 'post_max_size=21M',
            '-d', 'max_file_uploads=20', '-S', f'0.0.0.0:{cls.port}',
            '-t', 'public', 'public/router.php',
        ], cwd=ROOT, env=cls.env, stdout=cls.log, stderr=cls.log, start_new_session=True)
        cls.addClassCleanup(cls.cleanup)
        deadline = time.monotonic() + 20
        while True:
            try:
                cls.admin = Client(cls.base)
                break
            except (OSError, KeyError):
                if cls.server.poll() is not None or time.monotonic() > deadline:
                    cls.log.seek(0)
                    raise RuntimeError(cls.log.read())
                time.sleep(.1)
        status, data, _ = cls.admin.post('/api/auth/login', {'username': 'admin', 'password': PASSWORD})
        assert status == 200, data
        cls.clients = {}
        cls.ids = {}
        for username in ['normal', 'moderator', 'trusted']:
            client = Client(cls.base)
            status, data, _ = client.post('/api/auth/register', {
                'username': username, 'password': PASSWORD, 'role': 'admin', 'auto_approve': True,
            })
            assert status == 201, data
            assert data['user']['role'] == 'user' and data['user']['auto_approve'] == 0
            cls.clients[username] = client
            cls.ids[username] = data['user']['id']
        cls.guest = Client(cls.base)

    @classmethod
    def cleanup(cls):
        import signal
        if cls.server.poll() is None:
            os.killpg(cls.server.pid, signal.SIGTERM)
            try:
                cls.server.wait(timeout=10)
            except subprocess.TimeoutExpired:
                os.killpg(cls.server.pid, signal.SIGKILL)
                cls.server.wait()
        if os.environ.get("FORBIRDS_TEST_DEBUG"):
            cls.log.seek(0)
            print(cls.log.read()[-12000:])
        cls.log.close()
        cls.temp.cleanup()

    def setUp(self):
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            for table in ['falseflag_posts', 'post_reactions', 'network_ranges', 'network_write_bans', 'network_ban_events', 'description_bans', 'privacy_access', 'identity_bans', 'media_bans', 'attachments', 'posts', 'threads', 'sections', 'audit_log', 'rate_limits', 'posting_limits', 'pow_challenges']:
                db.execute(f'DELETE FROM {table}')
            db.execute("UPDATE users SET description = '', avatar_name = NULL, flag_file = NULL, avatar_locked = 0, description_locked = 0")
            db.execute("UPDATE users SET role = 'user', auto_approve = 0, is_banned = 0 WHERE role != 'admin'")
            db.execute("UPDATE users SET role = 'moderator' WHERE username = 'moderator'")
        db.close()
        for client in [self.admin, self.guest, *self.clients.values()]:
            client.auto_pow = True
        self.normal = self.clients['normal']
        self.mod = self.clients['moderator']
        self.trusted = self.clients['trusted']
        self.section = self.ok(self.admin.post('/api/sections', {
            'slug': 'general', 'title': 'Общий раздел',
        }), 201)['id']

    def ok(self, response, expected=200):
        self.assertEqual(response[0], expected, response[1])
        return response[1]

    def topic(self, client=None, **kwargs):
        return self.ok((client or self.admin).post('/api/threads', {
            'section_id': self.section, 'title': 'Тестовая тема', 'body': 'Начальное сообщение', **kwargs,
        }), 201)

    def moderate(self, post_id, action='approve'):
        return self.ok(self.mod.post(f'/api/posts/{post_id}/moderate', {'action': action}))

    def trust(self, enabled):
        return self.ok(self.mod.post(f'/api/users/{self.ids["trusted"]}/trust', {'enabled': enabled}))

    def reaction_images(self):
        directory = ROOT / 'public/static/reactions'
        names = ['testreaction-' + uuid.uuid4().hex + '.png' for _ in range(2)]
        for name in names:
            path = directory / name
            path.write_bytes((self.fixtures / 'small.png').read_bytes())
            self.addCleanup(lambda p=path: p.unlink(missing_ok=True))
        return names

    def network_range(self, enabled=True, source='tor'):
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('DELETE FROM network_ranges')
            if enabled:
                db.execute('INSERT INTO network_ranges VALUES (?,?,?)', [source, '127.0.0.1/32', int(time.time())])
        db.close()

    def test_network_read_only_covers_all_posts_and_preserves_reads(self):
        root = self.topic()
        self.network_range()
        self.assertTrue(self.ok(self.guest.get('/api/session'))['read_only'])
        self.ok(self.guest.get('/api/threads'))
        self.ok(self.guest.get(f'/api/posts/{root["post_id"]}'))
        self.ok(self.guest.get('/app.js'))
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM network_write_bans').fetchone()[0], 0)
        db.close()
        self.ok(self.guest.request('POST', '/api/pow/challenge', data={}, headers={'X-CSRF-Token': 'wrong'}), 403)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM network_write_bans').fetchone()[0], 0)
        db.close()
        self.normal.auto_pow = False
        for path, data in [('/api/auth/register', {'username': 'toruser', 'password': PASSWORD}),
                           ('/api/auth/login', {'username': 'normal', 'password': PASSWORD}),
                           ('/api/auth/logout', {}), ('/api/pow/challenge', {}),
                           ('/api/threads', {}), (f'/api/threads/{root["thread_id"]}/replies', {'body': 'denied'}),
                           ('/api/me/profile', {'description': 'denied'}),
                           (f'/api/posts/{root["post_id"]}/reactions', {'reaction': ''}),
                           ('/api/sections', {}), (f'/api/posts/{root["post_id"]}/moderate', {'action': 'delete'})]:
            response = self.normal.post(path, data)
            self.ok(response, 403)
            self.assertEqual(response[1]['error']['code'], 'network_read_only')
        # No role bypass: a staff member can read, but cannot write via Tor either.
        self.ok(self.mod.post('/api/pow/challenge', {}), 403)
        self.ok(self.admin.post('/api/pow/challenge', {}), 403)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM network_write_bans').fetchone()[0], 6)
            self.assertEqual(db.execute('SELECT count(*) FROM network_ban_events').fetchone()[0], 6)
            self.assertEqual(db.execute('SELECT count(*) FROM posts').fetchone()[0], 1)
        db.close()

    def test_network_bans_persist_unban_privacy_and_no_spoofing(self):
        fake = {'X-Forwarded-For': '198.51.100.8', 'X-ForBirds-Access-Network': 'i2p',
                'ForBirds-Access-Network': 'tor', 'X-Tor': 'true', 'X-I2P-DestHash': 'fake', 'User-Agent': 'Tor Browser'}
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('INSERT INTO network_ranges VALUES (?,?,?)', ['tor', '198.51.100.8/32', int(time.time())])
        db.close()
        self.ok(self.guest.request('POST', '/api/pow/challenge', data={}, headers=fake))
        self.network_range(source='i2p')
        self.ok(self.normal.post('/api/pow/challenge', {}), 403)
        self.network_range(False)
        self.ok(self.normal.post('/api/pow/challenge', {}), 403)  # cookie AND account survive exit change
        fresh = Client(self.base)
        self.ok(fresh.post('/api/pow/challenge', {}))
        self.ok(fresh.post('/api/auth/login', {'username': 'normal', 'password': 'Incorrect-password-123'}), 401)
        self.ok(fresh.post('/api/auth/login', {'username': 'normal', 'password': PASSWORD}), 403)
        for client in [self.normal, self.mod, self.admin]:
            self.ok(client.get('/api/moderation/network-bans'), 403)
        self.ok(self.admin.post('/api/moderation/privacy', {'enabled': True}))
        bans = self.ok(self.admin.get('/api/moderation/network-bans'))['items']
        self.assertEqual({b['kind'] for b in bans}, {'user', 'browser'})
        self.assertTrue(all(b['source'] == 'i2p' for b in bans))
        for ban in bans:
            self.ok(self.admin.post(f'/api/moderation/network-bans/{ban["id"]}/remove', {'reason': ''}), 422)
            self.ok(self.mod.post(f'/api/moderation/network-bans/{ban["id"]}/remove', {'reason': 'no access'}), 403)
            self.ok(self.admin.post(f'/api/moderation/network-bans/{ban["id"]}/remove', {'reason': 'Appeal accepted'}))
        events = self.ok(self.admin.get('/api/moderation/network-ban-events'))['items']
        self.assertEqual([e['action'] for e in events], ['remove', 'remove', 'add', 'add'])
        self.ok(self.normal.post('/api/pow/challenge', {}))
        self.ok(fresh.post('/api/auth/login', {'username': 'normal', 'password': PASSWORD}))
        self.assertFalse(self.ok(self.normal.get('/api/session'))['read_only'])

    def test_network_cli_import_status_and_recovery(self):
        path = self.storage / 'cli-tor.txt'
        path.write_text('198.51.100.5\n2001:db8::5\n')
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            ban_id = db.execute("INSERT INTO network_write_bans(kind,value,source,reason,created_at) VALUES ('browser',?,'tor','test',?)", ['b' * 64, int(time.time())]).lastrowid
        db.close()
        target = self.offline_cli('import-network-list', 'tor', str(path))
        env = {**self.env, 'FORBIRDS_STORAGE': str(target)}
        for command in [['network-status'], ['remove-network-ban', str(ban_id), 'CLI recovery']]:
            result = subprocess.run(self.php + ['bin/console.php', *command], cwd=ROOT, env=env, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            if command[0] == 'network-status': self.assertIn('tor: 2 entries', result.stdout)
        with sqlite3.connect(target / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM network_write_bans').fetchone()[0], 0)
            self.assertEqual(db.execute("SELECT count(*) FROM network_ban_events WHERE action='remove' AND actor_id IS NULL").fetchone()[0], 1)
        db.close()

    def test_network_import_validation_and_trusted_server_marker(self):
        good = self.storage / 'tor-list.txt'
        good.write_text('# Test list\n198.51.100.8\n2001:db8::1\n198.51.100.8\n')
        invalid = self.storage / 'bad-list.txt'
        invalid.write_text('198.51.100.9\n<html>bad upstream</html>\n')
        empty = self.storage / 'empty-list.txt'
        empty.write_text('# empty\n')
        code = r'''
            $config = require 'src/bootstrap.php';
            $db = ForBirds\Database::connect(':memory:'); ForBirds\Database::migrate($db);
            $root = $config['storage'];
            assert(ForBirds\NetworkAccess::import($db,'tor',$root.'/tor-list.txt') === 2);
            foreach (['bad-list.txt','empty-list.txt'] as $file) {
                try { ForBirds\NetworkAccess::import($db,'tor',$root.'/'.$file); throw new Exception('Unexpected success'); }
                catch (RuntimeException $e) {}
                assert($db->query('SELECT count(*) FROM network_ranges')->fetchColumn() == 2);
            }
            $_SERVER['REMOTE_ADDR'] = '2001:db8::1';
            $identity = new ForBirds\AbuseIdentity($db,$config);
            assert((new ForBirds\NetworkAccess($db,$identity,null))->readOnly());
            $_SERVER['REMOTE_ADDR'] = '192.0.2.50';
            $_SERVER['HTTP_FORBIRDS_ACCESS_NETWORK'] = 'i2p';
            $identity = new ForBirds\AbuseIdentity($db,$config);
            assert(!(new ForBirds\NetworkAccess($db,$identity,null))->readOnly());
            $_SERVER['FORBIRDS_ACCESS_NETWORK'] = 'i2p';
            $access = new ForBirds\NetworkAccess($db,$identity,null);
            assert($access->readOnly());
            try { $access->assertWritable(); throw new Exception('Unexpected success'); }
            catch (ForBirds\ApiError $e) { assert($e->errorCode === 'network_read_only'); }
            $id = $db->query('SELECT id FROM network_write_bans')->fetchColumn();
            assert(ForBirds\NetworkAccess::removeBan($db,(int)$id,'CLI recovery',null));
            assert($db->query("SELECT count(*) FROM network_ban_events WHERE action='remove'")->fetchColumn() == 1);
            file_put_contents($root.'/cidrs.txt',"192.0.2.0/24\n2001:db8::/32\n");
            assert(ForBirds\NetworkAccess::import($db,'i2p',$root.'/cidrs.txt') === 2);
            unset($_SERVER['FORBIRDS_ACCESS_NETWORK']);
            assert((new ForBirds\NetworkAccess($db,$identity,null))->readOnly());
            echo 'network unit OK';
        '''
        result = subprocess.run(self.php + ['-d', 'zend.assertions=1', '-d', 'assert.exception=1', '-r', code],
                                cwd=ROOT, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('network unit OK', result.stdout)

    def test_reactions_catalog_rejects_unsafe_files(self):
        directory = self.storage / 'reactions-catalog'
        directory.mkdir()
        for name in ['good.png', 'UPPER.PNG', 'fake.png', 'bad.svg', 'space name.png']:
            (directory / name).write_bytes(b'<svg>not an image</svg>' if name in ['bad.svg', 'fake.png'] else (self.fixtures / 'small.png').read_bytes())
        (directory / 'linked.png').symlink_to(self.fixtures / 'small.png')
        (directory / 'huge.png').write_bytes((self.fixtures / 'portrait.png').read_bytes())
        (directory / 'reactions.json').write_text('{"good":"<script>label</script>"}')
        code = "require 'src/bootstrap.php'; echo json_encode(array_values((new ForBirds\\ReactionCatalog(getenv('REACTION_TEST_DIR')))->all()));"
        result = subprocess.run(self.php + ['-r', code], cwd=ROOT, env={**self.env, 'REACTION_TEST_DIR': str(directory)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        catalog = {r['file']: r for r in json.loads(result.stdout)}
        self.assertEqual(set(catalog), {'good.png', 'UPPER.PNG'})
        self.assertEqual(catalog['good.png']['label'], '<script>label</script>')
        self.ok(self.guest.get('/static/reactions/README.md'), 404)
        self.ok(self.guest.get('/static/reactions/reactions.json'), 404)

    def test_reactions_catalog_voting_counts_and_permissions(self):
        first, second = self.reaction_images()
        root = self.topic()
        pid = root['post_id']
        path = f'/api/posts/{pid}/reactions'
        items = {r['file']: r for r in self.ok(self.guest.get('/api/reactions'))}
        self.ok(self.guest.get(items[first]['url']))
        self.ok(self.guest.post(path, {'reaction': first}), 401)
        self.ok(self.normal.request('POST', path, data={'reaction': first}, headers={'X-CSRF-Token': 'bad'}), 403)
        self.ok(self.normal.post(path, {'reaction': '../bad.png'}), 422)
        for _ in range(2):
            summary = self.ok(self.normal.post(path, {'reaction': first}))
            self.assertEqual(next(r for r in summary if r['file'] == first)['count'], 1)
        self.ok(self.trusted.post(path, {'reaction': first}))
        self.assertEqual(next(r for r in self.ok(self.guest.get(path)) if r['file'] == first)['count'], 2)
        self.ok(self.normal.post(path, {'reaction': second}))
        summary = {r['file']: r for r in self.ok(self.normal.get(path))}
        self.assertEqual(summary[first]['count'], 1)
        self.assertTrue(summary[second]['selected'])
        self.assertTrue(all(not r['selected'] for r in self.ok(self.guest.get(path))))
        self.ok(self.normal.post(path, {'reaction': ''}))
        (ROOT / 'public/static/reactions' / first).unlink()
        self.assertNotIn(first, [r['file'] for r in self.ok(self.guest.get(path))])
        self.ok(self.trusted.post(path, {'reaction': ''}))
        self.ok(self.admin.post(f'/api/users/{self.ids["normal"]}/ban', {'enabled': True}))
        self.ok(self.normal.post(path, {'reaction': second}), 403)

    def test_reactions_visibility_locked_network_and_rate_limit(self):
        first, _ = self.reaction_images()
        root = self.topic(self.normal)
        pid = root['post_id']; path = f'/api/posts/{pid}/reactions'
        self.ok(self.guest.get(path), 404)
        self.ok(self.normal.post(path, {'reaction': first}), 409)
        self.moderate(pid)
        self.network_range()
        self.ok(self.normal.post(path, {'reaction': first}), 403)
        self.network_range(False)
        # Other browsers/accounts still work after leaving the exit network.
        self.ok(self.trusted.post(path, {'reaction': first}))
        self.ok(self.mod.post(f'/api/posts/{pid}/restrict', {'action': 'hide', 'reason': 'test'}))
        self.ok(self.guest.get(path), 404)
        self.ok(self.trusted.post(path, {'reaction': first}), 404)
        self.ok(self.mod.post(f'/api/posts/{pid}/restrict', {'action': 'unhide', 'reason': 'test'}))
        self.ok(self.mod.post(f'/api/threads/{root["thread_id"]}/settings', {'is_locked': True}))
        self.ok(self.trusted.post(path, {'reaction': first}), 409)
        self.ok(self.mod.post(f'/api/threads/{root["thread_id"]}/settings', {'is_locked': False}))
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('DELETE FROM rate_limits')
        db.close()
        for _ in range(30): self.ok(self.trusted.post(path, {'reaction': first}))
        self.ok(self.trusted.post(path, {'reaction': first}), 429)

    def test_falseflag_permissions_validation_and_csrf(self):
        fields = {'section_id': self.section, 'title': 'Attribution', 'body': '**markdown**',
                  'post_as_user_id': self.ids['normal'], 'falseflag_reason': 'Private attribution reason'}
        for client in [self.guest, self.normal, self.mod]:
            self.ok(client.post('/api/threads', fields), 401 if client is self.guest else 403)
        self.ok(self.admin.request('POST', '/api/threads', data=fields, headers={'X-CSRF-Token': 'bad'}), 403)
        self.ok(self.admin.post('/api/threads', {**fields, 'falseflag_reason': ''}), 422)
        self.ok(self.admin.post('/api/threads', {**fields, 'post_as_user_id': '1 OR 1=1'}), 422)
        self.ok(self.admin.post('/api/threads', {**fields, 'post_as_user_id': 999999999}), 404)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM posts').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM falseflag_posts').fetchone()[0], 0)
        db.close()

    def test_falseflag_root_reply_attribution_and_private_log(self):
        self.ok(self.normal.upload('/api/me/profile', {'description': '', 'flag_file': 'ru.gif'},
                                   [('avatar.png', (self.fixtures / 'wide.png').read_bytes())], file_field='avatar'))
        fields = {'section_id': self.section, 'title': 'Private attribution', 'body': '**bold**\n> quote',
                  'post_as_user_id': self.ids['normal'], 'falseflag_reason': 'secret-attribution-note'}
        root = self.ok(self.admin.post('/api/threads', fields), 201)
        reply = self.ok(self.admin.post(f'/api/threads/{root["thread_id"]}/replies', {
            'body': 'Reply *italic*', 'post_as_user_id': self.ids['normal'], 'falseflag_reason': 'private-reply-note', 'sage': True}), 201)
        self.assertEqual(root['status'], 'approved')
        post = self.ok(self.guest.get(f'/api/posts/{root["post_id"]}'))
        self.assertEqual(post['user_id'], self.ids['normal'])
        self.assertEqual(post['username'], 'normal')
        self.assertEqual(post['author_role'], 'user')
        self.assertEqual(post['body'], fields['body'])  # raw Markdown stays in storage/API
        self.assertEqual(post['flag']['file'], 'ru.gif')
        self.assertIn(f'/api/users/{self.ids["normal"]}/avatar', post['avatar_url'])
        self.assertEqual(self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'))['user_id'], self.ids['normal'])
        self.assertIn(root['post_id'], [p['id'] for p in self.ok(self.normal.get('/api/me/posts'))['items']])
        log = self.ok(self.admin.get('/api/admin/falseflags'))['items']
        self.assertEqual(len(log), 2)
        self.assertEqual(log[0]['reason'], 'private-reply-note')
        self.assertEqual(log[0]['target_user_id'], self.ids['normal'])
        self.assertEqual(log[0]['actor_name'], 'admin')
        for client in [self.guest, self.normal, self.mod]: self.ok(client.get('/api/admin/falseflags'), 401 if client is self.guest else 403)
        for client in [self.guest, self.normal, self.mod]:
            for path in [f'/api/posts/{root["post_id"]}', f'/api/threads/{root["thread_id"]}', '/api/threads', '/api/sections', f'/api/users/{self.ids["normal"]}/posts']:
                encoded = json.dumps(self.ok(client.get(path)))
                for private in ['secret-attribution-note', 'private-reply-note', 'actor_name', 'target_user_id', 'falseflag', 'admin']:
                    self.assertNotIn(private, encoded)
        self.assertNotIn('secret-attribution-note', json.dumps(self.ok(self.mod.get('/api/moderation/audit'))))
        self.ok(self.admin.post(f'/api/posts/{root["post_id"]}/moderate', {'action': 'delete'}))
        self.assertEqual(len(self.ok(self.admin.get('/api/admin/falseflags'))['items']), 2)

    def test_falseflag_uses_actor_proof_cooldown_and_network_restrictions(self):
        fields = {'section_id': self.section, 'title': 'Actor proof', 'body': 'Attribution',
                  'post_as_user_id': self.ids['normal'], 'falseflag_reason': 'proof-test'}
        self.admin.auto_pow = False
        self.ok(self.admin.post('/api/threads', fields), 422)
        data = {**fields, **self.admin.proof(advance=True)}
        root = self.ok(self.admin.post('/api/threads', data), 201)
        cooldown = self.ok(self.admin.get('/api/posting-status'))
        self.assertGreater(cooldown['retry_after'], 0)
        self.assertEqual(self.ok(self.normal.get('/api/posting-status'))['retry_after'], 0)
        self.ok(self.admin.post('/api/threads', {**data, 'post_as_user_id': self.ids['trusted']}), 429)
        self.admin.auto_pow = False
        self.network_range()
        self.ok(self.admin.post('/api/threads', fields), 403)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM falseflag_posts').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT user_id FROM posts WHERE id=?', [root['post_id']]).fetchone()[0], self.ids['normal'])
        db.close()

    def test_falseflag_upload_failure_rolls_back_private_record_and_proof(self):
        fields = {'section_id': self.section, 'title': 'Rollback attribution', 'body': 'bad image',
                  'post_as_user_id': self.ids['normal'], 'falseflag_reason': 'rollback-private-note'}
        self.ok(self.admin.upload('/api/threads', fields, [('bad.png', self.png_header(16, 16))]), 422)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM falseflag_posts').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM posts').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM threads').fetchone()[0], 0)
        db.close()
        self.assertEqual(self.ok(self.admin.get('/api/posting-status'))['retry_after'], 0)

    def test_presentation_public_reads_hide_private_content_without_changing_session(self):
        root = self.topic(title='Public presentation topic')
        pending = self.ok(self.normal.upload('/api/threads', {
            'section_id': self.section, 'title': 'presentation-private-root', 'body': 'private-body-presentation',
        }, [('private.txt', b'private-file-presentation')]), 201)
        reply = self.ok(self.normal.post(f'/api/threads/{root["thread_id"]}/replies', {'body': 'presentation-private-reply'}), 201)
        file = self.ok(self.admin.get(f'/api/posts/{pending["post_id"]}'))['attachments'][0]
        header = {'X-ForBirds-Public-View': '1'}
        for path in ['/api/threads', '/api/sections', f'/api/threads/{root["thread_id"]}', f'/api/users/{self.ids["normal"]}/posts']:
            ordinary = self.ok(self.guest.get(path))
            public = self.ok(self.admin.request('GET', path, headers=header))
            self.assertEqual(public, ordinary)
            self.assertNotIn('presentation-private', json.dumps(public))
        for path in [f'/api/posts/{pending["post_id"]}', f'/api/posts/{reply["post_id"]}', file['download_url']]:
            self.ok(self.admin.request('GET', path, headers=header), 404)
            self.ok(self.admin.get(path))
        self.ok(self.admin.request('HEAD', file['download_url'], headers=header), 404)
        for path in ['/api/moderation/queue', '/api/admin/falseflags', '/api/me/posts']:
            self.ok(self.admin.request('GET', path, headers=header), 401)
        session = self.ok(self.admin.request('GET', '/api/session', headers=header))
        self.assertEqual(session['user']['role'], 'admin')
        self.assertEqual(self.ok(self.admin.get('/api/session'))['user']['id'], session['user']['id'])

    def test_presentation_header_does_not_grant_or_revoke_write_permissions(self):
        header = {'X-ForBirds-Public-View': '1'}
        fields = {'slug': 'public-view-write', 'title': 'Real permissions'}
        self.ok(self.normal.request('POST', '/api/sections', data=fields, headers=header), 403)
        self.ok(self.admin.request('POST', '/api/sections', data=fields, headers=header), 201)
        root = self.topic(self.normal)
        self.ok(self.normal.request('GET', f'/api/posts/{root["post_id"]}', headers=header), 404)
        self.ok(self.normal.get(f'/api/posts/{root["post_id"]}'))

    def test_profile_migration_preserves_existing_database(self):
        legacy = self.storage / 'legacy-profile-test.sqlite'
        with sqlite3.connect(legacy) as db:
            db.execute('CREATE TABLE migrations(name TEXT PRIMARY KEY)')
            for name in ['001_initial.sql', '002_posting_protection.sql']:
                db.executescript((ROOT / 'database' / 'migrations' / name).read_text())
                db.execute('INSERT INTO migrations(name) VALUES (?)', (name,))
            db.execute("INSERT INTO users(username,password_hash,role,auto_approve) VALUES ('old_user','unchanged-hash','moderator',1)")
            db.execute("INSERT INTO sections(slug,title) VALUES ('old','Old section')")
            db.execute("INSERT INTO threads(section_id,title) VALUES (1,'Old topic')")
            db.execute("INSERT INTO posts(thread_id,user_id,is_root,body,status) VALUES (1,1,1,'Old post','approved')")
        db.close()
        result = subprocess.run(self.php + ['-r',
            "require 'src/bootstrap.php'; $db = \\ForBirds\\Database::connect(getenv('FORBIRDS_LEGACY_TEST_DB')); "
            "\\ForBirds\\Database::migrate($db); \\ForBirds\\Database::migrate($db);"],
            cwd=ROOT, env={**self.env, 'FORBIRDS_LEGACY_TEST_DB': str(legacy)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        with sqlite3.connect(legacy) as db:
            row = db.execute('SELECT username,password_hash,role,auto_approve,description,avatar_name,flag_file FROM users').fetchone()
            self.assertEqual(row, ('old_user', 'unchanged-hash', 'moderator', 1, '', None, None))
            self.assertEqual(db.execute('SELECT body FROM posts').fetchone()[0], 'Old post')
            self.assertEqual(db.execute('SELECT count(*) FROM migrations').fetchone()[0], len(list((ROOT / 'database/migrations').glob('*.sql'))))
        db.close()

    def test_flag_catalog_dictionary_fallback_and_safe_autodiscovery(self):
        directory = self.storage / 'flag-catalog-test'
        directory.mkdir()
        image = (self.fixtures / 'wide.png').read_bytes()
        for name in ['RU.PNG', 'Untranslated.png', 'invalid-label.gif', 'fake.png', 'bad.svg', '.hidden.png']:
            (directory / name).write_bytes(b'not an image' if name == 'fake.png' else image)
        (directory / 'nested').mkdir()
        (directory / 'nested' / 'hidden.png').write_bytes(image)
        (directory / 'symlink.png').symlink_to(self.fixtures / 'wide.png')
        def catalog():
            result = subprocess.run(self.php + ['-r',
                "require 'src/bootstrap.php'; echo json_encode(array_values((new \\ForBirds\\FlagCatalog(getenv('FORBIRDS_FLAG_TEST_DIR')))->all()));"],
                cwd=ROOT, env={**self.env, 'FORBIRDS_FLAG_TEST_DIR': str(directory)}, capture_output=True, text=True, timeout=30)
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            return {f['file']: f for f in json.loads(result.stdout)}
        flags = catalog()
        self.assertEqual(set(flags), {'RU.PNG', 'Untranslated.png', 'invalid-label.gif'})
        self.assertEqual(flags['RU.PNG']['label'], 'RU')
        (directory / 'flags.json').write_text(json.dumps({'RU': 'Россия', 'invalid-label': ['bad'], 'ghost': 'No file'}))
        flags = catalog()
        self.assertEqual(flags['RU.PNG']['label'], 'Россия')
        self.assertEqual(flags['RU.PNG']['url'], '/flags/RU.PNG')
        self.assertEqual(flags['Untranslated.png']['label'], 'Untranslated')
        self.assertEqual(flags['invalid-label.gif']['label'], 'invalid-label')
        (directory / 'flags.json').write_text('{broken json')
        self.assertEqual(catalog()['RU.PNG']['label'], 'RU')
        (directory / 'RU.PNG').unlink()
        self.assertNotIn('RU.PNG', catalog())

    def test_flag_selection_profile_posts_and_removal(self):
        flags = self.ok(self.guest.get('/api/flags'))
        ru = next(f for f in flags if f['file'] == 'ru.gif')
        self.assertEqual(ru, {'file': 'ru.gif', 'code': 'ru', 'label': 'Россия', 'url': '/flags/ru.gif'})
        self.ok(self.guest.get(ru['url']))
        self.ok(self.guest.get('/flags/flags.json'), 404)
        uid = self.ids['normal']
        self.assertIsNone(self.ok(self.guest.get(f'/api/users/{uid}'))['flag'])
        updated = self.ok(self.normal.post('/api/me/profile', {'flag_file': 'ru.gif'}))
        self.assertEqual(updated['flag'], ru)
        self.assertNotIn('flag_file', updated)
        self.assertIsNone(self.ok(self.mod.get('/api/session'))['user']['flag'])
        root = self.topic(self.normal)
        self.moderate(root['post_id'])
        reply = self.ok(self.normal.post(f'/api/threads/{root["thread_id"]}/replies', {'body': 'With flag'}), 201)
        self.moderate(reply['post_id'])
        thread = self.ok(self.guest.get(f'/api/threads/{root["thread_id"]}'))
        self.assertEqual(thread['post']['flag'], ru)
        self.assertEqual(thread['replies']['items'][0]['flag'], ru)
        self.assertEqual(self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'))['flag'], ru)
        self.assertEqual(self.ok(self.normal.post('/api/me/profile', {'description': 'Сохранить флаг'}))['flag'], ru)
        for value in ['../ru.gif', '/flags/ru.gif', 'missing.png', [], None]:
            self.ok(self.normal.post('/api/me/profile', {'flag_file': value, 'description': 'Не сохранять'}), 422)
        self.assertEqual(self.ok(self.guest.get(f'/api/users/{uid}'))['description'], 'Сохранить флаг')
        self.ok(self.guest.post('/api/me/profile', {'flag_file': 'ru.gif'}), 401)
        self.ok(self.normal.request('POST', '/api/me/profile', data={'flag_file': ''}, headers={'X-CSRF-Token': 'bad'}), 403)
        self.ok(self.normal.post('/api/me/profile', {'flag_file': ''}))
        self.assertIsNone(self.ok(self.guest.get(f'/api/posts/{root["post_id"]}'))['flag'])
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute("UPDATE users SET flag_file = 'removed.png' WHERE id = ?", (uid,))
        db.close()
        self.assertIsNone(self.ok(self.guest.get(f'/api/users/{uid}'))['flag'])

    def test_flag_api_discovers_new_files_without_code_changes(self):
        code = 'TEST_' + uuid.uuid4().hex
        filename = code + '.PNG'
        path = ROOT / 'public' / 'flags' / filename
        path.write_bytes((self.fixtures / 'wide.png').read_bytes())
        self.addCleanup(lambda: path.unlink(missing_ok=True))
        flags = self.ok(self.guest.get('/api/flags'))
        flag = next(f for f in flags if f['file'] == filename)
        self.assertEqual(flag['label'], code)
        response = self.guest.get(flag['url'])
        self.assertEqual(self.ok(response), (self.fixtures / 'wide.png').read_bytes())
        self.assertTrue(response[2]['Content-Type'].startswith('image/png'))
        self.assertEqual(self.ok(self.normal.post('/api/me/profile', {'flag_file': filename}))['flag'], flag)
        path.unlink()
        self.assertNotIn(filename, [f['file'] for f in self.ok(self.guest.get('/api/flags'))])
        self.assertIsNone(self.ok(self.normal.get('/api/session'))['user']['flag'])
        self.ok(self.normal.post('/api/me/profile', {'flag_file': filename}), 422)

    def test_public_profiles_and_self_edit_permissions(self):
        uid = self.ids['normal']
        url = f'/api/users/{uid}'
        profile = self.ok(self.guest.get(url))
        self.assertEqual(profile['description'], '')
        self.assertEqual(profile['avatar_url'], '/avatars/noavatar.png')
        text = '<script>alert(1)</script> О себе\nВторая строка'
        self.ok(self.normal.post('/api/me/profile', {'description': text, 'id': self.ids['moderator'],
            'role': 'admin', 'auto_approve': True, 'avatar_name': '../../private'}))
        profile = self.ok(self.guest.get(url))
        self.assertEqual(profile['description'], text)
        self.assertEqual(profile['role'], 'user')
        self.assertNotIn('avatar_name', profile)
        self.assertNotIn('password_hash', profile)
        self.assertNotIn('auto_approve', profile)
        self.assertEqual(self.ok(self.normal.get('/api/session'))['user']['description'], text)
        self.assertEqual(self.ok(self.guest.get(f'/api/users/{self.ids["moderator"]}'))['description'], '')
        self.ok(self.guest.post('/api/me/profile', {'description': 'no'}), 401)
        self.ok(self.normal.request('POST', '/api/me/profile', data={'description': 'no'}, headers={'X-CSRF-Token': 'wrong'}), 403)
        self.ok(self.normal.post(f'/api/users/{uid}/profile', {'description': 'no'}), 404)
        for value in ['я' * 2001, [], None]:
            self.ok(self.normal.post('/api/me/profile', {'description': value}), 422)
        self.assertEqual(self.ok(self.guest.get(url))['description'], text)
        self.ok(self.admin.post(f'/api/users/{uid}/ban', {'enabled': True}))
        self.ok(self.normal.post('/api/me/profile', {'description': 'no'}), 403)
        self.ok(self.guest.get('/api/users/99999999'), 404)
        self.ok(self.guest.get('/api/users/99999999/posts'), 404)

    def test_profile_avatars_are_sanitized_replaced_removed_and_used_in_posts(self):
        uid = self.ids['normal']
        result = self.topic(self.normal)
        old_path = None
        for filename in ['wide.png', 'wide.jpg', 'animated.gif', 'wide.webp']:
            updated = self.ok(self.normal.upload('/api/me/profile', {'description': 'Аватар'}, [
                (filename, (self.fixtures / filename).read_bytes())], file_field='avatar'))
            url = updated['avatar_url']
            response = self.guest.get(url)
            jpeg = self.ok(response)
            self.assertEqual(response[2]['Content-Type'], 'image/jpeg')
            self.assertEqual(response[2]['X-Content-Type-Options'], 'nosniff')
            self.assertIn('no-store', response[2]['Cache-Control'])
            self.assertEqual(self.jpeg_dimensions(jpeg), (256, 64))
            self.assertNotEqual(jpeg, (self.fixtures / filename).read_bytes())
            self.assertEqual(self.ok(self.normal.get(f'/api/posts/{result["post_id"]}'))['avatar_url'], url)
            self.assertEqual(self.ok(self.normal.get(f'/api/threads/{result["thread_id"]}'))['post']['avatar_url'], url)
            path = self.storage / 'avatars' / (urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)['v'][0] + '.jpg')
            self.assertTrue(path.exists())
            if old_path:
                self.assertFalse(old_path.exists())
            old_path = path
        unchanged = self.ok(self.normal.post('/api/me/profile', {'description': 'Новое описание'}))
        self.assertEqual(unchanged['avatar_url'], url)
        removed = self.ok(self.normal.post('/api/me/profile', {'remove_avatar': True}))
        self.assertEqual(removed['avatar_url'], '/avatars/noavatar.png')
        self.assertFalse(old_path.exists())
        self.ok(self.guest.get(url), 404)
        self.ok(self.guest.get('/api/users/99999999/avatar'), 404)
        self.assertEqual(self.ok(self.guest.get(f'/api/users/{uid}'))['description'], 'Новое описание')

    def test_bad_profile_upload_does_not_change_description_or_avatar(self):
        updated = self.ok(self.normal.upload('/api/me/profile', {'description': 'Сохранить'}, [
            ('image.png', (self.fixtures / 'wide.png').read_bytes())], file_field='avatar'))
        files_before = set((self.storage / 'avatars').iterdir())
        for filename, content, status in [('bad.svg', b'<svg xmlns="http://www.w3.org/2000/svg"/>', 422),
                                         ('bad.png', b'Not an image', 422),
                                         ('broken.png', self.png_header(16, 16), 422),
                                         ('large-dimensions.png', self.png_header(12000, 3000), 413),
                                         ('huge.png', b'x' * (2 * 1024 * 1024 + 1), 413)]:
            self.ok(self.normal.upload('/api/me/profile', {'description': 'Не сохранять'},
                [(filename, content)], file_field='avatar'), status)
        self.ok(self.normal.upload('/api/me/profile', {'description': 'no', 'remove_avatar': '1'},
            [('image.png', (self.fixtures / 'wide.png').read_bytes())], file_field='avatar'), 422)
        self.ok(self.normal.upload('/api/me/profile', {'description': 'no'},
            [('a.png', (self.fixtures / 'wide.png').read_bytes())], file_field='avatar[]'), 422)
        after = self.ok(self.normal.get('/api/session'))['user']
        self.assertEqual(after['description'], updated['description'])
        self.assertEqual(after['avatar_url'], updated['avatar_url'])
        self.assertEqual(set((self.storage / 'avatars').iterdir()), files_before)

    def test_profile_post_visibility_and_parent_protection(self):
        pending = self.topic(self.normal)
        approved = self.topic(self.normal, body='Visible content')
        self.moderate(approved['post_id'])
        rejected = self.topic(self.normal)
        self.moderate(rejected['post_id'], 'reject')
        hidden_parent = self.topic(self.admin)
        reply = self.ok(self.normal.post(f'/api/threads/{hidden_parent["thread_id"]}/replies', {'body': 'Hidden by parent'}), 201)
        self.moderate(reply['post_id'])
        self.moderate(hidden_parent['post_id'], 'unapprove')
        uid = self.ids['normal']
        for client in [self.guest, self.trusted]:
            items = self.ok(client.get(f'/api/users/{uid}/posts'))['items']
            self.assertEqual([p['id'] for p in items], [approved['post_id']])
        own = self.ok(self.normal.get(f'/api/users/{uid}/posts'))['items']
        self.assertEqual([p['id'] for p in own], [approved['post_id'], pending['post_id']])
        for client in [self.admin, self.mod]:
            items = self.ok(client.get(f'/api/users/{uid}/posts'))['items']
            self.assertEqual([p['id'] for p in items], [reply['post_id'], rejected['post_id'], approved['post_id'], pending['post_id']])
        self.ok(self.admin.post(f'/api/users/{self.ids["moderator"]}/role', {'role': 'user'}))
        self.assertEqual(len(self.ok(self.mod.get(f'/api/users/{uid}/posts'))['items']), 1)
        self.ok(self.admin.post(f'/api/posts/{approved["post_id"]}/moderate', {'action': 'delete'}))
        self.assertEqual(self.ok(self.guest.get(f'/api/users/{uid}/posts'))['items'], [])

    def test_profile_compact_pagination_and_reply_links(self):
        root = self.topic(self.admin, body='root')
        uid = self.ids['normal']
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            for i in range(21):
                db.execute("INSERT INTO posts(thread_id,user_id,body,status) VALUES (?,?,?,'approved')",
                           (root['thread_id'], uid, 'x' * 300))
        db.close()
        data = self.ok(self.guest.get(f'/api/users/{uid}/posts?limit=1'))
        self.assertTrue(data['has_more'])
        item = data['items'][0]
        self.assertEqual(len(item['excerpt']), 180)
        self.assertNotIn('body', item)
        self.assertNotIn('attachments', item)
        self.assertIn('&page=2#post-', item['url'])
        thread = self.ok(self.guest.get(f'/api/threads/{root["thread_id"]}?page=2'))
        self.assertEqual(thread['replies']['items'][0]['id'], item['id'])
        self.assertEqual(len(self.ok(self.guest.get(f'/api/users/{uid}/posts?page=2'))['items']), 1)
        self.ok(self.guest.get(f'/api/users/{uid}/posts?page=0'), 422)

    def test_premoderation_and_public_visibility(self):
        pending = self.topic(self.normal, body='hidden-unique-content')
        self.assertEqual(pending['status'], 'pending')
        self.ok(self.guest.get(f'/api/posts/{pending["post_id"]}'), 404)
        self.ok(self.guest.get(f'/api/threads/{pending["thread_id"]}'), 404)
        self.assertEqual(self.ok(self.guest.get('/api/threads'))['items'], [])
        self.assertEqual(self.ok(self.guest.get('/api/threads?q=hidden-unique-content'))['items'], [])
        self.ok(self.normal.get(f'/api/posts/{pending["post_id"]}'))
        queue = self.ok(self.mod.get('/api/moderation/queue'))['items']
        self.assertEqual([p['id'] for p in queue], [pending['post_id']])
        self.moderate(pending['post_id'])
        self.ok(self.guest.get(f'/api/threads/{pending["thread_id"]}'))
        self.assertEqual(len(self.ok(self.guest.get('/api/threads?q=hidden-unique-content'))['items']), 1)

    def test_staff_lists_pending_topics_without_a_moderation_page(self):
        pending = self.topic(self.normal, body='staff-only-search-content')
        tid = pending['thread_id']
        for client in [self.admin, self.mod]:
            for query in ['', '?section_id=' + str(self.section), '?q=staff-only-search-content']:
                items = self.ok(client.get('/api/threads' + query))['items']
                self.assertEqual([(p['id'], p['status']) for p in items], [(tid, 'pending')])
            self.assertEqual(self.ok(client.get('/api/threads?featured=1'))['items'], [])
        for client in [self.guest, self.normal, self.trusted]:
            for query in ['', '?section_id=' + str(self.section), '?q=staff-only-search-content', '?include_pending=1']:
                self.assertEqual(self.ok(client.get('/api/threads' + query))['items'], [])
        self.ok(self.admin.post(f'/api/threads/{tid}/settings', {'is_news': True, 'is_featured': True}))
        for client in [self.admin, self.mod]:
            self.assertEqual(self.ok(client.get('/api/threads?news=1&featured=1'))['items'][0]['status'], 'pending')
        self.assertEqual(self.ok(self.guest.get('/api/threads?news=1'))['items'], [])
        self.moderate(pending['post_id'], 'reject')
        self.assertEqual(self.ok(self.admin.get('/api/threads'))['items'], [])
        self.moderate(pending['post_id'], 'delete')
        self.assertEqual(self.ok(self.mod.get('/api/threads'))['items'], [])

    def test_staff_search_and_counts_include_pending_replies_without_public_leaks(self):
        topic = self.topic()
        tid = topic['thread_id']
        pending = self.ok(self.normal.post(f'/api/threads/{tid}/replies', {'body': 'private-reply-search'}), 201)
        for client in [self.admin, self.mod]:
            item = self.ok(client.get('/api/threads?q=private-reply-search'))['items'][0]
            self.assertEqual(item['reply_count'], 1)
            self.assertEqual(item['pending_reply_count'], 1)
            replies = self.ok(client.get(f'/api/threads/{tid}'))['replies']['items']
            self.assertEqual([(p['id'], p['status']) for p in replies], [(pending['post_id'], 'pending')])
        for client in [self.guest, self.trusted]:
            self.assertEqual(self.ok(client.get('/api/threads?q=private-reply-search'))['items'], [])
            item = self.ok(client.get('/api/threads'))['items'][0]
            self.assertEqual(item['reply_count'], 0)
            self.assertEqual(item['pending_reply_count'], 0)
            self.assertEqual(self.ok(client.get(f'/api/threads/{tid}'))['replies']['items'], [])
        self.moderate(pending['post_id'])
        item = self.ok(self.guest.get('/api/threads?q=private-reply-search'))['items'][0]
        self.assertEqual(item['reply_count'], 1)
        self.assertEqual(item['pending_reply_count'], 0)

    def test_staff_prioritizes_pending_topics_and_topics_with_pending_replies(self):
        old = self.topic()
        self.ok(self.normal.post(f'/api/threads/{old["thread_id"]}/replies', {'body': 'Review this reply'}), 201)
        newer = self.topic()
        pending = self.topic(self.guest)
        for client in [self.admin, self.mod]:
            items = self.ok(client.get('/api/threads'))['items']
            self.assertEqual([p['id'] for p in items], [pending['thread_id'], old['thread_id'], newer['thread_id']])
            self.assertEqual(self.ok(client.get('/api/threads?limit=1'))['items'][0]['status'], 'pending')
        items = self.ok(self.guest.get('/api/threads'))['items']
        self.assertEqual([p['id'] for p in items], [newer['thread_id'], old['thread_id']])

    def test_staff_feed_permissions_are_revoked_for_existing_sessions(self):
        self.topic(self.normal)
        self.assertEqual(len(self.ok(self.mod.get('/api/threads'))['items']), 1)
        uid = self.ids['moderator']
        self.ok(self.admin.post(f'/api/users/{uid}/role', {'role': 'user'}))
        self.assertEqual(self.ok(self.mod.get('/api/threads'))['items'], [])
        self.ok(self.admin.post(f'/api/users/{uid}/role', {'role': 'moderator'}))
        self.assertEqual(len(self.ok(self.mod.get('/api/threads'))['items']), 1)
        self.ok(self.admin.post(f'/api/users/{uid}/ban', {'enabled': True}))
        self.assertEqual(self.ok(self.mod.get('/api/threads'))['items'], [])

    def test_anonymous_and_staff_publication(self):
        guest = self.topic(self.guest)
        self.assertEqual(guest['status'], 'pending')
        self.ok(self.guest.get(f'/api/posts/{guest["post_id"]}'), 404)
        self.assertEqual(self.topic(self.mod)['status'], 'approved')
        self.assertEqual(self.topic(self.admin)['status'], 'approved')
        self.moderate(guest['post_id'])
        self.assertIsNone(self.ok(self.guest.get(f'/api/posts/{guest["post_id"]}'))['user_id'])

    def test_trust_grant_revoke_and_no_retroactive_approval(self):
        old = self.topic(self.trusted)
        self.trust(True)
        self.assertEqual(self.topic(self.trusted)['status'], 'approved')
        self.assertEqual(self.ok(self.trusted.get(f'/api/posts/{old["post_id"]}'))['status'], 'pending')
        self.trust(False)
        self.assertEqual(self.topic(self.trusted)['status'], 'pending')
        audit = self.ok(self.mod.get('/api/moderation/audit'))['items']
        self.assertEqual(sum(x['action'] == 'user.trust' for x in audit), 2)
        self.ok(self.admin.post(f'/api/users/{self.ids["trusted"]}/trust', {'enabled': True}))
        self.assertEqual(self.topic(self.trusted)['status'], 'approved')

    def test_replies_counts_and_parent_visibility(self):
        topic = self.topic()
        tid = topic['thread_id']
        reply = self.ok(self.normal.post(f'/api/threads/{tid}/replies', {'body': 'secret-answer'}), 201)
        self.assertEqual(self.ok(self.guest.get('/api/threads'))['items'][0]['reply_count'], 0)
        self.assertEqual(self.ok(self.guest.get(f'/api/threads/{tid}'))['replies']['items'], [])
        self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'), 404)
        self.moderate(reply['post_id'])
        self.assertEqual(self.ok(self.guest.get('/api/threads'))['items'][0]['reply_count'], 1)
        self.moderate(topic['post_id'], 'unapprove')
        self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'), 404)
        self.assertEqual(self.ok(self.guest.get('/api/threads?q=secret-answer'))['items'], [])
        self.moderate(topic['post_id'])
        self.moderate(reply['post_id'], 'reject')
        self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'), 404)

    def test_authorization_csrf_and_private_files(self):
        self.ok(self.normal.post('/api/sections', {'slug': 'bad', 'title': 'bad'}), 403)
        self.ok(self.guest.get('/api/moderation/queue'), 401)
        self.ok(self.normal.get('/api/moderation/queue'), 403)
        self.ok(self.normal.get('/api/moderation/audit'), 403)
        self.ok(self.normal.request('POST', '/api/threads', data={}, headers={'X-CSRF-Token': 'wrong'}), 403)
        self.ok(self.normal.request('DELETE', '/api/threads'), 405)
        for path in ['/storage/forum.sqlite', '/src/Api.php', '/database/migrations/001_initial.sql', '/.git/HEAD', '/bin/console.php']:
            self.ok(self.guest.get(path), 404)
        profile = self.ok(self.guest.get(f'/api/users/{self.ids["normal"]}'))
        self.assertNotIn('password_hash', profile)
        self.assertNotIn('auto_approve', profile)
        self.ok(self.normal.post(f'/api/users/{self.ids["normal"]}/trust', {'enabled': True}), 403)
        self.ok(self.normal.post('/api/threads', {
            'section_id': self.section, 'title': 'bad', 'body': 'bad', 'is_news': True,
        }), 403)

    def test_roles_bans_and_existing_sessions(self):
        uid = self.ids['normal']
        self.ok(self.mod.post(f'/api/users/{uid}/role', {'role': 'moderator'}), 403)
        self.ok(self.admin.post(f'/api/users/{uid}/role', {'role': 'moderator'}))
        self.assertEqual(self.topic(self.normal)['status'], 'approved')
        self.ok(self.admin.post(f'/api/users/{uid}/role', {'role': 'user'}))
        self.assertEqual(self.topic(self.normal)['status'], 'pending')
        self.ok(self.mod.post(f'/api/users/{uid}/ban', {'enabled': True, 'reason': 'spam'}))
        self.ok(self.normal.request('POST', '/api/threads', data={'section_id': self.section, 'title': 'x', 'body': 'x'}), 403)
        self.ok(self.mod.post(f'/api/users/{self.ids["moderator"]}/ban', {'enabled': True}), 403)
        self.ok(self.mod.post(f'/api/users/{uid}/ban', {'enabled': False}))
        self.assertEqual(self.topic(self.normal)['status'], 'pending')

    def test_flags_lock_archive_and_pagination(self):
        topic = self.topic(is_news=True, is_featured=True)
        tid = topic['thread_id']
        self.assertEqual(len(self.ok(self.guest.get('/api/threads?news=1&featured=1'))['items']), 1)
        self.ok(self.mod.post(f'/api/threads/{tid}/settings', {'is_locked': True}))
        self.ok(self.normal.post(f'/api/threads/{tid}/replies', {'body': 'blocked'}), 409)
        self.ok(self.mod.post(f'/api/threads/{tid}/replies', {'body': 'staff'}), 201)
        self.ok(self.admin.post(f'/api/sections/{self.section}/settings', {'is_archived': True}))
        self.ok(self.normal.post('/api/threads', {'section_id': self.section, 'title': 'a', 'body': 'b'}), 409)
        self.topic()
        page = self.ok(self.guest.get('/api/threads?limit=1'))
        self.assertTrue(page['has_more'])
        self.assertEqual(len(self.ok(self.guest.get('/api/threads?limit=1&page=2'))['items']), 1)
        self.ok(self.guest.get('/api/threads?page=0'), 422)
        self.ok(self.guest.get('/api/threads?section_id=1%20OR%201=1'), 422)

    def test_audio_formats_inline_mime_and_bytes(self):
        formats = {'mp3': 'audio/mpeg', 'mp2': 'audio/mpeg', 'flac': 'audio/flac',
                   'wav': 'audio/wav', 'ogg': 'audio/ogg', 'opus': 'audio/ogg',
                   'm4a': 'audio/mp4', 'aac': 'audio/aac', 'aiff': 'audio/x-aiff',
                   'wma': 'audio/x-ms-wma', 'weba': 'audio/webm'}
        entries = list(formats.items())
        for batch in [entries[:6], entries[6:]]:
            result = self.ok(self.admin.upload('/api/threads', {
                'section_id': self.section, 'title': 'Audio formats', 'body': 'Audio',
            }, [('sample.' + ext, (self.fixtures / ('sample.' + ext)).read_bytes()) for ext, _ in batch]), 201)
            files = self.ok(self.guest.get(f'/api/posts/{result["post_id"]}'))['attachments']
            self.assertEqual(len(files), len(batch))
            for audio, (ext, mime) in zip(files, batch):
                with self.subTest(ext=ext):
                    self.assertTrue(audio['is_audio'])
                    self.assertFalse(audio['is_video'])
                    self.assertFalse(audio['is_image'])
                    self.assertIsNone(audio['preview_url'])
                    data = (self.fixtures / ('sample.' + ext)).read_bytes()
                    response = self.guest.get(audio['view_url'])
                    self.assertEqual(self.ok(response), data)
                    self.assertEqual(response[2]['Content-Type'], mime)
                    self.assertIn('inline;', response[2]['Content-Disposition'])
                    self.assertIn('no-store', response[2]['Cache-Control'])
                    self.assertEqual(self.ok(self.guest.request('GET', audio['view_url'], headers={'Range': 'bytes=0-15'}), 206), data[:16])
                    download = self.guest.get(audio['download_url'])
                    self.assertEqual(self.ok(download), data)
                    self.assertEqual(download[2]['Content-Type'], 'application/octet-stream')
                    self.ok(self.guest.get(f'/api/attachments/{audio["id"]}/preview'), 404)

    def test_audio_visibility_ranges_moderation_and_quote_plain_text(self):
        body = '> green\n< orange\n^ blue\n<script>window.XSS=true</script>\nplain > not a quote\n\nend'
        data = (self.fixtures / 'sample.wav').read_bytes()
        root = self.ok(self.normal.upload('/api/threads', {
            'section_id': self.section, 'title': 'Audio protection', 'body': body, 'spoilers[]': '0',
        }, [('sample.wav', data)]), 201)
        post = self.ok(self.normal.get(f'/api/posts/{root["post_id"]}'))
        self.assertEqual(post['body'], body)
        audio = post['attachments'][0]
        self.assertEqual(audio['spoiler'], 1)
        url = audio['view_url']
        for method, headers in [('GET', {}), ('HEAD', {}), ('GET', {'Range': 'bytes=0-15'})]:
            self.ok(self.guest.request(method, url, headers=headers), 404)
        self.moderate(root['post_id'])
        head = self.guest.request('HEAD', url)
        self.assertEqual(self.ok(head), b'')
        self.assertEqual(int(head[2]['Content-Length']), len(data))
        self.assertEqual(self.ok(self.guest.request('GET', url, headers={'Range': 'bytes=-12'}), 206), data[-12:])
        self.ok(self.guest.request('GET', url, headers={'Range': 'bytes=99999999-'}), 416)
        for action in ['hide', 'block']:
            self.ok(self.mod.post(f'/api/posts/{root["post_id"]}/restrict', {'action': action, 'reason': 'Audio restriction'}))
            self.ok(self.normal.request('GET', url, headers={'Range': 'bytes=0-15'}), 404)
            self.ok(self.guest.request('HEAD', url), 404)
            self.ok(self.mod.get(url))
            self.ok(self.mod.post(f'/api/posts/{root["post_id"]}/restrict', {'action': 'un' + action if action == 'block' else 'unhide', 'reason': 'Restore'}))
        reply = self.ok(self.admin.upload(f'/api/threads/{root["thread_id"]}/replies', {'body': 'Audio reply'}, [('sample.wav', data)]), 201)
        reply_audio = self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'))['attachments'][0]
        self.moderate(root['post_id'], 'unapprove')
        self.ok(self.guest.get(reply_audio['view_url']), 404)
        self.moderate(root['post_id'])
        self.ok(self.mod.post(f'/api/attachments/{audio["id"]}/moderate', {'action': 'hide', 'reason': 'Audio file hidden'}))
        self.ok(self.mod.get(url), 404)
        self.ok(self.mod.post(f'/api/attachments/{reply_audio["id"]}/moderate', {'action': 'hashban', 'reason': 'Audio file banned'}))
        self.ok(self.admin.get(reply_audio['view_url']), 404)
        self.ok(self.normal.upload('/api/threads', {'section_id': self.section, 'title': 'Banned audio', 'body': 'no'}, [('renamed.wav', data)]), 422)

    def test_audio_rejects_fake_content_and_mismatched_extensions(self):
        fields = {'section_id': self.section, 'title': 'Fake audio', 'body': 'bad'}
        for name, data in [('fake.mp3', b'<html>not music</html>'),
                           ('fake.wav', (self.fixtures / 'wide.png').read_bytes()),
                           ('fake.flac', (self.fixtures / 'sample.mp3').read_bytes()),
                           ('fake.ogg', b'not an ogg container'),
                           ('fake.html', (self.fixtures / 'sample.mp3').read_bytes())]:
            self.ok(self.normal.upload('/api/threads', fields, [(name, data)]), 422)

    def video_post(self, filename='sample.webm', client=None):
        client = client or self.normal
        result = self.ok(client.upload('/api/threads', {
            'section_id': self.section, 'title': 'Video topic', 'body': 'Video attachment',
        }, [(filename, (self.fixtures / filename).read_bytes())]), 201)
        video = self.ok(client.get(f'/api/posts/{result["post_id"]}'))['attachments'][0]
        return result, video

    def test_embedded_videos_visibility_mime_and_original_bytes(self):
        for filename in ['sample.mp4', 'sample.webm']:
            result, video = self.video_post(filename)
            self.assertTrue(video['is_video'])
            self.assertFalse(video['is_image'])
            self.assertIsNone(video['preview_url'])
            for endpoint in ['view_url', 'download_url']:
                self.ok(self.guest.get(video[endpoint]), 404)
                self.ok(self.guest.request('HEAD', video[endpoint]), 404)
                self.ok(self.guest.request('GET', video[endpoint], headers={'Range': 'bytes=0-9'}), 404)
            self.ok(self.normal.get(f'/api/attachments/{video["id"]}/preview'), 404)
            response = self.normal.get(video['view_url'])
            self.assertEqual(self.ok(response), (self.fixtures / filename).read_bytes())
            self.assertEqual(response[2]['Content-Type'], 'video/mp4' if filename.endswith('.mp4') else 'video/webm')
            self.assertIn('inline;', response[2]['Content-Disposition'])
            self.assertIn('no-store', response[2]['Cache-Control'])
            self.moderate(result['post_id'])
            self.assertEqual(self.ok(self.guest.get(video['view_url'])), (self.fixtures / filename).read_bytes())
            self.assertIn('attachment;', self.guest.get(video['download_url'])[2]['Content-Disposition'])
            self.moderate(result['post_id'], 'delete')
            self.ok(self.guest.get(video['view_url']), 404)
            self.ok(self.normal.get(video['view_url']), 404)
            self.ok(self.mod.get(video['view_url']))
        fields = {'section_id': self.section, 'title': 'Fake video', 'body': 'bad'}
        self.ok(self.normal.upload('/api/threads', fields, [('fake.mp4', b'<html>Not video</html>')]), 422)
        self.ok(self.normal.upload('/api/threads', fields, [('fake.webm', (self.fixtures / 'wide.png').read_bytes())]), 422)

    def test_video_byte_ranges_head_and_parent_access(self):
        result, video = self.video_post(client=self.admin)
        data = (self.fixtures / 'sample.webm').read_bytes()
        url = video['view_url']
        for header, start, end in [('bytes=0-9', 0, 9), ('bytes=10-', 10, len(data)-1),
                                    ('bytes=-12', len(data)-12, len(data)-1),
                                    ('bytes=0-9999999', 0, len(data)-1)]:
            response = self.guest.request('GET', url, headers={'Range': header})
            self.assertEqual(self.ok(response, 206), data[start:end+1])
            self.assertEqual(response[2]['Content-Range'], f'bytes {start}-{end}/{len(data)}')
            self.assertEqual(int(response[2]['Content-Length']), end-start+1)
        for header in ['bytes=999999-', 'bytes=-0', 'bytes=10-1', 'bytes=0-1,4-5', 'nonsense']:
            response = self.guest.request('GET', url, headers={'Range': header})
            self.ok(response, 416)
            self.assertEqual(response[2]['Content-Range'], f'bytes */{len(data)}')
        head = self.guest.request('HEAD', url, headers={'Range': 'bytes=0-9'})
        self.assertEqual(self.ok(head), b'')
        self.assertEqual(int(head[2]['Content-Length']), len(data))
        self.assertEqual(head[2]['Accept-Ranges'], 'bytes')
        self.assertEqual(self.ok(self.guest.request('GET', url, headers={'Range': 'bytes=0-9', 'If-Range': 'outdated'})), data)
        reply = self.ok(self.mod.upload(f'/api/threads/{result["thread_id"]}/replies', {'body': 'Video reply'},
            [('sample.webm', data)]), 201)
        reply_url = self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'))['attachments'][0]['view_url']
        self.moderate(result['post_id'], 'unapprove')
        for hidden in [url, reply_url]:
            self.ok(self.guest.request('GET', hidden, headers={'Range': 'bytes=0-9'}), 404)
            self.ok(self.guest.request('HEAD', hidden), 404)
            self.ok(self.mod.request('GET', hidden, headers={'Range': 'bytes=0-9'}), 206)
        self.ok(self.guest.request('HEAD', '/api/threads'), 405)

    def test_sections_recent_five_roots_and_replies_visibility(self):
        root = self.topic()
        tid = root['thread_id']
        pending = self.ok(self.normal.post(f'/api/threads/{tid}/replies', {'body': 'secret reply'}), 201)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            for i in range(7):
                db.execute("INSERT INTO posts(thread_id,user_id,body,status) VALUES (?,?,?,'approved')", (tid, self.ids['normal'], f'Reply {i}'))
        db.close()
        sections = self.ok(self.guest.get('/api/sections'))
        items = sections[0]['recent_posts']
        self.assertEqual([p['excerpt'] for p in items], [f'Reply {i}' for i in range(6,1,-1)])
        self.assertTrue(all(p['is_root'] == 0 and p['status'] == 'approved' for p in items))
        second = self.ok(self.admin.post('/api/sections', {'slug': 'second', 'title': 'Second'}), 201)['id']
        other = self.topic(section_id=second)
        self.assertEqual(self.ok(self.guest.get('/api/sections'))[1]['recent_posts'][0]['id'], other['post_id'])
        latest = self.ok(self.normal.post(f'/api/threads/{tid}/replies', {'body': 'hidden-newest'}), 201)
        self.assertNotIn(latest['post_id'], [p['id'] for p in self.ok(self.normal.get('/api/sections'))[0]['recent_posts']])
        for client in [self.mod, self.admin]:
            self.assertEqual(self.ok(client.get('/api/sections'))[0]['recent_posts'][0]['id'], latest['post_id'])
        self.moderate(root['post_id'], 'unapprove')
        self.assertEqual(self.ok(self.guest.get('/api/sections'))[0]['recent_posts'], [])
        self.moderate(root['post_id'], 'reject')
        self.assertEqual(self.ok(self.mod.get('/api/sections'))[0]['recent_posts'], [])

    def test_sections_recent_reply_page_and_role_revocation(self):
        root = self.topic()
        tid = root['thread_id']
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            for i in range(21):
                db.execute("INSERT INTO posts(thread_id,body,status) VALUES (?,?,'approved')", (tid, f'Visible {i}'))
        db.close()
        item = self.ok(self.guest.get('/api/sections'))[0]['recent_posts'][0]
        self.assertIn('&page=2#post-', item['url'])
        self.assertEqual(self.ok(self.guest.get(f'/api/threads/{tid}?page=2'))['replies']['items'][0]['id'], item['id'])
        pending = self.topic(self.normal)
        self.assertEqual(self.ok(self.mod.get('/api/sections'))[0]['recent_posts'][0]['id'], pending['post_id'])
        self.ok(self.admin.post(f'/api/users/{self.ids["moderator"]}/role', {'role': 'user'}))
        self.assertNotIn(pending['post_id'], [p['id'] for p in self.ok(self.mod.get('/api/sections'))[0]['recent_posts']])

    def test_attachments_visibility_spoiler_and_parent(self):
        content = b'ForBirds private attachment\n'
        pending = self.ok(self.normal.upload('/api/threads', {
            'section_id': self.section, 'title': 'Files', 'body': 'Attachments', 'spoilers[]': '0',
        }, [('test.txt', content)]), 201)
        post = self.ok(self.normal.get(f'/api/posts/{pending["post_id"]}'))
        attachment = post['attachments'][0]
        self.assertEqual(attachment['spoiler'], 1)
        self.assertNotIn('storage_name', attachment)
        url = attachment['download_url']
        self.ok(self.guest.get(url), 404)
        self.assertEqual(self.ok(self.normal.get(url)), content)
        self.moderate(pending['post_id'])
        response = self.guest.get(url)
        self.assertEqual(self.ok(response), content)
        self.assertIn('attachment;', response[2]['Content-Disposition'])
        reply = self.ok(self.mod.upload(f'/api/threads/{pending["thread_id"]}/replies', {'body': 'file reply'}, [('reply.txt', content)]), 201)
        reply_file = self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'))['attachments'][0]['download_url']
        self.moderate(pending['post_id'], 'unapprove')
        self.ok(self.guest.get(url), 404)
        self.ok(self.guest.get(reply_file), 404)

    @staticmethod
    def jpeg_dimensions(data):
        assert data[:2] == b'\xff\xd8'
        pos = 2
        while pos < len(data):
            assert data[pos] == 255
            marker = data[pos + 1]
            pos += 2
            size = int.from_bytes(data[pos:pos + 2], 'big')
            if marker in (0xc0, 0xc1, 0xc2):
                height, width = struct.unpack('>HH', data[pos + 3:pos + 7])
                return width, height
            pos += size
        raise AssertionError('No JPEG dimensions')

    def image_post(self, filename='wide.png', client=None, spoiler=False):
        fields = {'section_id': self.section, 'title': 'Image', 'body': 'Preview test'}
        if spoiler:
            fields['spoilers[]'] = '0'
        client = client or self.normal
        result = self.ok(client.upload('/api/threads', fields, [
            (filename, (self.fixtures / filename).read_bytes()),
        ]), 201)
        image = self.ok(client.get(f'/api/posts/{result["post_id"]}'))['attachments'][0]
        return result, image

    def test_image_previews_and_inline_originals_for_all_supported_formats(self):
        for filename in ['wide.png', 'wide.gif', 'animated.gif', 'wide.jpg', 'wide.webp', 'portrait.png', 'small.png']:
            with self.subTest(filename=filename):
                result, image = self.image_post(filename)
                self.assertTrue(image['is_image'])
                self.assertNotIn('storage_name', image)
                for endpoint in ['preview_url', 'view_url', 'download_url']:
                    self.ok(self.guest.get(image[endpoint]), 404)
                response = self.normal.get(image['preview_url'])
                jpeg = self.ok(response)
                self.assertEqual(response[2]['Content-Type'], 'image/jpeg')
                expected = (32, 256) if filename == 'portrait.png' else (32, 16) if filename == 'small.png' else (256, 64)
                self.assertEqual(self.jpeg_dimensions(jpeg), expected)
                self.assertIn('inline;', response[2]['Content-Disposition'])
                self.assertIn('no-store', response[2]['Cache-Control'])
                original = self.normal.get(image['view_url'])
                self.assertEqual(self.ok(original), (self.fixtures / filename).read_bytes())
                self.assertTrue(original[2]['Content-Type'].startswith('image/'))
                self.assertEqual(original[2]['X-Content-Type-Options'], 'nosniff')
                self.moderate(result['post_id'])
                self.ok(self.guest.get(image['preview_url']))
                self.ok(self.guest.get(image['view_url']))
                self.assertIn('attachment;', self.guest.get(image['download_url'])[2]['Content-Disposition'])

    def test_image_previews_revoke_access_with_parent_and_deleted_posts(self):
        topic, image = self.image_post(spoiler=True)
        self.assertEqual(image['spoiler'], 1)
        self.moderate(topic['post_id'])
        reply = self.ok(self.mod.upload(f'/api/threads/{topic["thread_id"]}/replies', {'body': 'Image reply'}, [
            ('wide.gif', (self.fixtures / 'wide.gif').read_bytes()),
        ]), 201)
        reply_image = self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'))['attachments'][0]
        self.moderate(topic['post_id'], 'unapprove')
        for attachment in [image, reply_image]:
            for endpoint in ['preview_url', 'view_url', 'download_url']:
                self.ok(self.guest.get(attachment[endpoint]), 404)
        self.moderate(topic['post_id'])
        self.moderate(reply['post_id'], 'delete')
        self.ok(self.guest.get(reply_image['preview_url']), 404)
        self.ok(self.guest.get(reply_image['view_url']), 404)

    def test_existing_images_regenerate_missing_previews_privately(self):
        _, image = self.image_post()
        # Simulate an upload made before thumbnail support (the derived preview is absent).
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            name = db.execute('SELECT storage_name FROM attachments WHERE id = ?', (image['id'],)).fetchone()[0]
        db.close()
        cached_path = self.storage / 'previews' / (name + '.jpg')
        cached_path.unlink()
        preview = self.ok(self.normal.get(image['preview_url']))
        self.assertEqual(self.jpeg_dimensions(preview), (256, 64))
        self.assertEqual(cached_path.read_bytes(), preview)
        self.ok(self.guest.get('/storage/previews/' + cached_path.name), 404)

    def test_nonimages_cannot_be_embedded(self):
        topic = self.ok(self.normal.upload('/api/threads', {
            'section_id': self.section, 'title': 'Text', 'body': 'File',
        }, [('file.txt', b'Plain text attachment')]), 201)
        attachment = self.ok(self.normal.get(f'/api/posts/{topic["post_id"]}'))['attachments'][0]
        self.assertFalse(attachment['is_image'])
        self.assertIsNone(attachment['view_url'])
        self.assertIsNone(attachment['preview_url'])
        self.ok(self.normal.get(f'/api/attachments/{attachment["id"]}/view'), 404)
        self.ok(self.normal.get(f'/api/attachments/{attachment["id"]}/preview'), 404)
        self.assertEqual(self.normal.get(attachment['download_url'])[2]['Content-Type'], 'application/octet-stream')

    @staticmethod
    def png_header(width, height):
        def chunk(kind, data):
            return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data))
        return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 2, 0, 0, 0)) + chunk(b'IEND', b'')

    def test_image_decode_failure_rolls_back_post_files_and_cooldown(self):
        before = set((self.storage / 'uploads').iterdir())
        fields = {'section_id': self.section, 'title': 'Broken', 'body': 'Image'}
        self.ok(self.normal.upload('/api/threads', fields, [('broken.png', self.png_header(16, 16))]), 422)
        self.assertEqual(before, set((self.storage / 'uploads').iterdir()))
        self.assertEqual(self.ok(self.normal.get('/api/posting-status'))['retry_after'], 0)
        self.assertEqual(self.ok(self.normal.get('/api/me/posts'))['items'], [])
        self.ok(self.normal.upload('/api/threads', fields, [('huge.png', self.png_header(12000, 3000))]), 413)
        self.assertEqual(before, set((self.storage / 'uploads').iterdir()))

    def test_upload_validation_and_transaction_rollback(self):
        fields = {'section_id': self.section, 'title': 'bad', 'body': 'bad'}
        self.ok(self.normal.upload('/api/threads', fields, [('evil.php', b'<?php echo 123;')]), 422)
        self.ok(self.normal.upload('/api/threads', fields, [('fake.png', b'not a png')]), 422)
        self.ok(self.normal.upload('/api/threads', fields, [(f'{n}.txt', b'abc') for n in range(11)]), 422)
        self.ok(self.normal.upload('/api/threads', {**fields, 'section_id': 999999}, [('ok.txt', b'text')]), 404)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM threads').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM attachments').fetchone()[0], 0)
        db.close()

    def test_validation_plain_text_and_deleted_posts(self):
        self.ok(self.normal.request('POST', '/api/threads', raw=b'{', headers={'Content-Type': 'application/json'}), 400)
        self.ok(self.normal.request('POST', '/api/threads', raw=b'[]', headers={'Content-Type': 'application/json'}), 422)
        self.ok(self.normal.post('/api/threads', {'section_id': self.section, 'title': [], 'body': 'x'}), 422)
        topic = self.topic(body='<script>alert(1)</script>')
        self.assertEqual(len(self.ok(self.guest.get('/api/threads?q=' + urllib.parse.quote('ТЕСТОВАЯ')))['items']), 1)
        self.assertEqual(self.ok(self.guest.get(f'/api/posts/{topic["post_id"]}'))['body'], '<script>alert(1)</script>')
        self.moderate(topic['post_id'], 'delete')
        self.ok(self.guest.get(f'/api/posts/{topic["post_id"]}'), 404)
        self.ok(self.mod.post(f'/api/posts/{topic["post_id"]}/moderate', {'action': 'approve'}), 409)
        self.assertEqual(self.ok(self.guest.get('/api/threads'))['items'], [])

    def test_login_logout_csrf_rotation_and_duplicate_username(self):
        client = Client(self.base)
        previous = client.csrf
        self.ok(client.post('/api/auth/login', {'username': 'normal', 'password': PASSWORD}))
        self.assertNotEqual(previous, client.csrf)
        self.ok(client.request('POST', '/api/auth/logout', data={}, headers={'X-CSRF-Token': previous}), 403)
        self.ok(client.post('/api/auth/logout', {}))
        self.assertIsNone(self.ok(client.get('/api/session'))['user'])
        self.ok(client.get('/api/me/posts'), 401)
        self.ok(client.post('/api/auth/login', {'username': 'normal', 'password': 'wrong-password-123'}), 401)
        self.ok(client.post('/api/auth/register', {'username': 'NORMAL', 'password': PASSWORD}), 409)
        self.ok(client.request('POST', '/api/auth/login', raw=b'username=normal&password=' + PASSWORD.encode(),
                               headers={'Content-Type': 'application/x-www-form-urlencoded'}))

    def test_rate_limits_survive_new_sessions(self):
        for _ in range(10):
            self.topic(self.guest)
        fresh = Client(self.base)
        response = fresh.post('/api/threads', {'section_id': self.section, 'title': 'spam', 'body': 'spam'})
        self.ok(response, 429)
        self.assertIn('Retry-After', response[2])


    def raw_topic(self, client, proof=None):
        return client.request('POST', '/api/threads', data={
            'section_id': self.section, 'title': 'Защищённая тема', 'body': 'Сообщение', **(proof or {}),
        })

    def expire_cooldown(self):
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('UPDATE posting_limits SET last_post_at = 0')
        db.close()

    def test_pow_required_for_every_role_and_trusted(self):
        self.trust(True)
        for client in [self.guest, self.normal, self.trusted, self.mod, self.admin]:
            error = self.ok(self.raw_topic(client), 422)
            self.assertEqual(error['error']['code'], 'pow_required')
            proof = client.proof()
            self.ok(self.raw_topic(client, proof), 201)
            status = self.ok(client.get('/api/posting-status'))
            self.assertEqual(status['interval_seconds'], 45 if client is self.guest else 30)
            self.assertGreaterEqual(status['retry_after'], status['interval_seconds'] - 2)

    def test_cooldown_persists_across_sessions_and_cannot_be_skipped(self):
        for client, username, interval in [(self.guest, None, 45), (self.normal, 'normal', 30)]:
            proof = client.proof()
            self.ok(self.raw_topic(client, proof), 201)
            response = self.raw_topic(client, proof)
            self.ok(response, 429)
            self.assertEqual(response[1]['error']['code'], 'posting_cooldown')
            self.assertGreaterEqual(int(response[2]['Retry-After']), interval - 2)
            fresh = Client(self.base)
            if username:
                self.ok(fresh.post('/api/auth/login', {'username': username, 'password': PASSWORD}))
            self.assertGreaterEqual(self.ok(fresh.get('/api/posting-status'))['retry_after'], interval - 2)
            blocked = fresh.request('POST', '/api/pow/challenge', data={}, headers={'X-Forwarded-For': '203.0.113.99'})
            self.ok(blocked, 429)
            self.expire_cooldown()
            replay = self.ok(self.raw_topic(client, proof), 422)
            self.assertEqual(replay['error']['code'], 'pow_expired')

    def test_pow_binding_expiration_invalid_nonce_and_rotation(self):
        proof = self.guest.proof()
        other = Client(self.base)
        self.ok(self.raw_topic(other, proof), 422)
        new_proof = self.guest.proof()
        self.ok(self.raw_topic(self.guest, proof), 422)  # superseded challenge
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            prefix = db.execute('SELECT prefix FROM pow_challenges WHERE id = ?', (new_proof['pow_id'],)).fetchone()[0]
        db.close()
        invalid = 0
        while hashlib.sha256(f'{prefix}:{invalid}'.encode()).digest()[0] == 0:
            invalid += 1
        error = self.ok(self.raw_topic(self.guest, {**new_proof, 'pow_nonce': str(invalid)}), 422)
        self.assertEqual(error['error']['code'], 'pow_invalid')
        self.assertEqual(self.ok(self.guest.get('/api/posting-status'))['retry_after'], 0)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('UPDATE pow_challenges SET expires_at = 0')
        db.close()
        error = self.ok(self.raw_topic(self.guest, new_proof), 422)
        self.assertEqual(error['error']['code'], 'pow_expired')

    def test_failed_post_rolls_back_proof_and_cooldown(self):
        proof = self.normal.proof()
        self.ok(self.normal.request('POST', '/api/threads', data={
            'section_id': 999999, 'title': 'bad', 'body': 'bad', **proof,
        }), 404)
        self.assertEqual(self.ok(self.normal.get('/api/posting-status'))['retry_after'], 0)
        self.ok(self.raw_topic(self.normal, proof), 201)

    def test_reply_and_thread_share_cooldown(self):
        topic = self.topic(self.admin)
        proof = self.normal.proof()
        self.ok(self.normal.request('POST', f'/api/threads/{topic["thread_id"]}/replies', data={
            'body': 'Ответ', **proof,
        }), 201)
        self.ok(self.raw_topic(self.normal, proof), 429)


    def test_parallel_sessions_cannot_take_the_same_posting_slot(self):
        first, second = Client(self.base), Client(self.base)
        for client in [first, second]:
            self.ok(client.post('/api/auth/login', {'username': 'normal', 'password': PASSWORD}))
        proofs = [first.proof(), second.proof()]
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.raw_topic, client, proof)
                       for client, proof in zip([first, second], proofs)]
            responses = [future.result() for future in futures]
        self.assertEqual(sorted(response[0] for response in responses), [201, 429])
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM posts').fetchone()[0], 1)
        db.close()

    def test_preissued_proof_cannot_skip_work_after_next_interval(self):
        first, second = Client(self.base), Client(self.base)
        for client in [first, second]:
            self.ok(client.post('/api/auth/login', {'username': 'normal', 'password': PASSWORD}))
        proof1, proof2 = first.proof(), second.proof()
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('UPDATE pow_challenges SET issued_at = ?', (int(time.time()) - 120,))
        db.close()
        self.ok(self.raw_topic(first, proof1), 201)
        # Simulate the end of the 30s interval; preserve the ordering of the old challenges.
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('UPDATE posting_limits SET last_post_at = ?', (int(time.time()) - 31,))
        db.close()
        error = self.ok(self.raw_topic(second, proof2), 422)
        self.assertEqual(error['error']['code'], 'pow_expired')
        self.ok(self.raw_topic(second, second.proof()), 201)


    def test_pow_checks_partial_zero_bits_not_just_whole_bytes(self):
        proof = self.guest.proof()
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('UPDATE pow_challenges SET difficulty = 13 WHERE id = ?', (proof['pow_id'],))
            prefix = db.execute('SELECT prefix FROM pow_challenges WHERE id = ?', (proof['pow_id'],)).fetchone()[0]
        db.close()
        good = bad = None
        nonce = 0
        while good is None or bad is None:
            digest = hashlib.sha256(f'{prefix}:{nonce}'.encode()).digest()
            if digest[0] == 0:
                if digest[1] >> 3 == 0:
                    good = str(nonce)
                else:
                    bad = str(nonce)
            nonce += 1
        error = self.ok(self.raw_topic(self.guest, {**proof, 'pow_nonce': bad}), 422)
        self.assertEqual(error['error']['code'], 'pow_invalid')
        self.ok(self.raw_topic(self.guest, {**proof, 'pow_nonce': good}), 201)

    def test_pow_issuance_csrf_and_rate_limit(self):
        self.ok(self.guest.request('POST', '/api/pow/challenge', data={}, headers={'X-CSRF-Token': 'bad'}), 403)
        for _ in range(20):
            self.ok(self.guest.post('/api/pow/challenge', {}))
        self.ok(self.guest.post('/api/pow/challenge', {}), 429)

    def test_error_languages_and_unchanged_user_content(self):
        for header, expected in [('en', 'Not found.'), ('en-GB,en;q=0.8', 'Not found.'),
                                 ('ru;q=0.9,en;q=0.2', 'Не найдено.'),
                                 ('de,en;q=0.8', 'Not found.'), ('en;q=0', 'Не найдено.'),
                                 ('unknown', 'Не найдено.'), ('ru', 'Не найдено.')]:
            response = self.guest.request('GET', '/api/unknown', headers={'Accept-Language': header})
            self.ok(response, 404)
            self.assertEqual(response[1]['error']['message'], expected)
            self.assertEqual(response[1]['error']['code'], 'not_found')
            self.assertEqual(response[2]['Content-Language'], 'en' if expected == 'Not found.' else 'ru')
        response = self.guest.request('POST', '/api/auth/login', data={'username': 'nobody', 'password': PASSWORD},
                                      headers={'Accept-Language': 'en'})
        self.ok(response, 401)
        self.assertEqual(response[1]['error']['message'], 'Incorrect username or password.')
        response = self.guest.request('POST', '/api/auth/login', data={'username': '', 'password': PASSWORD},
                                      headers={'Accept-Language': 'en'})
        self.ok(response, 422)
        self.assertEqual(response[1]['error']['message'], 'Field username: 1 to 32 UTF-8 bytes.')
        response = self.guest.request('POST', '/api/pow/challenge', data={},
                                      headers={'Accept-Language': 'en', 'X-CSRF-Token': 'bad'})
        self.ok(response, 403)
        self.assertIn('CSRF token', response[1]['error']['message'])
        response = self.guest.request('GET', '/api/sections', headers={'Accept-Language': 'en'})
        self.assertEqual(self.ok(response), self.ok(self.guest.get('/api/sections')))
        for client, path, method, expected in [(self.normal, '/api/moderation/queue', 'GET', 'Moderator permissions are required.'),
                                               (self.mod, '/api/sections', 'POST', 'Administrator permissions are required.')]:
            response = client.request(method, path, data={} if method == 'POST' else None,
                                           headers={'Accept-Language': 'en'})
            self.ok(response, 403)
            self.assertEqual(response[1]['error']['code'], 'forbidden')
            self.assertEqual(response[1]['error']['message'], expected)
        response = self.guest.request('POST', '/api/threads',
                                      data={'section_id': self.section, 'title': 'Title', 'body': 'Body'},
                                      headers={'Accept-Language': 'en'})
        self.ok(response, 422)
        self.assertEqual(response[1]['error']['message'], 'Compute the local hash proof before posting.')
        topic = self.topic(title='Опубликовано', body='Ожидает проверки — <b>без перевода</b>')
        path = f'/api/posts/{topic["post_id"]}'
        self.assertEqual(self.ok(self.guest.request('GET', path, headers={'Accept-Language': 'en'})),
                         self.ok(self.guest.get(path)))

    def test_move_threads_replies_permissions_and_links(self):
        a, b = self.topic(), self.topic(title='Destination')
        reply = self.ok(self.mod.post(f'/api/threads/{a["thread_id"]}/replies', {'body': 'Moved reply'}), 201)
        section = self.ok(self.admin.post('/api/sections', {'slug': 'other', 'title': 'Other'}), 201)['id']
        route = f'/api/posts/{a["post_id"]}/move'
        self.ok(self.normal.post(route, {'section_id': section, 'reason': 'test'}), 403)
        self.ok(self.mod.post(route, {'section_id': section}), 422)
        self.ok(self.mod.post(route, {'section_id': section, 'reason': 'Wrong section'}))
        self.assertEqual(self.ok(self.guest.get(f'/api/threads/{a["thread_id"]}'))['section_id'], section)
        self.ok(self.mod.post(f'/api/posts/{reply["post_id"]}/move', {'thread_id': b['thread_id'], 'reason': 'Wrong thread'}))
        self.assertEqual(self.ok(self.guest.get(f'/api/posts/{reply["post_id"]}'))['thread_id'], b['thread_id'])
        self.assertEqual(self.ok(self.guest.get(f'/api/threads/{a["thread_id"]}'))['replies']['items'], [])
        self.ok(self.mod.post(route, {'section_id': '1 OR 1=1', 'reason': 'bad'}), 422)
        self.ok(self.mod.post(f'/api/posts/{reply["post_id"]}/move', {'thread_id': b['thread_id'], 'reason': 'same'}), 422)
        self.assertEqual(len([e for e in self.ok(self.mod.get('/api/moderation/audit'))['items'] if e['action'] == 'post.move']), 2)

    def test_file_moderation_revokes_all_variants_and_purges(self):
        fields = {'section_id': self.section, 'title': 'Files', 'body': 'Post remains'}
        topic = self.ok(self.admin.upload('/api/threads', fields, [('wide.png', (self.fixtures / 'wide.png').read_bytes()), ('ok.txt', b'keep')]), 201)
        route = f'/api/posts/{topic["post_id"]}'
        file = self.ok(self.guest.get(route))['attachments'][0]
        action = f'/api/attachments/{file["id"]}/moderate'
        self.ok(self.normal.post(action, {'action': 'hide', 'reason': 'test'}), 403)
        self.ok(self.mod.request('POST', action, data={'action': 'hide', 'reason': 'test'}, headers={'X-CSRF-Token': 'bad'}), 403)
        for verb, state in [('spoiler', 1), ('unspoiler', 0)]:
            self.ok(self.mod.post(action, {'action': verb, 'reason': 'test'}))
            self.assertEqual(self.ok(self.guest.get(route))['attachments'][0]['spoiler'], state)
        self.ok(self.mod.post(action, {'action': 'hide', 'reason': 'test'}))
        self.assertEqual(len(self.ok(self.guest.get(route))['attachments']), 1)
        staff_file = self.ok(self.mod.get(route))['attachments'][0]
        self.assertEqual(staff_file['moderation_state'], 'hidden')
        self.assertIsNone(staff_file['download_url'])
        for url in [file['download_url'], file['preview_url'], file['view_url']]:
            self.ok(self.guest.get(url), 404)
            self.ok(self.mod.get(url), 404)
            self.ok(self.mod.request('HEAD', url), 404)
        self.ok(self.mod.post(action, {'action': 'show', 'reason': 'false positive'}))
        self.ok(self.guest.get(file['preview_url']))
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            stored = db.execute('SELECT storage_name FROM attachments WHERE id=?', [file['id']]).fetchone()[0]
        db.close()
        self.ok(self.mod.post(action, {'action': 'delete', 'reason': 'remove permanently'}))
        self.assertFalse((self.storage / 'uploads' / stored).exists())
        self.assertFalse((self.storage / 'previews' / (stored + '.jpg')).exists())
        self.ok(self.mod.post(action, {'action': 'show', 'reason': 'cannot restore'}), 409)
        self.assertEqual(self.ok(self.guest.get(route))['body'], 'Post remains')
        self.assertEqual(len(self.ok(self.guest.get(route))['attachments']), 1)

    def test_media_bans_exact_one_pixel_legacy_and_avatars(self):
        fields = {'section_id': self.section, 'title': 'Pattern', 'body': 'Synthetic fixture only'}
        pattern = (self.fixtures / 'pattern.png').read_bytes()
        pixel = (self.fixtures / 'pixel.png').read_bytes()
        topic = self.ok(self.admin.upload('/api/threads', fields, [('pattern.png', pattern), ('pixel.png', pixel)]), 201)
        files = self.ok(self.mod.get(f'/api/posts/{topic["post_id"]}'))['attachments']
        # Simulate an attachment from before the migration: hashes are indexed lazily.
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('UPDATE attachments SET sha256=NULL,dhash=NULL,ahash=NULL WHERE id=?', [files[1]['id']])
        db.close()
        self.ok(self.mod.post(f'/api/attachments/{files[0]["id"]}/moderate', {'action': 'hashban', 'reason': 'Synthetic test ban'}))
        self.assertEqual(self.ok(self.guest.get(f'/api/posts/{topic["post_id"]}'))['attachments'], [])
        for file in files:
            for key in ['download_url', 'view_url', 'preview_url']:
                self.ok(self.guest.get(file[key]), 404)
        for name, data in [('renamed.png', pattern), ('pixel.png', pixel)]:
            response = self.normal.upload('/api/threads', fields, [(name, data)])
            self.ok(response, 422)
            self.assertEqual(response[1]['error']['code'], 'media_banned')
        self.ok(self.normal.upload('/api/me/profile', {}, [('pixel.png', pixel)], file_field='avatar'), 422)
        self.ok(self.normal.upload('/api/threads', fields, [('other.png', (self.fixtures / 'other.png').read_bytes())]), 201)
        ban = self.ok(self.mod.get('/api/moderation/media-bans'))['items'][0]
        self.ok(self.normal.post(f'/api/moderation/media-bans/{ban["id"]}/remove', {'reason': 'no'}), 403)
        self.ok(self.mod.post(f'/api/moderation/media-bans/{ban["id"]}/remove', {'reason': 'False positive'}))
        self.ok(self.guest.get(files[1]['download_url']))
        self.ok(self.guest.get(files[0]['download_url']), 404)  # Hashban purged this original.

    def offline_cli(self, command, *args):
        # Run maintenance against an offline snapshot, as recommended in deployment docs.
        directory = tempfile.TemporaryDirectory(prefix='forbirds-cli-')
        self.addCleanup(directory.cleanup)
        target = Path(directory.name) / 'storage'
        shutil.copytree(self.storage, target, ignore=shutil.ignore_patterns('forum.sqlite*', 'server.log'))
        with sqlite3.connect(self.storage / 'forum.sqlite') as source, sqlite3.connect(target / 'forum.sqlite') as dest:
            source.backup(dest)
        source.close(); dest.close()
        result = subprocess.run(self.php + ['bin/console.php', command, *args], cwd=ROOT,
                                env={**self.env, 'FORBIRDS_STORAGE': str(target)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return target

    def test_exact_file_ban_survives_rename_and_purge_command(self):
        fields = {'section_id': self.section, 'title': 'Text', 'body': 'test'}
        topic = self.ok(self.admin.upload('/api/threads', fields, [('a.txt', b'Synthetic blocked bytes'), ('b.txt', b'Synthetic blocked bytes')]), 201)
        files = self.ok(self.mod.get(f'/api/posts/{topic["post_id"]}'))['attachments']
        self.ok(self.mod.post(f'/api/attachments/{files[0]["id"]}/moderate', {'action': 'hashban', 'reason': 'test'}))
        self.ok(self.normal.upload('/api/threads', fields, [('renamed.txt', b'Synthetic blocked bytes')]), 422)
        target = self.offline_cli('purge-banned-media')
        with sqlite3.connect(target / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT moderation_state FROM attachments WHERE id=?', [files[1]['id']]).fetchone()[0], 'deleted')

        db.close()
    def test_identity_privacy_gate_and_no_feed_leak(self):
        self.ok(self.admin.post('/api/moderation/privacy', {'enabled': False}))
        fp = 'a' * 64
        data = {'section_id': self.section, 'title': 'Identity', 'body': 'test', **self.normal.proof()}
        topic = self.ok(self.normal.request('POST', '/api/threads', data=data, headers={'X-ForBirds-Fingerprint': fp, 'X-Forwarded-For': '1.2.3.4'}), 201)
        route = f'/api/posts/{topic["post_id"]}/identity'
        self.ok(self.admin.get(route), 403)
        self.ok(self.mod.post('/api/moderation/privacy', {'enabled': True}), 403)
        self.ok(self.normal.post('/api/moderation/privacy', {'enabled': True}), 403)
        self.ok(self.admin.post('/api/moderation/privacy', {'enabled': True}))
        identity = self.ok(self.admin.get(route))
        self.assertEqual(identity['ip'], '127.0.0.1')
        self.assertRegex(identity['cid'], '^[a-f0-9]{64}$')
        self.assertRegex(identity['hid'], '^[a-f0-9]{64}$')
        self.assertNotEqual(identity['hid'], fp)
        self.ok(self.mod.get(route), 403)
        for client in [self.normal, self.mod, self.admin]:
            for path in [f'/api/posts/{topic["post_id"]}', '/api/threads', '/api/me/posts', '/api/moderation/queue']:
                response = client.get(path)
                serialized = json.dumps(response[1])
                for forbidden in ['author_ip', 'browser_id', 'fingerprint', identity['cid'], identity['hid'], '127.0.0.1']:
                    self.assertNotIn(forbidden, serialized)
        self.ok(self.admin.post('/api/moderation/privacy', {'enabled': False}))
        self.ok(self.admin.get(route), 403)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM privacy_access').fetchone()[0], 1)

        db.close()
    def test_identity_bans_browser_fingerprint_cidr_expiry_and_unban(self):
        topic = self.topic(self.normal)
        self.ok(self.admin.post('/api/moderation/privacy', {'enabled': True}))
        ban = self.ok(self.admin.post('/api/moderation/identity-bans', {'kind': 'browser', 'post_id': topic['post_id'], 'hours': 24, 'reason': 'spam'}))
        self.ok(self.normal.post('/api/pow/challenge', {}), 403)
        self.ok(Client(self.base).post('/api/pow/challenge', {}))  # Cookie ID is not a hardware ID.
        self.ok(self.admin.post(f'/api/moderation/identity-bans/{ban["id"]}/remove', {'reason': 'appeal'}))
        fp = 'b' * 64
        data = {'section_id': self.section, 'title': 'FP', 'body': 'test', **self.normal.proof(advance=True)}
        topic = self.ok(self.normal.request('POST', '/api/threads', data=data, headers={'X-ForBirds-Fingerprint': fp}), 201)
        ban = self.ok(self.admin.post('/api/moderation/identity-bans', {'kind': 'fingerprint', 'post_id': topic['post_id'], 'hours': 1, 'reason': 'spam'}))
        other = Client(self.base)
        self.ok(other.request('POST', '/api/pow/challenge', data={}, headers={'X-ForBirds-Fingerprint': fp}), 403)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('UPDATE identity_bans SET expires_at=0')
        db.close()
        self.ok(other.request('POST', '/api/pow/challenge', data={}, headers={'X-ForBirds-Fingerprint': fp}))
        self.ok(self.admin.post('/api/moderation/identity-bans', {'kind': 'cidr', 'value': '127.12.34.56/8', 'hours': 24, 'reason': 'network spam'}))
        self.ok(self.guest.post('/api/pow/challenge', {}), 403)
        self.ok(self.admin.post('/api/pow/challenge', {}))  # Staff recovery remains possible.
        self.ok(self.admin.post('/api/moderation/identity-bans', {'kind': 'cidr', 'value': '1.2.3.4/999', 'hours': 24, 'reason': 'bad'}), 422)
        bans = self.ok(self.admin.get('/api/moderation/identity-bans'))['items']
        self.assertIn('127.0.0.0/8', [b['value'] for b in bans])

    def test_bump_on_approval_sage_deletion_and_move(self):
        first, second = self.topic(), self.topic(title='Second')
        order = lambda: [item['id'] for item in self.ok(self.guest.get('/api/threads'))['items']]
        self.assertEqual(order(), [second['thread_id'], first['thread_id']])
        pending = self.ok(self.normal.post(f'/api/threads/{first["thread_id"]}/replies', {'body': 'Pending bump'}), 201)
        self.assertEqual(order()[0], second['thread_id'])
        self.moderate(pending['post_id'])
        self.assertEqual(order()[0], first['thread_id'])
        self.ok(self.mod.post(f'/api/threads/{second["thread_id"]}/replies', {'body': 'sage', 'sage': True}), 201)
        self.assertEqual(order()[0], first['thread_id'])
        self.moderate(pending['post_id'], 'unapprove')
        self.assertEqual(order()[0], second['thread_id'])
        self.moderate(pending['post_id'])
        self.assertEqual(order()[0], first['thread_id'])
        self.moderate(pending['post_id'], 'delete')
        self.assertEqual(order()[0], second['thread_id'])
        self.ok(self.guest.get('/api/moderation/archive'), 401)
        archive = self.ok(self.mod.get('/api/moderation/archive'))['items']
        self.assertEqual(archive[0]['id'], pending['post_id'])

    def test_cidr_math_and_retention(self):
        code = r'''require 'src/bootstrap.php';
            $tests = [['192.0.2.99/24','192.0.2.0/24'],['2001:db8:abcd::1/32','2001:db8::/32'],['::1','::1/128']];
            foreach ($tests as [$input,$expected]) if (ForBirds\AbuseIdentity::cidr($input) !== $expected) exit(2);
            foreach ([['2001:db8::/32','2001:db8:123::1',true],['2001:db8::/32','2001:db9::1',false],
                ['0.0.0.0/0','192.0.2.1',true],['127.0.0.0/8','::1',false]] as [$range,$ip,$expected]) {
                if (ForBirds\AbuseIdentity::contains($range,$ip) !== $expected) exit(3);
            }'''
        result = subprocess.run(self.php + ['-r', code], cwd=ROOT, env=self.env, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        topic = self.topic(self.normal)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute("UPDATE posts SET created_at='2000-01-01T00:00:00Z'")
        db.close()
        target = self.offline_cli('prune-identities')
        with sqlite3.connect(target / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT author_ip,browser_id,fingerprint FROM posts WHERE id=?', [topic['post_id']]).fetchone(), (None, None, None))

        db.close()
    def test_sqli_regression_payloads_are_literals_not_queries(self):
        payload = "' OR 1=1; --"
        response = self.guest.post('/api/auth/login', {'username': payload, 'password': PASSWORD})
        self.ok(response, 401)
        for key in ['section_id', 'page', 'limit']:
            self.ok(self.guest.get('/api/threads?' + urllib.parse.urlencode({key: payload})), 422)
        a = self.topic(title=payload, body="'); DROP TABLE users; --")
        self.topic(title='Unrelated')
        found = self.ok(self.guest.get('/api/threads?' + urllib.parse.urlencode({'q': payload})))['items']
        self.assertEqual([t['id'] for t in found], [a['thread_id']])
        self.assertEqual(self.ok(self.guest.get(f'/api/posts/{a["post_id"]}'))['body'], "'); DROP TABLE users; --")
        self.ok(self.admin.get('/api/session'))


    def test_profile_moderation_permissions_locks_and_clearing(self):
        uid = self.ids['normal']
        self.ok(self.normal.upload('/api/me/profile', {'description': 'Original biography'},
                                   [('pattern.png', (self.fixtures / 'pattern.png').read_bytes())], file_field='avatar'))
        endpoint = f'/api/users/{uid}/profile/moderate'
        self.ok(self.normal.post(endpoint, {'action': 'description_delete', 'reason': 'no access'}), 403)
        self.ok(self.mod.request('POST', endpoint, data={'action': 'description_delete', 'reason': 'csrf'}, headers={'X-CSRF-Token': 'bad'}), 403)
        self.ok(self.mod.post(endpoint, {'action': 'description_delete'}), 422)
        for target in [self.ids['moderator'], self.ok(self.admin.get('/api/session'))['user']['id']]:
            self.ok(self.mod.post(f'/api/users/{target}/profile/moderate', {'action': 'description_delete', 'reason': 'protected'}), 403)
        profile = self.ok(self.normal.get(f'/api/users/{uid}'))
        old_avatar = profile['avatar_url']
        self.ok(self.mod.post(endpoint, {'action': 'avatar_lock', 'reason': 'avatar abuse'}))
        self.ok(self.mod.post(endpoint, {'action': 'description_lock', 'reason': 'bio abuse'}))
        self.ok(self.normal.post('/api/me/profile', {'description': 'Changed'}), 403)
        self.ok(self.normal.post('/api/me/profile', {'remove_avatar': True}), 403)
        self.ok(self.normal.upload('/api/me/profile', {}, [('other.png', (self.fixtures / 'other.png').read_bytes())], file_field='avatar'), 403)
        self.ok(self.normal.post('/api/me/profile', {'flag_file': ''}))
        self.assertEqual(self.ok(self.guest.get(f'/api/users/{uid}'))['description'], 'Original biography')
        self.ok(self.mod.post(endpoint, {'action': 'avatar_delete', 'reason': 'remove'}))
        self.ok(self.mod.post(endpoint, {'action': 'description_delete', 'reason': 'remove'}))
        self.ok(self.guest.get(old_avatar), 404)
        self.assertEqual(self.ok(self.guest.get(f'/api/users/{uid}'))['description'], '')
        self.assertEqual(self.ok(self.guest.get(f'/api/users/{uid}'))['avatar_url'], '/avatars/noavatar.png')
        for field in ['avatar', 'description']:
            self.ok(self.mod.post(endpoint, {'action': field + '_unlock', 'reason': 'appeal'}))
        self.ok(self.normal.post('/api/me/profile', {'description': 'Allowed again'}))
        self.ok(self.normal.upload('/api/me/profile', {}, [('other.png', (self.fixtures / 'other.png').read_bytes())], file_field='avatar'))
        actions = [entry['action'] for entry in self.ok(self.mod.get('/api/moderation/audit'))['items']]
        self.assertIn('profile.avatar_delete', actions)
        self.assertIn('profile.description_unlock', actions)

    def test_avatar_hashban_blocks_uploads_and_existing_copies(self):
        uid = self.ids['normal']
        image = (self.fixtures / 'pattern.png').read_bytes()
        profile = self.ok(self.normal.upload('/api/me/profile', {}, [('a.png', image)], file_field='avatar'))
        avatar_bytes = self.ok(self.guest.get(profile['avatar_url']))
        fields = {'section_id': self.section, 'title': 'Shared image', 'body': 'Synthetic only'}
        topic = self.ok(self.admin.upload('/api/threads', fields, [('same.jpg', avatar_bytes)]), 201)
        attachment = self.ok(self.mod.get(f'/api/posts/{topic["post_id"]}'))['attachments'][0]
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            name = db.execute('SELECT avatar_name FROM users WHERE id=?', [uid]).fetchone()[0]
        db.close()
        self.ok(self.mod.post(f'/api/users/{uid}/profile/moderate', {'action': 'avatar_hashban', 'reason': 'Synthetic fixture ban'}))
        self.assertFalse((self.storage / 'avatars' / (name + '.jpg')).exists())
        for path in [profile['avatar_url'], attachment['view_url'], attachment['download_url'], attachment['preview_url']]:
            self.ok(self.guest.get(path), 404)
        self.ok(self.normal.upload('/api/me/profile', {}, [('same.png', image)], file_field='avatar'), 422)
        self.ok(self.normal.upload('/api/me/profile', {}, [('same.jpg', avatar_bytes)], file_field='avatar'), 422)
        self.ok(self.normal.upload('/api/threads', fields, [('same.jpg', avatar_bytes)]), 422)
        self.assertEqual(len(self.ok(self.mod.get('/api/moderation/media-bans'))['items']), 1)

    def test_description_hashban_normalization_existing_copies_and_unban(self):
        uid = self.ids['normal']
        text = 'Запрещённое описание'
        self.ok(self.normal.post('/api/me/profile', {'description': text}))
        self.ok(self.trusted.post('/api/me/profile', {'description': text.upper()}))
        endpoint = f'/api/users/{uid}/profile/moderate'
        self.ok(self.mod.post(endpoint, {'action': 'description_hashban', 'reason': 'Text spam'}))
        for target in [uid, self.ids['trusted']]:
            self.assertEqual(self.ok(self.guest.get(f'/api/users/{target}'))['description'], '')
        self.assertEqual(self.ok(self.trusted.get('/api/session'))['user']['description'], '')
        for variant in [text, text.upper(), '  Запрещённое\n\tописание ', 'Запрещённое\u200bописание']:
            response = self.normal.post('/api/me/profile', {'description': variant})
            self.ok(response, 422)
            self.assertEqual(response[1]['error']['code'], 'description_banned')
        self.ok(self.normal.post('/api/me/profile', {'description': 'Completely different text'}))
        ban = self.ok(self.mod.get('/api/moderation/description-bans'))['items'][0]
        self.assertNotIn('text_hash', ban)
        self.ok(self.normal.post(f'/api/moderation/description-bans/{ban["id"]}/remove', {'reason': 'no'}), 403)
        self.ok(self.mod.post(f'/api/moderation/description-bans/{ban["id"]}/remove', {'reason': 'appeal'}))
        self.ok(self.normal.post('/api/me/profile', {'description': text}))
        self.ok(self.mod.post(endpoint, {'action': 'description_delete', 'reason': 'clear'}))
        self.ok(self.mod.post(endpoint, {'action': 'description_hashban', 'reason': 'empty'}), 422)

    def test_hidden_blocked_posts_revoke_all_public_surfaces(self):
        self.trust(True)
        fields = {'section_id': self.section, 'title': 'Restriction root', 'body': 'Root needle'}
        topic = self.ok(self.trusted.upload('/api/threads', fields, [('a.txt', b'Safe text')]), 201)
        reply = self.ok(self.normal.post(f'/api/threads/{topic["thread_id"]}/replies', {'body': 'uniquereplyneedle'}), 201)
        self.moderate(reply['post_id'])
        file = self.ok(self.guest.get(f'/api/posts/{topic["post_id"]}'))['attachments'][0]
        root_route = f'/api/posts/{topic["post_id"]}/restrict'
        self.ok(self.normal.post(root_route, {'action': 'hide', 'reason': 'no'}), 403)
        self.ok(self.mod.post(root_route, {'action': 'hide'}), 422)
        # An approved hidden reply must not affect counts, search, profile or bump.
        self.ok(self.mod.post(f'/api/posts/{reply["post_id"]}/restrict', {'action': 'hide', 'reason': 'hide reply'}))
        self.assertEqual(self.ok(self.guest.get('/api/threads?q=uniquereplyneedle'))['items'], [])
        self.assertEqual(self.ok(self.guest.get('/api/threads'))['items'][0]['reply_count'], 0)
        self.assertEqual(self.ok(self.normal.get('/api/me/posts'))['items'], [])
        for action, reverse in [('hide', 'unhide'), ('block', 'unblock')]:
            self.ok(self.mod.post(root_route, {'action': action, 'reason': 'Restrict root'}))
            for client in [self.guest, self.normal, self.trusted]:
                for path in [f'/api/threads/{topic["thread_id"]}', f'/api/posts/{topic["post_id"]}',
                             f'/api/posts/{reply["post_id"]}', file['download_url']]:
                    self.ok(client.get(path), 404)
                self.assertEqual(self.ok(client.get('/api/threads'))['items'], [])
                self.assertEqual(self.ok(client.get(f'/api/users/{self.ids["trusted"]}/posts'))['items'], [])
                sections = self.ok(client.get('/api/sections'))
                self.assertEqual(sections[0]['recent_posts'], [])
            self.ok(self.mod.get(f'/api/posts/{topic["post_id"]}'))
            self.ok(self.guest.request('HEAD', file['download_url']), 404)
            self.ok(self.guest.request('GET', file['download_url'], headers={'Range': 'bytes=0-2'}), 404)
            if action == 'block':
                self.ok(self.mod.post(f'/api/posts/{topic["post_id"]}/moderate', {'action': 'approve'}), 409)
            self.ok(self.mod.post(root_route, {'action': reverse, 'reason': 'appeal'}))
        self.ok(self.guest.get(f'/api/threads/{topic["thread_id"]}'))
        self.ok(self.mod.post(f'/api/posts/{reply["post_id"]}/restrict', {'action': 'unhide', 'reason': 'appeal'}))
        self.assertEqual(self.ok(self.guest.get('/api/threads'))['items'][0]['reply_count'], 1)
        self.assertEqual(len(self.ok(self.mod.get('/api/moderation/restricted'))['items']), 0)
        # Block also holds a pending post against approval and author visibility.
        pending = self.topic(self.normal)
        self.ok(self.mod.post(f'/api/posts/{pending["post_id"]}/restrict', {'action': 'block', 'reason': 'hold'}))
        self.ok(self.normal.get(f'/api/posts/{pending["post_id"]}'), 404)
        self.ok(self.mod.post(f'/api/posts/{pending["post_id"]}/moderate', {'action': 'approve'}), 409)

    def test_migration_006_updates_legacy_flag_references(self):
        path = self.storage / 'legacy-flag-names.sqlite'
        mapping = {"'apeson.png": 'apeson.png', 'Cyber Israel.png': 'Cyber-Israel.png',
                   'Gem Pass.png': 'Gem-Pass.png', 'Great Britain.png': 'Great-Britain.png',
                   'I was raped.png': 'I-was-raped.png'}
        with sqlite3.connect(path) as db:
            for migration in sorted((ROOT / 'database/migrations').glob('*.sql')):
                if migration.name.startswith('006_'):
                    for i, name in enumerate(mapping):
                        db.execute('INSERT INTO users(username,password_hash,flag_file) VALUES (?,?,?)', [f'flag_{i}', 'not-used', name])
                db.executescript(migration.read_text())
            self.assertEqual([row[0] for row in db.execute('SELECT flag_file FROM users ORDER BY id')], list(mapping.values()))
        db.close()

    def test_renamed_flags_are_discovered_and_keep_bytes(self):
        flags = {item['file']: item for item in self.ok(self.guest.get('/api/flags'))}
        for name, label in [('apeson.png', "'apeson"), ('Cyber-Israel.png', 'Cyber Israel'), ('Gem-Pass.png', 'Gem Pass'),
                            ('Great-Britain.png', 'Great Britain'), ('I-was-raped.png', 'I was raped')]:
            self.assertIn(name, flags)
            self.assertEqual(flags[name]['label'], label)
            self.assertEqual(self.ok(self.guest.get(flags[name]['url'])), (ROOT / 'public' / 'flags' / name).read_bytes())
        self.ok(self.normal.post('/api/me/profile', {'flag_file': 'Great-Britain.png'}))
        self.assertEqual(self.ok(self.guest.get(f'/api/users/{self.ids["normal"]}'))['flag']['file'], 'Great-Britain.png')

    def test_flash_upload_validation_visibility_and_moderation(self):
        fields = {'section_id': self.section, 'title': 'Flash upload', 'body': 'Flash body'}
        for compressed in [False, True]:
            data = flash_fixture(compressed)
            root = self.ok(self.normal.upload('/api/threads', fields, [('movie.SWF', data)]), 201)
            file = self.ok(self.admin.get(f'/api/posts/{root["post_id"]}'))['attachments'][0]
            self.assertTrue(file['is_flash'])
            self.assertFalse(file['is_video'] or file['is_audio'] or file['is_image'])
            self.assertIsNone(file['preview_url'])
            self.ok(self.guest.get(file['view_url']), 404)
            self.ok(self.admin.get(file['view_url']))
            self.moderate(root['post_id'])
            response = self.guest.get(file['view_url'])
            self.assertEqual(self.ok(response), data)
            self.assertEqual(response[2]['Content-Type'], 'application/octet-stream')
            self.assertTrue(response[2]['Content-Disposition'].startswith('attachment;'))
            self.assertIn("default-src 'none'", response[2]['Content-Security-Policy'])
            self.assertEqual(self.ok(self.guest.request('GET', file['view_url'], headers={'Range': 'bytes=0-7'}), 206), data[:8])
            self.ok(self.guest.request('HEAD', file['view_url']))
            self.ok(self.guest.get(f'/api/attachments/{file["id"]}/preview'), 404)
            self.ok(self.mod.post(f'/api/attachments/{file["id"]}/moderate', {'action': 'hide', 'reason': 'hide SWF'}))
            for client in [self.guest, self.admin]:
                self.ok(client.get(file['view_url']), 404)
                self.ok(client.get(file['download_url']), 404)
            self.ok(self.mod.post(f'/api/attachments/{file["id"]}/moderate', {'action': 'show', 'reason': 'restore SWF'}))
            self.ok(self.mod.post(f'/api/posts/{root["post_id"]}/restrict', {'action': 'hide', 'reason': 'hide parent'}))
            self.ok(self.guest.get(file['view_url']), 404)
            self.ok(self.mod.post(f'/api/attachments/{file["id"]}/moderate', {'action': 'hashban', 'reason': 'SWF exact ban'}))
            self.ok(self.admin.get(file['view_url']), 404)
            self.ok(self.admin.upload('/api/threads', fields, [('renamed.swf', data)]), 422)

    def test_flash_rejects_fake_truncated_lzma_and_inflation_bombs(self):
        fields = {'section_id': self.section, 'title': 'Bad Flash', 'body': 'test'}
        movie = flash_fixture()
        bad = [b'<script>alert(1)</script>', movie[:-1], movie + b'extra',
               b'ZWS' + movie[3:], b'FWS' + b'\0' + movie[4:],
               b'CWS\x08' + struct.pack('<I', 33 * 1024 * 1024) + zlib.compress(b'x' * 1024),
               b'CWS\x08' + struct.pack('<I', 32) + zlib.compress(b'x' * 100000),
               b'FWS\x08' + struct.pack('<I', len(movie)) + b'\xff' * (len(movie) - 8)]
        for data in bad:
            self.ok(self.normal.upload('/api/threads', fields, [('bad.swf', data)]), 422)
        self.ok(self.normal.upload('/api/threads', fields, [('wrong.png', movie)]), 422)
        self.ok(self.normal.upload('/api/threads', fields, [('wrong.txt', movie)]), 422)
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM attachments').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM posts').fetchone()[0], 0)
        db.close()

    def test_flash_player_static_isolation_and_local_runtime(self):
        response = self.guest.get('/flash-player.html')
        self.ok(response)
        csp = response[2]['Content-Security-Policy']
        for rule in ["sandbox allow-scripts", "frame-ancestors 'self'", "object-src 'none'", "form-action 'none'", "'wasm-unsafe-eval'"]:
            self.assertIn(rule, csp)
        self.assertNotIn('allow-same-origin', csp)
        self.assertIsNone(response[2].get('Access-Control-Allow-Origin'))
        self.assertNotIn('wasm-unsafe-eval', self.guest.get('/')[2]['Content-Security-Policy'])
        for path in (ROOT / 'public/vendor/ruffle').glob('*'):
            if path.suffix not in ['.wasm', '.js']: continue
            response = self.guest.request('HEAD', '/vendor/ruffle/' + path.name)
            self.ok(response)
            self.assertEqual(response[2]['Access-Control-Allow-Origin'], '*')
            if path.suffix == '.wasm': self.assertTrue(response[2]['Content-Type'].startswith('application/wasm'))
        self.ok(self.guest.get('/vendor/ruffle/ruffle.js.map'), 404)
        self.ok(self.guest.get('/vendor/ruffle/unknown.js'), 404)

    @unittest.skipUnless(os.environ.get('FORBIRDS_BROWSER') == '1', 'optional browser test; see README')
    def test_browser_flash_sections(self):
        root = self.ok(self.admin.upload('/api/threads', {'section_id': self.section, 'title': 'Ruffle local movie', 'body': 'Flash'},
                       [('movie.swf', flash_fixture(actions=True)), ('spoiler.swf', flash_fixture(True))]), 201)
        file = self.ok(self.guest.get(f'/api/posts/{root["post_id"]}'))['attachments'][0]
        with sqlite3.connect(self.storage / 'forum.sqlite') as db:
            db.execute('UPDATE attachments SET spoiler=1 WHERE post_id=? AND id!=?', [root['post_id'], file['id']])
        db.close()
        second = self.ok(self.admin.post('/api/sections', {'slug': 'second-sidebar', 'title': 'Second sidebar section'}), 201)['id']
        result = subprocess.run(['node', 'tests/test_flash_sections_browser.cjs'], cwd=ROOT,
                                env={**os.environ, 'FORBIRDS_TEST_URL': self.base,
                                     'FORBIRDS_FLASH_FIXTURE': json.dumps({'root': root, 'file': file, 'section': self.section, 'second': second})},
                                text=True, capture_output=True, timeout=150)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_static_layouts_assets_and_private_path_allowlist(self):
        for path in ['/', '/index.html', '/post.html?id=1', '/dashboard.html', '/profile.html', '/app.js', '/presentation.js', '/markdown.js', '/moderation.js', '/ujutnenko.js', '/i18n.js', '/en.js', '/pow-worker.js', '/sha256.js', '/general.css', '/avatars/noavatar.png']:
            response = self.guest.get(path)
            self.ok(response)
            self.assertIn("script-src 'self'", response[2]['Content-Security-Policy'])
        for path in ['/src/PostingGuard.php', '/storage/app.key', '/static/preview/spolier.png-autosave.kra', '/static/../index.php', '/public/index.html']:
            self.ok(self.guest.get(path), 404)

    @unittest.skipUnless(os.environ.get('FORBIRDS_BROWSER') == '1', 'optional browser test; see README')
    def test_browser_presentation_emoji(self):
        root = self.topic(self.normal, title='Public presentation topic', body='Public text :like:')
        self.moderate(root['post_id'])
        pending = self.topic(self.normal, title='PRIVATE-PRESENTATION-PENDING', body='PRIVATE-PRESENTATION-PENDING-BODY')
        restricted = self.topic(title='PRIVATE-PRESENTATION-HIDDEN', body='PRIVATE-PRESENTATION-HIDDEN-BODY')
        self.ok(self.mod.post(f'/api/posts/{restricted["post_id"]}/restrict', {'action': 'hide', 'reason': 'PRIVATE-PRESENTATION-REASON'}))
        result = subprocess.run(['node', 'tests/test_presentation_emoji_browser.cjs'], cwd=ROOT,
                                env={**os.environ, 'FORBIRDS_TEST_URL': self.base, 'FORBIRDS_TEST_PASSWORD': PASSWORD,
                                     'FORBIRDS_PRESENTATION_FIXTURE': json.dumps({'root': root, 'pending': pending, 'restricted': restricted, 'user_id': self.ids['normal']})},
                                text=True, capture_output=True, timeout=120)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(os.environ.get('FORBIRDS_BROWSER') == '1', 'optional browser test; see README')
    def test_browser_falseflag_markdown(self):
        result = subprocess.run(['node', 'tests/test_falseflag_markdown_browser.cjs'], cwd=ROOT,
                                env={**os.environ, 'FORBIRDS_TEST_URL': self.base, 'FORBIRDS_TEST_PASSWORD': PASSWORD,
                                     'FORBIRDS_FALSEFLAG_FIXTURE': json.dumps({'target': self.ids['normal']})},
                                text=True, capture_output=True, timeout=100)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(os.environ.get('FORBIRDS_BROWSER') == '1', 'optional browser test; see README')
    def test_browser_network_reactions(self):
        images = self.reaction_images()
        root = self.topic()
        result = subprocess.run(['node', 'tests/test_network_reactions_browser.cjs'], cwd=ROOT,
                                env={**os.environ, 'FORBIRDS_TEST_URL': self.base, 'FORBIRDS_TEST_PASSWORD': PASSWORD,
                                     'FORBIRDS_TEST_DB': str(self.storage / 'forum.sqlite'),
                                     'FORBIRDS_REACTION_FIXTURE': json.dumps({'root': root, 'images': images})},
                                text=True, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(os.environ.get('FORBIRDS_BROWSER') == '1', 'optional browser test; see README')
    def test_browser_moderation_tools(self):
        a = self.ok(self.admin.upload('/api/threads', {'section_id': self.section, 'title': 'Files', 'body': 'Browser root'},
                                     [('pattern.png', (self.fixtures / 'pattern.png').read_bytes())]), 201)
        b = self.topic(title='Destination')
        reply = self.ok(self.mod.post(f'/api/threads/{a["thread_id"]}/replies', {'body': 'Move this reply'}), 201)
        deleted = self.ok(self.mod.post(f'/api/threads/{a["thread_id"]}/replies', {'body': 'Deleted reply'}), 201)
        self.moderate(deleted['post_id'], 'delete')
        pending = self.topic(self.normal)
        section = self.ok(self.admin.post('/api/sections', {'slug': 'other', 'title': 'Other section'}), 201)['id']
        file = self.ok(self.mod.get(f'/api/posts/{a["post_id"]}'))['attachments'][0]
        self.ok(self.normal.upload('/api/me/profile', {'description': 'Browser profile spam'}, [('other.png', (self.fixtures / 'other.png').read_bytes())], file_field='avatar'))
        result = subprocess.run(['node', 'tests/test_moderation_browser.cjs'], cwd=ROOT,
                                env={**os.environ, 'FORBIRDS_TEST_URL': self.base, 'FORBIRDS_TEST_PASSWORD': PASSWORD,
                                     'FORBIRDS_MODERATION_FIXTURE': json.dumps({'a': a, 'b': b, 'reply': reply,
                                          'pending': pending, 'deleted': deleted, 'file_id': file['id'], 'section_id': section, 'profile_id': self.ids['normal']})},
                                text=True, capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    @unittest.skipUnless(os.environ.get('FORBIRDS_BROWSER') == '1', 'optional browser test; see README')
    def test_browser_forms_pow_and_moderation(self):
        result = subprocess.run(['node', 'tests/test_browser.cjs'], cwd=ROOT,
                                env={**os.environ, 'FORBIRDS_TEST_URL': self.base,
                                     'FORBIRDS_TEST_PASSWORD': PASSWORD, 'FORBIRDS_TEST_FIXTURES': str(self.fixtures)}, text=True,
                                capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
