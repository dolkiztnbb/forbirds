"""Banner catalog, deterministic minute selection and repeat avoidance (no external assets)."""
import base64
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=')


class BannerTests(unittest.TestCase):
    def php(self, directory, code):
        result = subprocess.run(shlex.split(os.environ.get('PHP_BIN', 'php')) + ['-r',
            "require 'src/BannerRotation.php'; $b = new \\ForBirds\\BannerRotation(getenv('BANNER_TEST'), getenv('BANNER_TEST').'/images'); " + code],
            cwd=ROOT, env={**os.environ, 'BANNER_TEST': str(directory)}, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
        self.assertEqual(result.stderr, '')
        return json.loads(result.stdout)

    def test_empty_single_and_rehashed_minute(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            images = root / 'images'
            images.mkdir()
            result = self.php(root, 'echo json_encode($b->current(12345));')
            self.assertEqual(result, {'url': '/static/banner.png', 'server_time': 12345, 'next_change_at': 12360})
            (images / 'one.png').write_bytes(PNG)
            result = self.php(root, 'echo json_encode([$b->current(12000), $b->current(12059), $b->current(12060)]);')
            self.assertEqual({item['url'] for item in result}, {'/static/banners/one.png'})
            (images / 'two.png').write_bytes(PNG)
            (images / 'баннер 3.PNG').write_bytes(PNG)
            result = self.php(root, '$rows=[]; for ($m=202;$m<402;$m++) { $a=$b->current($m*60); $rows[]=[$a,$b->current($m*60+59)]; } echo json_encode($rows);')
            previous = '/static/banners/one.png'
            for first, again in result:
                self.assertNotEqual(first['url'], previous)
                self.assertEqual(first['url'], again['url'])
                previous = first['url']
            self.assertTrue(any('%20' in first['url'] for first, _ in result))
            # If the current file disappears, the same minute selects a valid replacement.
            from urllib.parse import unquote
            (images / unquote(previous.split('/')[-1])).unlink()
            current = self.php(root, 'echo json_encode($b->current(401*60));')
            self.assertNotEqual(current['url'], previous)

    def test_catalog_rejects_unsafe_and_fake_images(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); images = root / 'images'; images.mkdir()
            for name in ['safe.png', 'space name.PNG', '.hidden.png', 'control\n.png']:
                (images / name).write_bytes(PNG)
            (images / 'fake.jpg').write_bytes(PNG)
            (images / 'fake.png').write_text('<?php echo "not an image";')
            (images / 'vector.svg').write_text('<svg/>')
            (images / 'link.png').symlink_to(images / 'safe.png')
            (images / 'folder.png').mkdir()
            result = self.php(root, 'echo json_encode($b->all());')
            self.assertEqual(set(result), {'safe.png', 'space name.PNG'})
            self.assertEqual(result['space name.PNG']['url'], '/static/banners/space%20name.PNG')
            self.assertEqual(result['safe.png']['mime'], 'image/png')
