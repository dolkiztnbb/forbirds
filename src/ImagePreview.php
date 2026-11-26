<?php
declare(strict_types=1);

namespace ForBirds;

use RuntimeException;

/** Private, metadata-free JPEG thumbnails; originals (including animated GIFs) stay untouched. */
final class ImagePreview
{
    public function __construct(private string $storage) {}

    public static function isImage(string $mime): bool
    {
        return in_array($mime, ['image/jpeg', 'image/png', 'image/gif', 'image/webp'], true);
    }

    public function path(string $name): string
    {
        if (!preg_match('/\A[a-f0-9]{48}\z/', $name)) {
            throw new RuntimeException('Invalid internal image name.');
        }
        return $this->storage . '/previews/' . $name . '.jpg';
    }

    public function ensure(string $source, string $name, string $mime): string
    {
        $target = $this->path($name);
        if (is_file($target)) {
            return $target;
        }
        $decoders = ['image/jpeg' => 'imagecreatefromjpeg', 'image/png' => 'imagecreatefrompng',
            'image/gif' => 'imagecreatefromgif', 'image/webp' => 'imagecreatefromwebp'];
        $decoder = $decoders[$mime] ?? '';
        if (!$decoder || !function_exists($decoder) || !function_exists('imagejpeg')) {
            throw new ApiError(503, 'image_processing_unavailable', 'Для превью включите PHP GD с поддержкой JPEG, PNG, GIF и WebP.');
        }
        $info = @getimagesize($source);
        if (!$info || ($info['mime'] ?? '') !== $mime || $info[0] < 1 || $info[1] < 1
            || $info[0] > 12000 || $info[1] > 12000 || $info[0] * $info[1] > 40000000) {
            throw new ApiError(422, 'invalid_image', 'Изображение повреждено или превышает допустимые размеры.');
        }
        // Leave room for GD's decoded pixels, resampling and PHP overhead rather than risking a fatal OOM.
        $limit = ini_parse_quantity(ini_get('memory_limit'));
        if ($limit > 0 && $info[0] * $info[1] * 10 + 16 * 1024 * 1024 > $limit - memory_get_usage(true)) {
            throw new ApiError(413, 'image_memory_limit', 'Для обработки изображения недостаточно памяти. Уменьшите его размеры.');
        }
        $image = @$decoder($source);
        if (!$image) {
            throw new ApiError(422, 'invalid_image', 'Не удалось декодировать изображение.');
        }
        $scale = min(1, 256 / max($info[0], $info[1]));
        $width = max(1, (int) floor($info[0] * $scale));
        $height = max(1, (int) floor($info[1] * $scale));
        $thumbnail = imagecreatetruecolor($width, $height);
        imagefill($thumbnail, 0, 0, imagecolorallocate($thumbnail, 255, 255, 255));
        imagecopyresampled($thumbnail, $image, 0, 0, 0, 0, $width, $height, $info[0], $info[1]);
        unset($image);
        $directory = dirname($target);
        if (!is_dir($directory) && !@mkdir($directory, 0700, true) && !is_dir($directory)) {
            throw new RuntimeException('Cannot create private preview directory.');
        }
        $tmp = tempnam($directory, '.preview-');
        if ($tmp === false) {
            throw new RuntimeException('Cannot create preview file.');
        }
        try {
            if (!imagejpeg($thumbnail, $tmp, 85)) {
                throw new RuntimeException('Cannot encode preview.');
            }
            chmod($tmp, 0600);
            // Concurrent lazy requests can finish together; Windows does not replace an existing target.
            if (!@rename($tmp, $target) && !is_file($target)) {
                throw new RuntimeException('Cannot publish preview.');
            }
        } finally {
            unset($thumbnail);
            if (is_file($tmp)) {
                unlink($tmp);
            }
        }
        return $target;
    }
}
