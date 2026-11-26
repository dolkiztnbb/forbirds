<?php
declare(strict_types=1);

namespace ForBirds;

/** Flags are discovered from files, not from the optional translation dictionary. */
final class FlagCatalog
{
    private ?array $items = null;

    public function __construct(private string $directory = __DIR__ . '/../public/flags') {}

    public function all(): array
    {
        if ($this->items !== null) {
            return $this->items;
        }
        $this->items = [];
        $root = realpath($this->directory);
        if (!$root || !is_dir($root)) {
            return [];
        }
        $labels = [];
        $dictionary = $root . '/flags.json';
        if (is_file($dictionary) && !is_link($dictionary) && filesize($dictionary) <= 1024 * 1024) {
            $decoded = json_decode(file_get_contents($dictionary), true);
            if (is_array($decoded)) {
                $labels = $decoded;
            }
        }
        foreach (scandir($root) ?: [] as $file) {
            if (!preg_match('/\A([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})\.(png|gif|jpe?g|webp)\z/i', $file, $match)) {
                continue;
            }
            $path = $root . '/' . $file;
            if (!is_file($path) || is_link($path)) {
                continue;
            }
            $info = @getimagesize($path);
            if (!$info || !ImagePreview::isImage($info['mime'] ?? '')) {
                continue;
            }
            $code = $match[1];
            $label = $labels[$code] ?? null;
            $label = is_string($label) && trim($label) !== '' ? trim($label) : $code;
            $this->items[$file] = ['file' => $file, 'code' => $code, 'label' => $label, 'url' => '/flags/' . rawurlencode($file)];
        }
        ksort($this->items, SORT_NATURAL | SORT_FLAG_CASE);
        return $this->items;
    }

    public function find(?string $file): ?array
    {
        return $file !== null ? ($this->all()[$file] ?? null) : null;
    }
}
