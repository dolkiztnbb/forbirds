<?php
declare(strict_types=1);
namespace ForBirds;

use PDO;
use Throwable;

/** SSE invalidations, never raw post broadcasts. Snapshots use the normal viewer-specific API. */
final class ThreadEvents
{
    public function __construct(private PDO $db, private array $config) {}

    public function run(callable $scope, callable $snapshot): never
    {
        $currentScope = $scope(null);
        $revision = (int) $this->db->query('PRAGMA data_version')->fetchColumn();
        $initial = $snapshot(); // Reject inaccessible threads before committing stream headers.
        if (empty($this->config['live_enabled'])) { http_response_code(204); exit; }
        $directory = $this->config['storage'] . '/live';
        if (!is_dir($directory) && !mkdir($directory, 0700, true) && !is_dir($directory)) throw new \RuntimeException('Cannot prepare SSE slots.');
        $lease = null;
        for ($i = 0; $i < $this->config['live_max_streams']; $i++) {
            $candidate = fopen($directory . '/slot-' . $i . '.lock', 'c');
            if ($candidate && flock($candidate, LOCK_EX | LOCK_NB)) { $lease = $candidate; break; }
            if ($candidate) fclose($candidate);
        }
        // 204 stops EventSource automatic retries; a UI reconnect button remains available.
        if (!$lease) { http_response_code(204); exit; }
        $sessionId = session_id();
        session_write_close(); // A stream must never lock login, posting or another browser tab.
        ini_set('session.use_cookies', '0');
        ini_set('session.cache_limiter', '');
        ini_set('zlib.output_compression', '0');
        set_time_limit(25);
        header('Content-Type: text/event-stream; charset=utf-8');
        header('Cache-Control: no-store');
        header('X-Accel-Buffering: no');
        while (ob_get_level()) ob_end_flush();
        $emit = static function (string $event, array $data = []): void {
            echo 'event: ' . $event . "\n" . 'data: ' . json_encode($data, JSON_THROW_ON_ERROR) . "\n\n";
            flush();
        };
        try {
            if ($scope($sessionId) !== $currentScope) { $emit('reset'); exit; }
            $version = self::version($initial);
            echo "retry: 1000\n\n";
            $emit('change', ['version' => $version, 'scope' => $initial['live_scope']]);
            $start = microtime(true); $heartbeat = $start;
            do {
                usleep(500000);
                if (connection_aborted()) break;
                clearstatcache(true, $this->config['storage'] . '/site-update/maintenance');
                if (is_file($this->config['storage'] . '/site-update/maintenance')) { $emit('maintenance'); break; }
                if ($scope($sessionId) !== $currentScope) { $emit('reset'); break; }
                $next = (int) $this->db->query('PRAGMA data_version')->fetchColumn();
                if ($next !== $revision) {
                    $revision = $next;
                    $data = $snapshot();
                    $hash = self::version($data);
                    if ($hash !== $version) { $version = $hash; $emit('change', ['version' => $hash, 'scope' => $data['live_scope']]); }
                }
                if (microtime(true) - $heartbeat >= 5) { echo ": keep-alive\n\n"; flush(); $heartbeat = microtime(true); }
            } while (microtime(true) - $start < 20);
        } catch (ApiError) { $emit('gone'); }
        catch (Throwable) { $emit('unavailable'); }
        finally { fclose($lease); }
        exit;
    }

    public static function version(array $data): string
    {
        unset($data['live_version']);
        return hash('sha256', json_encode(AbuseIdentity::redact($data), JSON_THROW_ON_ERROR));
    }
}
