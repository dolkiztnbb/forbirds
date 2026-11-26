<?php
declare(strict_types=1);

require_once __DIR__ . '/Database.php';
require_once __DIR__ . '/Api.php';
require_once __DIR__ . '/PostingGuard.php';
require_once __DIR__ . '/StaticFiles.php';

// No secrets or database files live under public/.
$storage = getenv('FORBIRDS_STORAGE') ?: dirname(__DIR__) . '/storage';
return [
    'storage' => $storage,
    'database' => $storage . '/forum.sqlite',
    'secure_cookie' => getenv('FORBIRDS_SECURE_COOKIE') !== '0',
    'pow_difficulty' => max(8, min(24, (int) (getenv('FORBIRDS_POW_DIFFICULTY') ?: 18))),
    'max_file_bytes' => 5 * 1024 * 1024,
    'max_post_bytes' => 20 * 1024 * 1024,
];
