<?php
declare(strict_types=1);

namespace ForBirds;

use PDO;

/** Exact normalized text denylist; no semantic similarity claims or stored originals. */
final class TextBans
{
    public static function hash(string $text): string
    {
        $text = preg_replace('/[\p{Z}\s\x{200B}-\x{200D}\x{FEFF}]+/u', ' ', $text);
        return hash('sha256', mb_strtolower(trim($text), 'UTF-8'));
    }

    public static function matches(PDO $db, string $text): bool
    {
        if ($text === '') return false;
        $statement = $db->prepare('SELECT id FROM description_bans WHERE text_hash = ?');
        $statement->execute([self::hash($text)]);
        return (bool) $statement->fetch();
    }
}
