<?php
declare(strict_types=1);

namespace ForBirds;

use PDO;
use Throwable;

final class Database
{
    public static function connect(string $path): PDO
    {
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ];
        $db = method_exists(PDO::class, 'connect')
            ? PDO::connect('sqlite:' . $path, null, null, $options)
            : new PDO('sqlite:' . $path, null, null, $options);
        $db->exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
        $lower = static fn (string $value): string => mb_strtolower($value, 'UTF-8');
        if (method_exists($db, 'createFunction')) {
            $db->createFunction('unicode_lower', $lower, 1, \Pdo\Sqlite::DETERMINISTIC);
        } else {
            $db->sqliteCreateFunction('unicode_lower', $lower, 1, PDO::SQLITE_DETERMINISTIC);
        }
        return $db;
    }

    public static function migrate(PDO $db): void
    {
        $db->exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY)');
        foreach (glob(dirname(__DIR__) . '/database/migrations/*.sql') as $file) {
            $name = basename($file);
            $check = $db->prepare('SELECT name FROM migrations WHERE name = ?');
            $check->execute([$name]);
            if ($check->fetch()) {
                continue;
            }
            $db->beginTransaction();
            try {
                $db->exec(file_get_contents($file));
                $db->prepare('INSERT INTO migrations(name) VALUES (?)')->execute([$name]);
                $db->commit();
            } catch (Throwable $e) {
                $db->rollBack();
                throw $e;
            }
        }
    }
}
