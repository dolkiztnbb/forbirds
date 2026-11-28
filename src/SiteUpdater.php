<?php
declare(strict_types=1);

namespace ForBirds;

use PDO;
use RuntimeException;
use Throwable;

/** Private, single-slot queue. Web requests never execute Git, PHP or a shell. */
final class SiteUpdater
{
    private string $directory;
    public function __construct(private array $config, private string $root = __DIR__ . '/..')
    {
        $this->directory = $config['storage'] . '/site-update';
    }

    private function prepare(): void
    {
        if (!is_dir($this->directory) && !mkdir($this->directory, 0700, true) && !is_dir($this->directory)) {
            throw new RuntimeException('Cannot create private update directory.');
        }
    }

    /** @return resource */
    private function lock(string $name, int $operation)
    {
        $this->prepare();
        $lock = fopen($this->directory . '/' . $name, 'c');
        if (!$lock || !flock($lock, $operation)) {
            if ($lock) fclose($lock);
            throw new RuntimeException('update_busy');
        }
        chmod($this->directory . '/' . $name, 0600);
        return $lock;
    }

    private function read(): array
    {
        $path = $this->directory . '/state.json';
        if (!is_file($path)) return ['status' => 'idle'];
        $data = json_decode(file_get_contents($path), true, 16, JSON_THROW_ON_ERROR);
        if (!is_array($data)) throw new RuntimeException('Invalid update state.');
        return $data;
    }

    private function save(array $state): void
    {
        $tmp = $this->directory . '/state.' . bin2hex(random_bytes(8)) . '.tmp';
        if (file_put_contents($tmp, json_encode($state, JSON_THROW_ON_ERROR), LOCK_EX) === false) throw new RuntimeException('Cannot save update state.');
        chmod($tmp, 0600);
        if (!rename($tmp, $this->directory . '/state.json')) throw new RuntimeException('Cannot save update state.');
    }

    public function status(): array
    {
        $state = $this->read();
        // Deliberately never return command output, passwords, paths, remotes or backup filenames.
        return ['enabled' => !empty($this->config['updates_enabled']), 'maintenance' => is_file($this->directory . '/maintenance')]
            + array_intersect_key($state, array_flip(['id', 'status', 'phase', 'requested_at', 'started_at', 'finished_at', 'before', 'after', 'error']));
    }

    public function enqueue(int $actor): array
    {
        if (empty($this->config['updates_enabled'])) throw new RuntimeException('updates_disabled');
        $lock = $this->lock('queue.lock', LOCK_EX | LOCK_NB);
        try {
            $old = $this->read();
            if (in_array($old['status'], ['queued', 'running'], true) || is_file($this->directory . '/maintenance')) throw new RuntimeException('update_busy');
            $this->save(['id' => bin2hex(random_bytes(16)), 'status' => 'queued', 'phase' => 'queued', 'actor_id' => $actor, 'requested_at' => time()]);
            return $this->status();
        } finally { fclose($lock); }
    }

    /** Hold this shared lock until the ordinary API request finishes, including streamed attachments. */
    public function enterRequest()
    {
        $this->prepare();
        if (is_file($this->directory . '/maintenance')) throw new RuntimeException('maintenance');
        $lock = $this->lock('requests.lock', LOCK_SH | LOCK_NB);
        if (is_file($this->directory . '/maintenance')) { fclose($lock); throw new RuntimeException('maintenance'); }
        return $lock;
    }

    public function run(): int
    {
        if (empty($this->config['updates_enabled'])) throw new RuntimeException('updates_disabled');
        $worker = $this->lock('worker.lock', LOCK_EX | LOCK_NB);
        $gate = null;
        $changed = false;
        $state = [];
        try {
            $queue = $this->lock('queue.lock', LOCK_EX);
            try {
                $state = $this->read();
                if ($state['status'] !== 'queued') return 0;
                $state['status'] = 'running'; $state['started_at'] = time();
                $state['phase'] = 'preflight'; $this->save($state);
            } finally { fclose($queue); }
            $this->log($state, 'Starting fixed update workflow.');
            if (is_file($this->directory . '/maintenance')) throw new RuntimeException('maintenance');
            if (!function_exists('proc_open')) throw new RuntimeException('process_unavailable');
            $root = realpath($this->root);
            if (!$root || !is_dir($root . '/.git')) throw new RuntimeException('not_checkout');
            $this->root = $root;
            if ($this->git(['rev-parse', '--show-toplevel'], $state) !== $root) throw new RuntimeException('not_checkout');
            if ($this->git(['symbolic-ref', '--short', 'HEAD'], $state) !== 'main') throw new RuntimeException('wrong_branch');
            if ($this->git(['status', '--porcelain', '--untracked-files=normal'], $state) !== '') throw new RuntimeException('dirty_checkout');
            $state['before'] = $this->git(['rev-parse', 'HEAD'], $state);
            $this->git(['remote', 'get-url', 'origin'], $state); // An operator-configured origin is required.
            if (!is_file($this->config['database']) || !is_file($this->config['storage'] . '/app.key')) throw new RuntimeException('not_installed');
            $this->phase($state, 'maintenance');
            if (file_put_contents($this->directory . '/maintenance', $state['id'], LOCK_EX) !== strlen($state['id'])) throw new RuntimeException('maintenance_failed');
            chmod($this->directory . '/maintenance', 0600);
            // New API requests now fail fast. Drain existing requests before touching the checkout/DB.
            $deadline = microtime(true) + 30;
            do {
                try { $gate = $this->lock('requests.lock', LOCK_EX | LOCK_NB); break; }
                catch (RuntimeException $e) { if (microtime(true) >= $deadline) throw new RuntimeException('requests_busy'); usleep(100000); }
            } while (true);
            // Recheck after draining; do not overwrite operator changes made during preflight.
            if ($this->git(['status', '--porcelain', '--untracked-files=normal'], $state) !== '') throw new RuntimeException('dirty_checkout');
            $this->phase($state, 'backup');
            $backup = $this->directory . '/backup-' . $state['id'] . '.sqlite';
            $db = new PDO('sqlite:' . $this->config['database'], null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
            $db->exec('PRAGMA busy_timeout=5000');
            $db->exec('VACUUM INTO ' . $db->quote($backup)); // Consistent snapshot, including committed WAL pages.
            chmod($backup, 0600); $db = null;
            $this->phase($state, 'pull');
            // From here on, an interrupted/failed command may have changed files: keep maintenance until repair.
            $changed = true;
            $this->git(['pull', '--ff-only', '--no-rebase', '--no-autostash', '--no-recurse-submodules', 'origin', 'main'], $state, 180);
            $state['after'] = $this->git(['rev-parse', 'HEAD'], $state);
            $this->phase($state, 'migrate');
            // Fresh process loads the NEW migration code. Same PHP binary and storage as the worker.
            $this->command([PHP_BINARY, $root . '/bin/console.php', 'migrate'], $state, 180, 'migration_failed');
            $this->phase($state, 'complete');
            if (!unlink($this->directory . '/maintenance')) throw new RuntimeException('maintenance_clear_failed');
            $state['status'] = 'succeeded'; $state['finished_at'] = time(); $this->save($state);
            return 0;
        } catch (Throwable $error) {
            if ($state && ($state['status'] ?? '') === 'running') {
                $state['status'] = 'failed'; $state['finished_at'] = time();
                $allowed = ['maintenance', 'maintenance_failed', 'maintenance_clear_failed', 'process_unavailable', 'not_checkout', 'wrong_branch', 'dirty_checkout', 'not_installed', 'requests_busy', 'git_failed', 'migration_failed', 'command_timeout'];
                $state['error'] = in_array($error->getMessage(), $allowed, true) ? $error->getMessage() : 'update_failed';
                $this->save($state); $this->log($state, 'Stopped: ' . $state['error'] . ' — ' . substr($error->getMessage(), 0, 4096));
                if (!$changed && is_file($this->directory . '/maintenance') && file_get_contents($this->directory . '/maintenance') === $state['id']) unlink($this->directory . '/maintenance');
            }
            return 1;
        } finally { if ($gate) fclose($gate); fclose($worker); }
    }

    private function phase(array &$state, string $phase): void
    {
        $state['phase'] = $phase; $this->save($state); $this->log($state, $phase);
    }

    private function log(array $state, string $message): void
    {
        $path = $this->directory . '/job-' . $state['id'] . '.log';
        file_put_contents($path, gmdate('c') . ' ' . $message . "\n", FILE_APPEND | LOCK_EX);
        chmod($path, 0600);
    }

    private function git(array $arguments, array $state, int $timeout = 30): string
    {
        return trim($this->command(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', ...$arguments], $state, $timeout, 'git_failed'));
    }

    private function command(array $arguments, array $state, int $timeout, string $failure): string
    {
        $environment = getenv();
        $environment['FORBIRDS_STORAGE'] = realpath($this->config['storage']);
        $environment['GIT_TERMINAL_PROMPT'] = '0'; $environment['GCM_INTERACTIVE'] = 'never';
        $environment['GIT_SSH_COMMAND'] = 'ssh -oBatchMode=yes -oConnectTimeout=15';
        $process = proc_open($arguments, [0 => ['pipe', 'r'], 1 => ['pipe', 'w'], 2 => ['pipe', 'w']], $pipes, $this->root, $environment, ['bypass_shell' => true]);
        if (!is_resource($process)) throw new RuntimeException($failure);
        fclose($pipes[0]); stream_set_blocking($pipes[1], false); stream_set_blocking($pipes[2], false);
        $output = ''; $total = 0; $started = microtime(true); $exit = -1;
        $drain = function () use ($pipes, &$output, &$total, $state): void {
            foreach ([1, 2] as $index) {
                $chunk = stream_get_contents($pipes[$index], 65536);
                if ($chunk !== false && $chunk !== '') {
                    if ($index === 1 && strlen($output) < 65536) $output .= substr($chunk, 0, 65536 - strlen($output));
                    // Raw output is private operator-only and bounded. It is never returned by status().
                    if ($total < 131072) $this->log($state, substr($chunk, 0, 131072 - $total));
                    $total += strlen($chunk);
                }
            }
        };
        try {
            do {
                $drain();
                $status = proc_get_status($process);
                if (!$status['running']) { $drain(); $exit = $status['exitcode']; break; }
                if (microtime(true) - $started > $timeout) {
                    proc_terminate($process, 9);
                    throw new RuntimeException('command_timeout');
                }
                usleep(20000);
            } while (true);
        } finally { fclose($pipes[1]); fclose($pipes[2]); proc_close($process); }
        if ($exit !== 0) throw new RuntimeException($failure);
        return $output;
    }
}
