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
    if (!in_array($command, ['install', 'migrate', 'create-admin', 'prune-identities', 'reindex-media', 'purge-banned-media', 'import-network-list', 'network-status', 'remove-network-ban'], true)) {
        throw new RuntimeException("Команды: install | migrate | create-admin USERNAME | prune-identities | reindex-media | purge-banned-media | import-network-list tor|i2p FILE | network-status | remove-network-ban ID REASON");
    }
    umask(0077);
    foreach (['', '/sessions', '/uploads', '/previews', '/avatars'] as $directory) {
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
    if ($command === 'import-network-list') {
        $count = ForBirds\NetworkAccess::import($db, $argv[2] ?? '', $argv[3] ?? '');
        echo "Imported $count network entries.\n";
    } elseif ($command === 'network-status') {
        foreach (['tor', 'i2p'] as $source) {
            $stmt = $db->prepare('SELECT count(*) AS total,max(imported_at) AS updated FROM network_ranges WHERE source=?');
            $stmt->execute([$source]); $row = $stmt->fetch();
            echo $source . ': ' . $row['total'] . ' entries; updated: ' . ($row['updated'] ? gmdate('c', (int) $row['updated']) : 'NEVER') . "\n";
            if (!$row['updated'] || time() - (int) $row['updated'] > 86400) echo "WARNING: list missing or older than 24 hours.\n";
        }
        echo "Active write restrictions (private operator output):\n";
        foreach ($db->query('SELECT id,kind,value,source,reason FROM network_write_bans ORDER BY id') as $ban) echo json_encode($ban, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR) . "\n";
    } elseif ($command === 'remove-network-ban') {
        if (!ctype_digit($argv[2] ?? '') || !ForBirds\NetworkAccess::removeBan($db, (int) $argv[2], $argv[3] ?? '', null)) throw new RuntimeException('Ban not found or invalid ID.');
        echo "Network write ban removed.\n";
    } elseif ($command === 'prune-identities') {
        $db->prepare("UPDATE posts SET author_ip=NULL,browser_id=NULL,fingerprint=NULL WHERE created_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')")->execute();
        $db->prepare('DELETE FROM privacy_access WHERE created_at < ?')->execute([time() - 30 * 86400]);
        $db->prepare('DELETE FROM identity_bans WHERE expires_at <= ?')->execute([time()]);
        echo "Old identity records removed.\n";
    } elseif (in_array($command, ['reindex-media', 'purge-banned-media'], true)) {
        $screening = new ForBirds\MediaBans($db);
        $cursor = $db->query("SELECT * FROM attachments WHERE moderation_state != 'deleted'");
        while ($file = $cursor->fetch()) {
            $path = $config['storage'] . '/uploads/' . $file['storage_name'];
            if (!is_file($path)) continue;
            $hashes = ForBirds\MediaBans::hashes($path, $file['mime_type']);
            $db->prepare('UPDATE attachments SET sha256=?,dhash=?,ahash=? WHERE id=?')->execute([
                $hashes['sha256'], $hashes['dhash'], $hashes['ahash'], $file['id']]);
            if ($command === 'purge-banned-media' && $screening->matches($hashes)) {
                $db->prepare("UPDATE attachments SET moderation_state='deleted' WHERE id=?")->execute([$file['id']]);
                foreach ([$path, (new ForBirds\ImagePreview($config['storage']))->path($file['storage_name'])] as $remove) {
                    if (is_file($remove) && !unlink($remove)) throw new RuntimeException('Cannot purge media.');
                }
            }
        }
        if ($command === 'purge-banned-media') {
            foreach ($db->query('SELECT id,avatar_name FROM users WHERE avatar_name IS NOT NULL') as $user) {
                $path = (new ForBirds\ImagePreview($config['storage'], 'avatars'))->path($user['avatar_name']);
                if (is_file($path) && $screening->matches(ForBirds\MediaBans::hashes($path, 'image/jpeg'))) {
                    $db->prepare('UPDATE users SET avatar_name=NULL WHERE id=?')->execute([$user['id']]);
                    if (!unlink($path)) throw new RuntimeException('Cannot purge avatar.');
                }
            }
        }
        echo "Media processing complete.\n";
    } elseif ($command === 'create-admin') {
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
