<?php
declare(strict_types=1);

namespace ForBirds;

/** Conditional reads only AFTER normal dispatch, authorization and redaction. Never a shared data cache. */
final class PostCache
{
    public static function eligible(string $method, string $path): bool
    {
        return $method === 'GET' && (bool) preg_match('~^/api/(?:posts/[1-9][0-9]*|threads(?:/[1-9][0-9]*)?)$~D', $path);
    }

    public static function tag(string $json, string $sessionScope, string $language, bool $publicView): string
    {
        return '"' . hash_hmac('sha256', $language . ':' . (int) $publicView . ':' . $json, $sessionScope) . '"';
    }

    public static function matches(string $condition, string $tag): bool
    {
        // GET If-None-Match uses weak comparison. Ignore malformed tags instead of returning a false 304.
        foreach (explode(',', $condition) as $candidate) {
            $candidate = trim($candidate);
            if ($candidate === '*' || $candidate === $tag || $candidate === 'W/' . $tag) return true;
        }
        return false;
    }
}
