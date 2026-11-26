<?php
declare(strict_types=1);

namespace ForBirds;

use RuntimeException;

/** Streams an already-authorized attachment, including single byte ranges used by video players. */
final class MediaFile
{
    public static function isVideo(string $mime): bool
    {
        return in_array($mime, ['video/mp4', 'video/webm'], true);
    }

    public static function send(string $path, string $mime, string $disposition, string $name): never
    {
        $stream = @fopen($path, 'rb');
        if (!$stream) {
            throw new RuntimeException('Cannot open attachment.');
        }
        $size = fstat($stream)['size'];
        $head = ($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD';
        header('Content-Type: ' . $mime);
        header('Accept-Ranges: bytes');
        header("Content-Disposition: $disposition; filename=\"download\"; filename*=UTF-8''" . rawurlencode($name));
        $start = 0;
        $end = $size - 1;
        // Without a matching validator, If-Range requires a full representation.
        $range = !$head && !isset($_SERVER['HTTP_IF_RANGE']) ? ($_SERVER['HTTP_RANGE'] ?? null) : null;
        if ($range !== null) {
            $valid = strlen($range) <= 200 && preg_match('/\Abytes=([0-9]*)-([0-9]*)\z/D', $range, $m)
                && ($m[1] !== '' || $m[2] !== '');
            if ($valid) {
                if ($m[1] === '') {
                    $length = (int) $m[2];
                    $valid = $length > 0;
                    $start = max(0, $size - $length);
                } else {
                    $start = (int) $m[1];
                    $end = $m[2] === '' ? $size - 1 : min((int) $m[2], $size - 1);
                }
                $valid = $valid && $start < $size && $end >= $start;
            }
            if (!$valid) {
                fclose($stream);
                http_response_code(416);
                header('Content-Range: bytes */' . $size);
                header('Content-Length: 0');
                exit;
            }
            http_response_code(206);
            header("Content-Range: bytes $start-$end/$size");
        }
        $remaining = $end - $start + 1;
        header('Content-Length: ' . $remaining);
        if (!$head) {
            fseek($stream, $start);
            while ($remaining > 0 && !feof($stream) && !connection_aborted()) {
                $chunk = fread($stream, min(65536, $remaining));
                if ($chunk === false || $chunk === '') {
                    break;
                }
                echo $chunk;
                $remaining -= strlen($chunk);
            }
        }
        fclose($stream);
        exit;
    }
}
