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
        $pages = ['/favicon.ico','/index.html', '/post.html', '/dashboard.html', '/profile.html', '/general.css', '/app.css', '/app.js', '/markdown.js', '/presentation.js', '/section-state.js', '/flash-player.html', '/flash-player.js', '/flash-player.css', '/ujutnenko.js', '/moderation.js', '/i18n.js', '/en.js', '/pow-worker.js', '/sha256.js'];
        $ruffle = in_array($file, ['/vendor/ruffle/ruffle.js', '/vendor/ruffle/ruffle_web-wasm_mvp_bg.UMWKJ7EM.wasm', '/vendor/ruffle/ruffle_web_bg.QDRSAAAZ.wasm'], true);
        if (!$ruffle && !in_array($file, $pages, true)
            && !preg_match('~\A/flags/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.(?i:png|gif|jpe?g|webp)\z~', $file)
            && !preg_match('~\A/static/reactions/[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.(?i:png|gif|jpe?g|webp)\z~', $file)
            && !preg_match('~\A/(?:avatars|icons|static)/[a-zA-Z0-9/_-]+\.(?:png|jpg|jpeg|gif|webp|ico)\z~', $file)) {
            return false;
        }
        if (str_starts_with($file, '/flags/') && !(new FlagCatalog())->find(substr($file, 7))) {
            return false;
        }
        if (str_starts_with($file, '/static/reactions/') && !(new ReactionCatalog())->find(substr($file, strlen('/static/reactions/')))) {
            return false;
        }
        $root = realpath(dirname(__DIR__) . '/public');
        $resolved = realpath($root . $file);
        if (!$resolved || !str_starts_with($resolved, $root . DIRECTORY_SEPARATOR) || !is_file($resolved)) {
            return false;
        }
        $types = ['html' => 'text/html', 'css' => 'text/css', 'js' => 'text/javascript',
            'png' => 'image/png', 'jpg' => 'image/jpeg', 'jpeg' => 'image/jpeg', 'gif' => 'image/gif',
            'webp' => 'image/webp', 'ico' => 'image/x-icon', 'wasm' => 'application/wasm'];
        header('Content-Type: ' . $types[strtolower(pathinfo($resolved, PATHINFO_EXTENSION))] . '; charset=utf-8');
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-cache');
        header('Referrer-Policy: same-origin');
        if ($ruffle) {
            // Only public runtime assets allow CORS, for the opaque sandbox's WASM loader.
            header('Access-Control-Allow-Origin: *');
        }
        if ($file === '/flash-player.html') {
            header("Content-Security-Policy: default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src data: blob:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts");
        } else {
            $ancestors = getenv('FORBIRDS_ALLOW_EMBED') === '1' ? '' : "; frame-ancestors 'none'";
            header("Content-Security-Policy: default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; media-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'" . $ancestors);
        }
        if ($method !== 'HEAD') {
            readfile($resolved);
        }
        return true;
    }
}
