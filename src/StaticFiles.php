<?php
declare(strict_types=1);

namespace ForBirds;

final class StaticFiles
{
    public static function serve(string $method, string $path): bool
    {
        if (!in_array($method, ['GET', 'HEAD'], true)) {
            return false;
        }
        $file = $path === '/' ? '/index.html' : $path;
        $pages = ['/index.html', '/post.html', '/dashboard.html', '/profile.html', '/general.css', '/app.css', '/app.js', '/pow-worker.js', '/sha256.js'];
        if (!in_array($file, $pages, true)
            && !preg_match('~\A/flags/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.(?i:png|gif|jpe?g|webp)\z~', $file)
            && !preg_match('~\A/(?:avatars|icons|static)/[a-zA-Z0-9/_-]+\.(?:png|jpg|jpeg|gif|webp|ico)\z~', $file)) {
            return false;
        }
        if (str_starts_with($file, '/flags/') && !(new FlagCatalog())->find(substr($file, 7))) {
            return false;
        }
        $root = realpath(dirname(__DIR__) . '/public');
        $resolved = realpath($root . $file);
        if (!$resolved || !str_starts_with($resolved, $root . DIRECTORY_SEPARATOR) || !is_file($resolved)) {
            return false;
        }
        $types = ['html' => 'text/html', 'css' => 'text/css', 'js' => 'text/javascript',
            'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
            'webp' => 'image/webp', 'ico' => 'image/x-icon'];
        header('Content-Type: ' . $types[strtolower(pathinfo($resolved, PATHINFO_EXTENSION))] . '; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-cache');
        header('Referrer-Policy: same-origin');
        $ancestors = getenv('FORBIRDS_ALLOW_EMBED') === '1' ? '' : "; frame-ancestors 'none'";
        header("Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" . $ancestors);
        if ($method !== 'HEAD') {
            readfile($resolved);
        }
        return true;
    }
}
