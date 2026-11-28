<?php
declare(strict_types=1);

// Run once per minute under the deployment user (cron/systemd). Never invoke from HTTP.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
umask(0077);
$config = require dirname(__DIR__) . '/src/bootstrap.php';
try {
    $code = (new ForBirds\SiteUpdater($config))->run();
    if ($code !== 0) fwrite(STDERR, "Site update stopped. Inspect the private storage/site-update state and log.\n");
    exit($code);
} catch (Throwable $error) {
    fwrite(STDERR, "Site updater unavailable: " . $error->getMessage() . "\n");
    exit(1);
}
