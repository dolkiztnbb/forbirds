<?php
declare(strict_types=1);

namespace ForBirds;

use PDO;

/** Best-effort anti-abuse signals, NOT a hardware ID or an authentication factor. */
final class AbuseIdentity
{
    public readonly ?string $ip;
    public readonly string $browser;
    public readonly ?string $fingerprint;

    public function __construct(private PDO $db, array $config)
    {
        $key = trim(file_get_contents($config['storage'] . '/app.key'));
        $ip = $_SERVER['REMOTE_ADDR'] ?? '';
        $this->ip = filter_var($ip, FILTER_VALIDATE_IP) ? inet_ntop(inet_pton($ip)) : null;
        // Never trust X-Forwarded-For. Resolve trusted proxies in the web server.
        $cookieName = $config['secure_cookie'] ? '__Host-forbirds_browser' : 'forbirds_browser';
        $cookie = $_COOKIE[$cookieName] ?? '';
        $parts = is_string($cookie) ? explode('.', $cookie) : [];
        if (count($parts) !== 2 || !preg_match('/\A[a-f0-9]{64}\z/', $parts[0])
            || !hash_equals(hash_hmac('sha256', $parts[0], $key), $parts[1])) {
            $parts = [bin2hex(random_bytes(32))];
            $cookie = $parts[0] . '.' . hash_hmac('sha256', $parts[0], $key);
            setcookie($cookieName, $cookie, ['expires' => time() + 86400 * 180, 'path' => '/',
                'secure' => $config['secure_cookie'], 'httponly' => true, 'samesite' => 'Lax']);
        }
        $this->browser = hash_hmac('sha256', 'browser:' . $parts[0], $key);
        $fingerprint = $_SERVER['HTTP_X_FORBIRDS_FINGERPRINT'] ?? '';
        $this->fingerprint = is_string($fingerprint) && preg_match('/\A[a-f0-9]{64}\z/', $fingerprint)
            ? hash_hmac('sha256', 'fingerprint:' . $fingerprint, $key) : null;
    }

    public function assertAllowed(): void
    {
        $stmt = $this->db->prepare('SELECT kind,value FROM identity_bans WHERE expires_at IS NULL OR expires_at > ?');
        $stmt->execute([time()]);
        foreach ($stmt as $ban) {
            $matches = match ($ban['kind']) {
                'cidr' => $this->ip !== null && self::contains($ban['value'], $this->ip),
                'browser' => hash_equals($ban['value'], $this->browser),
                'fingerprint' => $this->fingerprint !== null && hash_equals($ban['value'], $this->fingerprint),
                default => false,
            };
            if ($matches) {
                throw new ApiError(403, 'identity_banned', 'Публикация с этого подключения или браузера ограничена.');
            }
        }
    }

    public static function cidr(string $value): ?string
    {
        $parts = explode('/', $value);
        if (count($parts) > 2 || !filter_var($parts[0], FILTER_VALIDATE_IP)) return null;
        $bytes = inet_pton($parts[0]);
        $max = strlen($bytes) * 8;
        if (isset($parts[1]) && !preg_match('/\A(?:0|[1-9][0-9]{0,2})\z/', $parts[1])) return null;
        $bits = isset($parts[1]) ? (int) $parts[1] : $max;
        if ($bits > $max) return null;
        for ($i = 0; $i < strlen($bytes); $i++) {
            $remaining = max(0, min(8, $bits - $i * 8));
            $bytes[$i] = chr(ord($bytes[$i]) & ($remaining ? (255 << (8 - $remaining)) & 255 : 0));
        }
        return inet_ntop($bytes) . '/' . $bits;
    }

    public static function contains(string $cidr, string $ip): bool
    {
        $canonical = self::cidr($cidr);
        if ($canonical === null || !filter_var($ip, FILTER_VALIDATE_IP)) return false;
        [$network, $bits] = explode('/', $canonical);
        $packed = inet_pton($ip);
        if (strlen($packed) !== strlen(inet_pton($network))) return false;
        return self::cidr($ip . '/' . $bits) === $canonical;
    }

    /** Raw post identity fields never travel in ordinary feeds, including staff feeds. */
    public static function redact(mixed $value): mixed
    {
        if (!is_array($value)) return $value;
        foreach ($value as $key => &$item) {
            if (in_array($key, ['author_ip', 'browser_id', 'fingerprint'], true)) {
                unset($value[$key]);
            } else {
                $item = self::redact($item);
            }
        }
        unset($item);
        return $value;
    }
}
