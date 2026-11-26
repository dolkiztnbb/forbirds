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
            $im = imagecreatetruecolor(32,16); imagepng($im,$dir.'small.png');'''
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
        for filename in ['sample.mp4', 'sample.webm']:
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
            for table in ['attachments', 'posts', 'threads', 'sections', 'audit_log', 'rate_limits', 'posting_limits', 'pow_challenges']:
                db.execute(f'DELETE FROM {table}')
            db.execute("UPDATE users SET description = '', avatar_name = NULL, flag_file = NULL")
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
            self.assertEqual(db.execute('SELECT count(*) FROM migrations').fetchone()[0], 4)
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

    def test_static_layouts_assets_and_private_path_allowlist(self):
        for path in ['/', '/index.html', '/post.html?id=1', '/dashboard.html', '/profile.html', '/app.js', '/pow-worker.js', '/sha256.js', '/general.css', '/avatars/noavatar.png']:
            response = self.guest.get(path)
            self.ok(response)
            self.assertIn("script-src 'self'", response[2]['Content-Security-Policy'])
        for path in ['/src/PostingGuard.php', '/storage/app.key', '/static/preview/spolier.png-autosave.kra', '/static/../index.php', '/public/index.html']:
            self.ok(self.guest.get(path), 404)

    @unittest.skipUnless(os.environ.get('FORBIRDS_BROWSER') == '1', 'optional browser test; see README')
    def test_browser_forms_pow_and_moderation(self):
        result = subprocess.run(['node', 'tests/test_browser.cjs'], cwd=ROOT,
                                env={**os.environ, 'FORBIRDS_TEST_URL': self.base,
                                     'FORBIRDS_TEST_PASSWORD': PASSWORD, 'FORBIRDS_TEST_FIXTURES': str(self.fixtures)}, text=True,
                                capture_output=True, timeout=90)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == '__main__':
    unittest.main(verbosity=2)
