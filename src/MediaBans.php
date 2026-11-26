<?php
declare(strict_types=1);

namespace ForBirds;

use PDO;
use RuntimeException;

/** Local denylist matching, not a content classifier. Images: first decoded frame only. */
final class MediaBans
{
    public function __construct(private PDO $db) {}

    public static function hashes(string $path, string $mime): array
    {
        $sha = hash_file('sha256', $path);
        if ($sha === false) throw new RuntimeException('Cannot hash file.');
        $result = ['sha256' => $sha, 'dhash' => null, 'ahash' => null];
        if (!ImagePreview::isImage($mime)) return $result;
        $info = @getimagesize($path);
        if (!$info || ($info['mime'] ?? '') !== $mime || $info[0] < 1 || $info[1] < 1
            || max($info[0], $info[1]) > 12000 || $info[0] * $info[1] > 40000000) {
            throw new ApiError(422, 'invalid_image', 'Изображение повреждено или превышает допустимые размеры.');
        }
        $limit = ini_parse_quantity(ini_get('memory_limit'));
        if ($limit > 0 && $info[0] * $info[1] * 10 + 16 * 1024 * 1024 > $limit - memory_get_usage(true)) {
            throw new ApiError(413, 'image_memory_limit', 'Для обработки изображения недостаточно памяти. Уменьшите его размеры.');
        }
        $decoder = ['image/jpeg' => 'imagecreatefromjpeg', 'image/png' => 'imagecreatefrompng',
            'image/gif' => 'imagecreatefromgif', 'image/webp' => 'imagecreatefromwebp'][$mime];
        if (!function_exists($decoder)) throw new ApiError(503, 'image_processing_unavailable', 'Для превью включите PHP GD с поддержкой JPEG, PNG, GIF и WebP.');
        $image = @$decoder($path);
        if (!$image) throw new ApiError(422, 'invalid_image', 'Не удалось декодировать изображение.');
        $gray = static function (int $color): float {
            return (($color >> 16) & 255) * .299 + (($color >> 8) & 255) * .587 + ($color & 255) * .114;
        };
        $sample = static function (int $width) use ($image, $gray): array {
            $small = imagecreatetruecolor($width, 16);
            imagefill($small, 0, 0, imagecolorallocate($small, 255, 255, 255));
            imagecopyresampled($small, $image, 0, 0, 0, 0, $width, 16, imagesx($image), imagesy($image));
            $pixels = [];
            for ($y = 0; $y < 16; $y++) for ($x = 0; $x < $width; $x++) $pixels[] = $gray(imagecolorat($small, $x, $y));
            return $pixels;
        };
        $pack = static function (array $bits): string {
            $hex = '';
            for ($i = 0; $i < count($bits); $i += 4) {
                $hex .= dechex(($bits[$i] << 3) | ($bits[$i + 1] << 2) | ($bits[$i + 2] << 1) | $bits[$i + 3]);
            }
            return $hex;
        };
        $pixels = $sample(17); $bits = [];
        for ($y = 0; $y < 16; $y++) for ($x = 0; $x < 16; $x++) $bits[] = (int) ($pixels[$y * 17 + $x] > $pixels[$y * 17 + $x + 1]);
        $result['dhash'] = $pack($bits);
        $pixels = $sample(16); $mean = array_sum($pixels) / 256;
        $result['ahash'] = $pack(array_map(static fn ($v) => (int) ($v > $mean), $pixels));
        return $result;
    }

    public static function distance(string $a, string $b): int
    {
        if (strlen($a) !== 64 || strlen($b) !== 64 || !ctype_xdigit($a . $b)) return 256;
        $distance = 0;
        $counts = [0,1,1,2,1,2,2,3,1,2,2,3,2,3,3,4];
        for ($i = 0; $i < 64; $i++) $distance += $counts[hexdec($a[$i]) ^ hexdec($b[$i])];
        return $distance;
    }

    public function matches(array $hashes): bool
    {
        // Exact check uses an index; approximate comparison runs only for images.
        $stmt = $this->db->prepare('SELECT id FROM media_bans WHERE sha256 = ?');
        $stmt->execute([$hashes['sha256']]);
        if ($stmt->fetch()) return true;
        if (!$hashes['dhash'] || !$hashes['ahash']) return false;
        foreach ($this->db->query('SELECT dhash,ahash FROM media_bans WHERE dhash IS NOT NULL AND ahash IS NOT NULL') as $ban) {
            if (self::distance($hashes['dhash'], $ban['dhash']) <= 8 && self::distance($hashes['ahash'], $ban['ahash']) <= 12) return true;
        }
        return false;
    }

    public function check(array $hashes): void
    {
        if ($this->matches($hashes)) throw new ApiError(422, 'media_banned', 'Файл заблокирован: совпадение с запрещённым материалом.');
    }
}
