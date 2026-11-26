<?php
declare(strict_types=1);

namespace ForBirds;

use RuntimeException;

/** Streams an already-authorized attachment, including single byte ranges used by audio/video players. */
final class MediaFile
{
    public static function isVideo(string $mime): bool
    {
        return in_array($mime, ['video/mp4', 'video/webm'], true);
    }

    /** MIME/extension pairs only: never treat arbitrary octet-stream data as audio. */
    public const AUDIO_TYPES = [
        'audio/mpeg' => ['mp3', 'mp2'], 'audio/mp3' => ['mp3'],
        'audio/flac' => ['flac'], 'audio/x-flac' => ['flac'],
        'audio/wav' => ['wav'], 'audio/x-wav' => ['wav'], 'audio/vnd.wave' => ['wav'],
        'audio/ogg' => ['ogg', 'oga', 'opus'], 'application/ogg' => ['ogg', 'oga', 'opus'],
        'audio/opus' => ['opus'],
        'audio/mp4' => ['m4a', 'm4b'], 'audio/x-m4a' => ['m4a', 'm4b'],
        // fileinfo can identify the MP4 container rather than its audio track.
        'video/mp4' => ['m4a', 'm4b'],
        'audio/aac' => ['aac'], 'audio/x-aac' => ['aac'], 'audio/x-hx-aac-adts' => ['aac'],
        'audio/aiff' => ['aif', 'aiff'], 'audio/x-aiff' => ['aif', 'aiff'],
        'audio/x-ms-wma' => ['wma'], 'video/x-ms-asf' => ['wma'],
        'audio/webm' => ['weba'], 'video/webm' => ['weba'],
    ];

    public static function isAudio(string $mime, string $name): bool
    {
        return in_array(strtolower(pathinfo($name, PATHINFO_EXTENSION)), self::AUDIO_TYPES[$mime] ?? [], true);
    }

    public static function playbackMime(string $mime, string $name): string
    {
        if (!self::isAudio($mime, $name)) return $mime;
        return match ($mime) {
            'video/mp4', 'audio/x-m4a' => 'audio/mp4',
            'video/webm' => 'audio/webm',
            'video/x-ms-asf' => 'audio/x-ms-wma',
            'application/ogg' => 'audio/ogg',
            'audio/x-wav', 'audio/vnd.wave' => 'audio/wav',
            'audio/x-flac' => 'audio/flac',
            'audio/x-hx-aac-adts', 'audio/x-aac' => 'audio/aac',
            default => $mime,
        };
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
