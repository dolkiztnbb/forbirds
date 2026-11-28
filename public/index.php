<?php
declare(strict_types=1);

use ForBirds\Api;
use ForBirds\ApiError;
use ForBirds\Database;

$config = require dirname(__DIR__) . '/src/bootstrap.php';
ini_set('display_errors', '0');
if (\ForBirds\StaticFiles::serve($_SERVER['REQUEST_METHOD'], parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH) ?: '/')) {
    exit;
}
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');
header('Content-Language: ' . \ForBirds\Language::current());
header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'");
header('Referrer-Policy: no-referrer');

try {
    $requestPath = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
    $controlRead = $_SERVER['REQUEST_METHOD'] === 'GET' && in_array($requestPath, ['/api/session', '/api/admin/update'], true);
    if (!$controlRead) {
        try { $updateRequestLock = (new \ForBirds\SiteUpdater($config))->enterRequest(); }
        catch (RuntimeException) { throw new ApiError(503, 'maintenance', 'Сайт обновляется. Повторите запрос позже.'); }
    }
    if (!is_file($config['database']) || !is_file($config['storage'] . '/app.key')) {
        throw new ApiError(503, 'not_installed', 'Сначала выполните php bin/console.php install.');
    }
    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.save_path', $config['storage'] . '/sessions');
    session_name('forbirds_session');
    session_set_cookie_params([
        'lifetime' => 0, 'path' => '/', 'secure' => $config['secure_cookie'],
        'httponly' => true, 'samesite' => 'Lax',
    ]);
    session_start();
    $_SESSION['csrf'] ??= bin2hex(random_bytes(32));
    $api = new Api(Database::connect($config['database']), $config);
    $data = $api->dispatch($_SERVER['REQUEST_METHOD'], parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH));
    echo json_encode(['data' => \ForBirds\AbuseIdentity::redact($data)], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
} catch (ApiError $e) {
    http_response_code($e->status);
    if ($e->status === 405) {
        header('Allow: GET, POST');
    }
    if ($e->status === 429) {
        header('Retry-After: ' . ($e->retryAfter ?? 60));
    }
    echo json_encode(['error' => ['code' => $e->errorCode, 'message' => \ForBirds\Language::error($e->getMessage()), 'retry_after' => $e->retryAfter]], JSON_UNESCAPED_UNICODE);
} catch (Throwable $e) {
    error_log((string) $e);
    http_response_code(500);
    echo json_encode(['error' => ['code' => 'internal_error', 'message' => \ForBirds\Language::error('Внутренняя ошибка сервера.')]], JSON_UNESCAPED_UNICODE);
}
