<?php
declare(strict_types=1);

namespace ForBirds;

/** Operator-provided raster images only; reactions are not uploaded by visitors. */
final class ReactionCatalog
{
    private ?array $items = null;
    public function __construct(private string $directory = __DIR__ . '/../public/static/reactions') {}

    public function all(): array
    {
        if ($this->items !== null) return $this->items;
        $this->items = [];
        $root = realpath($this->directory);
        if (!$root || !is_dir($root)) return [];
        $labels = [];
        $dictionary = $root . '/reactions.json';
        if (is_file($dictionary) && !is_link($dictionary) && filesize($dictionary) <= 65536) {
            $decoded = json_decode(file_get_contents($dictionary), true);
            if (is_array($decoded)) $labels = $decoded;
        }
        foreach (scandir($root) ?: [] as $file) {
            if (!preg_match('/\A([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.(png|gif|jpe?g|webp)\z/i', $file, $m)) continue;
            $path = $root . '/' . $file;
            if (is_link($path) || !is_file($path) || filesize($path) > 2 * 1024 * 1024) continue;
            $info = @getimagesize($path);
            if (!$info || !ImagePreview::isImage($info['mime'] ?? '') || $info[0] > 512 || $info[1] > 512) continue;
            $label = $labels[$m[1]] ?? $m[1];
            if (!is_string($label) || trim($label) === '' || mb_strlen($label) > 100) $label = $m[1];
            $this->items[$file] = ['file' => $file, 'label' => $label, 'url' => '/static/reactions/' . rawurlencode($file)];
            if (count($this->items) >= 128) break;
        }
        return $this->items;
    }

    public function find(string $file): ?array { return $this->all()[$file] ?? null; }
}
