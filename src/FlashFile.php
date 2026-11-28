<?php
declare(strict_types=1);

namespace ForBirds;

/** Bounded container validation, not a promise that a movie is safe or compatible. */
final class FlashFile
{
    public const MIME = 'application/x-shockwave-flash';
    public const MAX_INFLATED_BYTES = 32 * 1024 * 1024;

    public static function isFlash(string $mime, string $name): bool
    {
        return in_array($mime, [self::MIME, 'application/vnd.adobe.flash.movie'], true)
            && strtolower(pathinfo($name, PATHINFO_EXTENSION)) === 'swf';
    }

    public static function validate(string $path): bool
    {
        $data = file_get_contents($path);
        if ($data === false || strlen($data) < 15) return false;
        $signature = substr($data, 0, 3);
        $version = ord($data[3]);
        $length = unpack('V', substr($data, 4, 4))[1];
        if ($version < 1 || $version > 50 || $length < 15 || $length > self::MAX_INFLATED_BYTES) return false;
        if ($signature === 'FWS') {
            if ($length !== strlen($data)) return false;
            $body = substr($data, 8);
        } elseif ($signature === 'CWS' && $version >= 6) {
            $body = @gzuncompress(substr($data, 8), $length - 8);
            if ($body === false || strlen($body) !== $length - 8) return false;
        } else {
            // LZMA (ZWS) is deliberately not accepted without a bounded LZMA decoder.
            return false;
        }
        $rectBytes = (int) ceil((5 + 4 * (ord($body[0]) >> 3)) / 8);
        $offset = $rectBytes + 4; // RECT, frame rate, frame count.
        $size = strlen($body);
        while ($offset + 2 <= $size) {
            $tag = unpack('v', substr($body, $offset, 2))[1];
            $offset += 2;
            $tagLength = $tag & 63;
            if ($tagLength === 63) {
                if ($offset + 4 > $size) return false;
                $tagLength = unpack('V', substr($body, $offset, 4))[1];
                $offset += 4;
            }
            if ($tagLength > $size - $offset) return false;
            $offset += $tagLength;
            if (($tag >> 6) === 0) return $tagLength === 0 && $offset === $size;
        }
        return false;
    }
}
