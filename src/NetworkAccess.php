<?php
declare(strict_types=1);

namespace ForBirds;

use PDO;
use RuntimeException;
use Throwable;

/** Read-only network policy, based only on server-controlled signals. Never trusts HTTP headers or UA. */
final class NetworkAccess
{
    private ?string $source = null;

    public function __construct(private PDO $db, private AbuseIdentity $identity, private ?array $user)
    {
        // A FastCGI parameter (NOT HTTP_*) on a dedicated Tor/I2P ingress, or pool environment.
        $marker = $_SERVER['FORBIRDS_ACCESS_NETWORK'] ?? getenv('FORBIRDS_ACCESS_NETWORK');
        if (in_array($marker, ['tor', 'i2p'], true)) {
            $this->source = $marker;
        } elseif ($identity->ip !== null) {
            $exact = $db->prepare("SELECT 1 FROM network_ranges WHERE source='tor' AND cidr=?");
            $exact->execute([AbuseIdentity::cidr($identity->ip)]);
            if ($exact->fetchColumn()) { $this->source = 'tor'; return; }
            foreach ($db->query("SELECT source,cidr FROM network_ranges WHERE source='i2p'") as $range) {
                if (AbuseIdentity::contains($range['cidr'], $identity->ip)) {
                    $this->source = $range['source'];
                    break;
                }
            }
        }
    }

    public function readOnly(): bool
    {
        if ($this->source !== null) return true;
        $stmt = $this->db->prepare("SELECT 1 FROM network_write_bans WHERE (kind='browser' AND value=?) OR (kind='user' AND value=?) LIMIT 1");
        $stmt->execute([$this->identity->browser, (string) ($this->user['id'] ?? '')]);
        return (bool) $stmt->fetchColumn();
    }

    public function assertAccountWritable(int $id): void
    {
        $stmt = $this->db->prepare("SELECT 1 FROM network_write_bans WHERE kind='user' AND value=?");
        $stmt->execute([(string) $id]);
        if ($stmt->fetchColumn()) throw new ApiError(403, 'network_read_only', 'Для этого подключения, браузера или аккаунта доступно только чтение.');
    }

    public function assertWritable(): void
    {
        if ($this->source !== null) {
            // Persist only on a valid CSRF-protected write attempt, not passive reads.
            // No exit-IP ban: that would permanently punish unrelated exit-node users.
            $this->db->beginTransaction();
            try {
                $identities = ['browser' => $this->identity->browser];
                if ($this->user) $identities['user'] = (string) $this->user['id'];
                foreach ($identities as $kind => $value) {
                    $reason = 'Automatic read-only restriction: ' . $this->source;
                    $stmt = $this->db->prepare('INSERT INTO network_write_bans(kind,value,source,reason,created_at) VALUES (?,?,?,?,?) ON CONFLICT(kind,value) DO NOTHING');
                    $stmt->execute([$kind, $value, $this->source, $reason, time()]);
                    if ($stmt->rowCount()) {
                        $this->db->prepare("INSERT INTO network_ban_events(actor_id,action,kind,value,source,reason,created_at) VALUES (NULL,'add',?,?,?,?,?)")
                            ->execute([$kind, $value, $this->source, $reason, time()]);
                    }
                }
                $this->db->commit();
            } catch (Throwable $e) {
                $this->db->rollBack();
                throw $e;
            }
        }
        if ($this->readOnly()) throw new ApiError(403, 'network_read_only', 'Для этого подключения, браузера или аккаунта доступно только чтение.');
    }

    /** Validate the entire local file before replacing the last known good list, atomically. */
    public static function import(PDO $db, string $source, string $path): int
    {
        if (!in_array($source, ['tor', 'i2p'], true)) throw new RuntimeException('Source must be tor or i2p.');
        if (!is_file($path) || filesize($path) > 16 * 1024 * 1024) throw new RuntimeException('Missing or oversized list (max 16 MiB).');
        $lines = @file($path, FILE_IGNORE_NEW_LINES);
        if ($lines === false) throw new RuntimeException('Cannot read network list.');
        $ranges = [];
        foreach ($lines as $line) {
            $line = trim(explode('#', $line, 2)[0]);
            if ($line === '') continue;
            // Accept Tor bulk IP lists, not consensus/HTML. Tor entries must be individual IPs.
            if ($source === 'tor' && !filter_var($line, FILTER_VALIDATE_IP)) throw new RuntimeException('Tor list must contain one IP per line.');
            $cidr = AbuseIdentity::cidr($line);
            if ($cidr === null) throw new RuntimeException('Invalid IP/CIDR in network list.');
            $ranges[$cidr] = true;
            if (count($ranges) > 100000) throw new RuntimeException('Too many ranges.');
        }
        if (!$ranges) throw new RuntimeException('Refusing to replace the list with an empty file.');
        $db->beginTransaction();
        try {
            $db->prepare('DELETE FROM network_ranges WHERE source=?')->execute([$source]);
            $insert = $db->prepare('INSERT INTO network_ranges(source,cidr,imported_at) VALUES (?,?,?)');
            foreach ($ranges as $cidr => $_) $insert->execute([$source, $cidr, time()]);
            $db->commit();
        } catch (Throwable $e) {
            $db->rollBack();
            throw $e;
        }
        return count($ranges);
    }

    public static function removeBan(PDO $db, int $id, string $reason, ?int $actor): bool
    {
        if (trim($reason) === '' || mb_strlen($reason) > 1000) throw new RuntimeException('A reason is required (max 1000 characters).');
        $db->beginTransaction();
        try {
            $stmt = $db->prepare('SELECT * FROM network_write_bans WHERE id=?');
            $stmt->execute([$id]);
            $ban = $stmt->fetch();
            if ($ban) {
                $db->prepare('DELETE FROM network_write_bans WHERE id=?')->execute([$id]);
                $db->prepare("INSERT INTO network_ban_events(actor_id,action,kind,value,source,reason,created_at) VALUES (?,'remove',?,?,?,?,?)")
                    ->execute([$actor, $ban['kind'], $ban['value'], $ban['source'], $reason, time()]);
            }
            $db->commit();
            return (bool) $ban;
        } catch (Throwable $e) {
            $db->rollBack();
            throw $e;
        }
    }
}
