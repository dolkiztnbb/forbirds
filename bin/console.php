<?php
declare(strict_types=1);

use ForBirds\Database;

if (PHP_SAPI !== 'cli') {
    http_response_code(404);
    exit;
}
$config = require dirname(__DIR__) . '/src/bootstrap.php';
try {
    $command = $argv[1] ?? '';
    if (!in_array($command, ['install', 'migrate', 'create-admin'], true)) {
        throw new RuntimeException("Команды: install | migrate | create-admin USERNAME (пароль через stdin)");
    }
    umask(0077);
    foreach (['', '/sessions', '/uploads'] as $directory) {
        $path = $config['storage'] . $directory;
        if (!is_dir($path) && !mkdir($path, 0700, true)) {
            throw new RuntimeException('Не удалось создать ' . $path);
        }
    }
    $keyPath = $config['storage'] . '/app.key';
    if (!is_file($keyPath)) {
        file_put_contents($keyPath, bin2hex(random_bytes(32)), LOCK_EX);
    }
    chmod($keyPath, 0600);
    $db = Database::connect($config['database']);
    chmod($config['database'], 0600);
    Database::migrate($db);
    if ($command === 'create-admin') {
        $username = $argv[2] ?? '';
        if (!preg_match('/\A[a-zA-Z0-9_]{3,32}\z/', $username)) {
            throw new RuntimeException('Имя: 3–32 латинских буквы, цифры или _.');
        }
        fwrite(STDERR, "Пароль (12–72 байта), ввод через stdin:\n");
        $password = rtrim(fgets(STDIN) ?: '', "\r\n");
        if (strlen($password) < 12 || strlen($password) > 72 || str_contains($password, "\0")) {
            throw new RuntimeException('Неверная длина пароля.');
        }
        $db->prepare("INSERT INTO users(username,password_hash,role) VALUES (?,?,'admin')")
            ->execute([$username, password_hash($password, PASSWORD_DEFAULT)]);
        echo "Администратор создан.\n";
    } else {
        echo "База данных готова.\n";
    }
} catch (Throwable $e) {
    fwrite(STDERR, $e->getMessage() . "\n");
    exit(1);
}
