<?php
declare(strict_types=1);

namespace ForBirds;

use PDO;

/** Local SHA-256 proof of work, not Cloudflare Turnstile or a proof of humanity. */
final class PostingGuard
{
    private string $key;

    public function __construct(private PDO $db, private array $config, private ?array $user)
    {
        $this->key = trim(file_get_contents($config['storage'] . '/app.key'));
    }

    private function subject(): string
    {
        $identity = $this->user ? 'user:' . $this->user['id'] : 'guest:' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown');
        return hash_hmac('sha256', $identity, $this->key);
    }

    private function binding(): string
    {
        return hash_hmac('sha256', session_id() . ':' . $this->subject(), $this->key);
    }

    public function status(): array
    {
        $stmt = $this->db->prepare('SELECT last_post_at FROM posting_limits WHERE subject = ?');
        $stmt->execute([$this->subject()]);
        $last = $stmt->fetchColumn();
        $interval = $this->user ? 30 : 45;
        $next = $last === false ? 0 : (int) $last + $interval;
        return [
            'next_allowed_at' => $next,
            'interval_seconds' => $interval,
            'retry_after' => max(0, $next - time()),
            'pow_required' => true,
        ];
    }

    public function issue(): array
    {
        $status = $this->status();
        if ($status['retry_after'] > 0) {
            $this->cooldown($status['retry_after']);
        }
        $now = time();
        $this->db->prepare('DELETE FROM pow_challenges WHERE expires_at <= ?')->execute([$now]);
        $id = bin2hex(random_bytes(16));
        $prefix = bin2hex(random_bytes(32));
        $difficulty = $this->config['pow_difficulty'];
        $expires = $now + 300;
        // A new challenge supersedes the previous one for this session/identity.
        $this->db->prepare('INSERT INTO pow_challenges(id,binding,prefix,difficulty,issued_at,expires_at) VALUES (?,?,?,?,?,?)
            ON CONFLICT(binding) DO UPDATE SET id=excluded.id,prefix=excluded.prefix,
            difficulty=excluded.difficulty,issued_at=excluded.issued_at,expires_at=excluded.expires_at')
            ->execute([$id, $this->binding(), $prefix, $difficulty, $now, $expires]);
        return ['id' => $id, 'prefix' => $prefix, 'difficulty' => $difficulty, 'expires_at' => $expires,
            'algorithm' => 'sha256', 'format' => 'prefix:nonce', 'interval_seconds' => $status['interval_seconds']];
    }

    /** Called inside the same write transaction as the new post. Rollback restores the proof and slot. */
    public function consume(array $input): void
    {
        // First acquire SQLite's write lock, before reading either cooldown or challenge.
        // This also serialises different sessions of the same account/IP.
        $stmt = $this->db->prepare('INSERT INTO posting_limits(subject,last_post_at) VALUES (?,0)
            ON CONFLICT(subject) DO UPDATE SET last_post_at=last_post_at');
        $stmt->execute([$this->subject()]);
        $status = $this->status();
        if ($status['retry_after'] > 0) {
            $this->cooldown($status['retry_after']);
        }
        $id = $input['pow_id'] ?? null;
        $nonce = $input['pow_nonce'] ?? null;
        if (!is_string($id) || !preg_match('/\A[a-f0-9]{32}\z/', $id)
            || !is_string($nonce) || !preg_match('/\A(?:0|[1-9][0-9]{0,15})\z/', $nonce)) {
            throw new ApiError(422, 'pow_required', 'Решите локальную хэш-капчу перед публикацией.');
        }
        $stmt = $this->db->prepare('SELECT * FROM pow_challenges WHERE id = ? AND binding = ?');
        $stmt->execute([$id, $this->binding()]);
        $challenge = $stmt->fetch();
        if (!$challenge || $challenge['expires_at'] <= time() || $challenge['issued_at'] < $status['next_allowed_at']) {
            throw new ApiError(422, 'pow_expired', 'Проверка истекла или уже использована. Получите новую задачу.');
        }
        $digest = hash('sha256', $challenge['prefix'] . ':' . $nonce, true);
        $bits = (int) $challenge['difficulty'];
        $whole = intdiv($bits, 8);
        $remainder = $bits % 8;
        if (substr($digest, 0, $whole) !== str_repeat("\0", $whole)
            || ($remainder && (ord($digest[$whole]) >> (8 - $remainder)) !== 0)) {
            throw new ApiError(422, 'pow_invalid', 'Неверное решение хэш-капчи.');
        }
        $this->db->prepare('DELETE FROM pow_challenges WHERE id = ?')->execute([$id]);
        $this->db->prepare('UPDATE posting_limits SET last_post_at = ? WHERE subject = ?')->execute([time(), $this->subject()]);
        // Only remove keys far older than either interval; session changes cannot bypass an active slot.
        $this->db->prepare('DELETE FROM posting_limits WHERE last_post_at < ?')->execute([time() - 86400]);
    }

    private function cooldown(int $seconds): never
    {
        throw new ApiError(429, 'posting_cooldown', 'До следующей публикации: ' . $seconds . ' сек.', $seconds);
    }
}
