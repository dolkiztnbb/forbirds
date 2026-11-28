<?php
declare(strict_types=1);
namespace ForBirds;

/** Operator-owned raster banners. No uploads, SVG, symlinks or external URLs. */
final class BannerRotation
{
    private ?array $catalog = null;
    public function __construct(private string $storage, private string $directory = __DIR__ . '/../public/static/banners') {}

    public function all(): array
    {
        if ($this->catalog !== null) return $this->catalog;
        $this->catalog = [];
        if (!is_dir($this->directory) || is_link($this->directory)) return [];
        $types = ['png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif', 'webp' => 'image/webp', 'avif' => 'image/avif'];
        foreach (scandir($this->directory) ?: [] as $name) {
            if (strlen($name) > 200 || $name[0] === '.' || preg_match('/[\x00-\x1f\x7f\/\\\\]/', $name) || !preg_match('//u', $name)) continue;
            $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
            $path = $this->directory . '/' . $name;
            if (!isset($types[$extension]) || is_link($path) || !is_file($path) || filesize($path) > 10 * 1024 * 1024) continue;
            $info = @getimagesize($path);
            if (!$info || $info['mime'] !== $types[$extension] || $info[0] > 8000 || $info[1] > 4000) continue;
            $this->catalog[$name] = ['url' => '/static/banners/' . rawurlencode($name), 'mime' => $info['mime']];
            if (count($this->catalog) >= 256) break;
        }
        return $this->catalog;
    }

    public function current(int $now): array
    {
        $minute = intdiv($now, 60);
        $result = ['url' => '/static/banner.png', 'server_time' => $now, 'next_change_at' => ($minute + 1) * 60];
        $catalog = $this->all();
        if (!$catalog) return $result;
        $lock = fopen($this->storage . '/banner-rotation.lock', 'c');
        if (!$lock || !flock($lock, LOCK_EX)) throw new \RuntimeException('Cannot lock banner rotation.');
        try {
            $path = $this->storage . '/banner-rotation.json';
            $previous = is_file($path) ? json_decode(file_get_contents($path), true) : [];
            $name = $previous['file'] ?? null;
            if (($previous['minute'] ?? null) !== $minute || !isset($catalog[$name])) {
                $names = array_keys($catalog); $attempt = 0;
                do {
                    $index = hexdec(substr(hash('sha256', $minute . ':' . $attempt++), 0, 8)) % count($names);
                    $selected = $names[$index];
                } while (count($names) > 1 && $selected === $name && $attempt < 256);
                if (count($names) > 1 && $selected === $name) $selected = $names[($index + 1) % count($names)];
                $name = $selected;
                if (file_put_contents($path, json_encode(['minute' => $minute, 'file' => $name], JSON_THROW_ON_ERROR), LOCK_EX) === false) throw new \RuntimeException('Cannot save banner rotation.');
                chmod($path, 0600);
            }
            return array_replace($result, ['url' => $catalog[$name]['url']]);
        } finally { fclose($lock); }
    }
}
