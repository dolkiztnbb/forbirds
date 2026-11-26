<?php
declare(strict_types=1);

namespace ForBirds;

use PDO;
use PDOException;
use RuntimeException;
use Throwable;

final class ApiError extends RuntimeException
{
    public function __construct(public readonly int $status, public readonly string $errorCode, string $message, public readonly ?int $retryAfter = null)
    {
        parent::__construct($message);
    }
}

final class Api
{
    private ?array $user;
    private array $input = [];

    public function __construct(private PDO $db, private array $config)
    {
        // Reload permissions on every request: bans and trust revocation apply to existing sessions.
        $this->user = isset($_SESSION['user_id'])
            ? $this->one('SELECT * FROM users WHERE id = ?', [$_SESSION['user_id']]) : null;
    }

    public function dispatch(string $method, string $path): mixed
    {
        if (!in_array($method, ['GET', 'POST'], true)) {
            throw new ApiError(405, 'method_not_allowed', 'Используйте GET или POST.');
        }
        if ($method === 'POST') {
            $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
            if (!is_string($token) || !hash_equals($_SESSION['csrf'], $token)) {
                throw new ApiError(403, 'csrf_failed', 'Получите CSRF-токен через GET /api/session.');
            }
            $this->input = $this->readInput();
            $this->rateLimit('write', 120, 60);
            if ($this->user && $this->user['is_banned'] && $path !== '/api/auth/logout') {
                throw new ApiError(403, 'banned', 'Аккаунт заблокирован.');
            }
        }

        if ($method === 'GET') {
            if ($path === '/api/session') {
                return ['csrf_token' => $_SESSION['csrf'], 'user' => $this->publicUser($this->user, true)];
            }
            if ($path === '/api/posting-status') {
                return (new PostingGuard($this->db, $this->config, $this->user))->status();
            }
            if ($path === '/api/sections') {
                return $this->all('SELECT * FROM sections ORDER BY id');
            }
            if ($path === '/api/threads') {
                return $this->listThreads();
            }
            if ($path === '/api/me/posts') {
                $user = $this->requireUser();
                return $this->page('SELECT p.* FROM posts p WHERE p.user_id = ? ORDER BY p.id DESC', [$user['id']]);
            }
            if ($path === '/api/moderation/queue') {
                $this->requireStaff();
                return $this->page("SELECT p.*, t.title, t.section_id, u.username FROM posts p
                    JOIN threads t ON t.id = p.thread_id LEFT JOIN users u ON u.id = p.user_id
                    WHERE p.status = 'pending' ORDER BY p.id", []);
            }
            if ($path === '/api/moderation/audit') {
                $this->requireStaff();
                return $this->page('SELECT * FROM audit_log ORDER BY id DESC', []);
            }
            if (preg_match('~^/api/threads/([1-9][0-9]*)$~D', $path, $m)) {
                return $this->thread((int) $m[1]);
            }
            if (preg_match('~^/api/posts/([1-9][0-9]*)$~D', $path, $m)) {
                return $this->postWithAttachments($this->visiblePost((int) $m[1]));
            }
            if (preg_match('~^/api/users/([1-9][0-9]*)$~D', $path, $m)) {
                $user = $this->one('SELECT * FROM users WHERE id = ?', [(int) $m[1]]);
                if (!$user) {
                    $this->notFound();
                }
                return $this->publicUser($user, $this->isStaff() || ($this->user && (int) $this->user['id'] === (int) $user['id']));
            }
            if (preg_match('~^/api/attachments/([1-9][0-9]*)/(download|preview|view)$~D', $path, $m)) {
                $this->attachment((int) $m[1], $m[2]);
            }
        } else {
            if ($path === '/api/pow/challenge') {
                $this->rateLimit('pow', 20, 60);
                return (new PostingGuard($this->db, $this->config, $this->user))->issue();
            }
            if ($path === '/api/auth/register') {
                return $this->register();
            }
            if ($path === '/api/auth/login') {
                return $this->login();
            }
            if ($path === '/api/auth/logout') {
                $_SESSION = ['csrf' => bin2hex(random_bytes(32))];
                session_regenerate_id(true);
                $this->user = null;
                return ['csrf_token' => $_SESSION['csrf']];
            }
            if ($path === '/api/sections') {
                return $this->createSection();
            }
            if ($path === '/api/threads') {
                return $this->createPost(null);
            }
            if (preg_match('~^/api/threads/([1-9][0-9]*)/replies$~D', $path, $m)) {
                return $this->createPost((int) $m[1]);
            }
            if (preg_match('~^/api/posts/([1-9][0-9]*)/moderate$~D', $path, $m)) {
                return $this->moderate((int) $m[1]);
            }
            if (preg_match('~^/api/users/([1-9][0-9]*)/(trust|ban|role)$~D', $path, $m)) {
                return $this->manageUser((int) $m[1], $m[2]);
            }
            if (preg_match('~^/api/threads/([1-9][0-9]*)/settings$~D', $path, $m)) {
                return $this->threadSettings((int) $m[1]);
            }
            if (preg_match('~^/api/sections/([1-9][0-9]*)/settings$~D', $path, $m)) {
                return $this->sectionSettings((int) $m[1]);
            }
        }
        $this->notFound();
    }

    private function readInput(): array
    {
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > $this->config['max_post_bytes'] + 1048576) {
            throw new ApiError(413, 'payload_too_large', 'Слишком большой запрос.');
        }
        $type = strtolower(trim(explode(';', $_SERVER['CONTENT_TYPE'] ?? '')[0]));
        if ($type === 'application/json') {
            $raw = file_get_contents('php://input', false, null, 0, 131073);
            if (strlen($raw) > 131072) {
                throw new ApiError(413, 'payload_too_large', 'JSON не должен превышать 128 КиБ.');
            }
            try {
                $object = json_decode($raw, false, 32, JSON_THROW_ON_ERROR);
                if (!$object instanceof \stdClass) {
                    $this->invalid('Тело запроса должно быть JSON-объектом.');
                }
                return get_object_vars($object);
            } catch (\JsonException $e) {
                throw new ApiError(400, 'invalid_json', 'Некорректный JSON.');
            }
        }
        if (in_array($type, ['application/x-www-form-urlencoded', 'multipart/form-data'], true)) {
            // PHP discards the entire body when post_max_size is exceeded.
            if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 0 && !$_POST && !$_FILES) {
                throw new ApiError(413, 'empty_or_large_form', 'Пустая форма или превышен post_max_size.');
            }
            return $_POST;
        }
        throw new ApiError(415, 'unsupported_media_type', 'Отправьте JSON или HTML-форму.');
    }

    private function register(): array
    {
        $this->rateLimit('register', 5, 3600);
        $username = $this->text('username', 3, 32);
        if (!preg_match('/\A[a-zA-Z0-9_]+\z/', $username)) {
            $this->invalid('Имя: латинские буквы, цифры и _.');
        }
        $password = $this->password();
        try {
            $this->run('INSERT INTO users(username,password_hash) VALUES (?,?)', [
                $username, password_hash($password, PASSWORD_DEFAULT),
            ]);
        } catch (PDOException $e) {
            if ((int) ($e->errorInfo[1] ?? 0) === 19) {
                throw new ApiError(409, 'username_taken', 'Имя уже занято.');
            }
            throw $e;
        }
        $this->startLogin((int) $this->db->lastInsertId());
        http_response_code(201);
        return ['user' => $this->publicUser($this->user, true), 'csrf_token' => $_SESSION['csrf']];
    }

    private function login(): array
    {
        $this->rateLimit('login', 10, 900);
        $username = $this->text('username', 1, 32);
        $password = $this->password();
        $user = $this->one('SELECT * FROM users WHERE username = ?', [$username]);
        // A fixed valid dummy hash keeps nonexistent accounts on the expensive verification path.
        $valid = password_verify($password, $user['password_hash'] ?? '$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi');
        if (!$user || !$valid) {
            throw new ApiError(401, 'invalid_credentials', 'Неверное имя или пароль.');
        }
        if ($user['is_banned']) {
            throw new ApiError(403, 'banned', 'Аккаунт заблокирован.');
        }
        if (password_needs_rehash($user['password_hash'], PASSWORD_DEFAULT)) {
            $this->run('UPDATE users SET password_hash = ? WHERE id = ?', [password_hash($password, PASSWORD_DEFAULT), $user['id']]);
        }
        $this->startLogin((int) $user['id']);
        return ['user' => $this->publicUser($this->user, true), 'csrf_token' => $_SESSION['csrf']];
    }

    private function startLogin(int $id): void
    {
        session_regenerate_id(true);
        $_SESSION = ['user_id' => $id, 'csrf' => bin2hex(random_bytes(32))];
        $this->user = $this->one('SELECT * FROM users WHERE id = ?', [$id]);
    }

    private function password(): string
    {
        $password = $this->input['password'] ?? null;
        if (!is_string($password) || strlen($password) < 12 || strlen($password) > 72 || str_contains($password, "\0")) {
            $this->invalid('Пароль должен содержать от 12 до 72 байт без нулевых символов.');
        }
        return $password;
    }

    private function createSection(): array
    {
        $actor = $this->requireAdmin();
        $slug = $this->text('slug', 1, 64);
        if (!preg_match('/\A[a-z0-9]+(?:-[a-z0-9]+)*\z/', $slug)) {
            $this->invalid('slug: строчные латинские буквы, цифры и дефисы.');
        }
        $title = $this->text('title', 1, 200);
        $description = $this->text('description', 0, 4000, '');
        return $this->transaction(function () use ($actor, $slug, $title, $description) {
            if ($this->one('SELECT id FROM sections WHERE slug = ?', [$slug])) {
                throw new ApiError(409, 'slug_taken', 'Такой раздел уже существует.');
            }
            $this->run('INSERT INTO sections(slug,title,description) VALUES (?,?,?)', [$slug, $title, $description]);
            $id = (int) $this->db->lastInsertId();
            $this->audit($actor['id'], 'section.create', 'section', $id);
            http_response_code(201);
            return $this->one('SELECT * FROM sections WHERE id = ?', [$id]);
        });
    }

    private function listThreads(): array
    {
        // Visibility is derived from current server-side permissions, never from a client flag.
        $statuses = $this->isStaff() ? "('approved','pending')" : "('approved')";
        $where = ["p.status IN $statuses"];
        $params = [];
        if (isset($_GET['section_id'])) {
            $where[] = 't.section_id = ?';
            $params[] = $this->positiveInt($_GET['section_id']);
        }
        foreach (['news' => 'is_news', 'featured' => 'is_featured'] as $key => $column) {
            if (isset($_GET[$key])) {
                if ($_GET[$key] !== '1') {
                    $this->invalid($key . ' должен быть равен 1.');
                }
                $where[] = 't.' . $column . ' = 1';
            }
        }
        if (isset($_GET['q'])) {
            if (!is_string($_GET['q']) || strlen($_GET['q']) < 2 || strlen($_GET['q']) > 200) {
                $this->invalid('Поисковая строка: 2–200 байт.');
            }
            $where[] = "(instr(unicode_lower(t.title), unicode_lower(?)) > 0 OR EXISTS (
                SELECT 1 FROM posts search_post WHERE search_post.thread_id = t.id
                AND search_post.status IN $statuses AND instr(unicode_lower(search_post.body), unicode_lower(?)) > 0))";
            array_push($params, $_GET['q'], $_GET['q']);
        }
        $pendingCount = $this->isStaff()
            ? "(SELECT count(*) FROM posts r WHERE r.thread_id = t.id AND r.is_root = 0 AND r.status = 'pending')" : '0';
        $order = $this->isStaff()
            ? "(p.status = 'pending') DESC, (pending_reply_count > 0) DESC, t.id DESC" : 't.id DESC';
        return $this->page("SELECT t.*, p.id AS post_id, p.body, p.user_id, p.status, u.username,
            (SELECT count(*) FROM posts r WHERE r.thread_id = t.id AND r.is_root = 0 AND r.status IN $statuses) AS reply_count,
            $pendingCount AS pending_reply_count
            FROM threads t JOIN posts p ON p.thread_id = t.id AND p.is_root = 1
            LEFT JOIN users u ON u.id = p.user_id WHERE " . implode(' AND ', $where) . ' ORDER BY ' . $order, $params);
    }

    private function thread(int $id): array
    {
        $thread = $this->one('SELECT * FROM threads WHERE id = ?', [$id]);
        $root = $this->one('SELECT id FROM posts WHERE thread_id = ? AND is_root = 1', [$id]);
        if (!$thread || !$root) {
            $this->notFound();
        }
        $thread['post'] = $this->postWithAttachments($this->visiblePost((int) $root['id']));
        $params = [$id];
        $condition = "p.status = 'approved'";
        if ($this->isStaff()) {
            $condition = '1 = 1';
        } elseif ($this->user) {
            $condition = "(p.status = 'approved' OR (p.status = 'pending' AND p.user_id = ?))";
            $params[] = $this->user['id'];
        }
        $replies = $this->page("SELECT p.*, u.username, u.role AS author_role, u.is_banned AS author_banned
            FROM posts p LEFT JOIN users u ON u.id = p.user_id
            WHERE p.thread_id = ? AND p.is_root = 0 AND $condition ORDER BY p.id", $params);
        $replies['items'] = array_map(fn ($post) => $this->postWithAttachments($post), $replies['items']);
        $thread['replies'] = $replies;
        return $thread;
    }

    private function createPost(?int $threadId): array
    {
        $this->rateLimit('post', 10, 60);
        $body = $this->text('body', 1, 50000);
        $title = $threadId === null ? $this->text('title', 1, 200) : null;
        $sectionId = $threadId === null ? $this->positiveInt($this->input['section_id'] ?? null) : null;
        $news = $this->boolean('is_news', false);
        $featured = $this->boolean('is_featured', false);
        if (($news || $featured) && !$this->isStaff()) {
            throw new ApiError(403, 'forbidden', 'Размещение на главной и в новостях доступно персоналу.');
        }
        $files = $this->validateFiles();
        $moved = [];
        try {
            return $this->transaction(function () use ($threadId, $body, $title, $sectionId, $news, $featured, $files, &$moved) {
                (new PostingGuard($this->db, $this->config, $this->user))->consume($this->input);
                $isRoot = $threadId === null;
                if ($isRoot) {
                    $section = $this->one('SELECT * FROM sections WHERE id = ?', [$sectionId]);
                } else {
                    $thread = $this->one('SELECT * FROM threads WHERE id = ?', [$threadId]);
                    $root = $this->one('SELECT id FROM posts WHERE thread_id = ? AND is_root = 1', [$threadId]);
                    if (!$thread || !$root) {
                        $this->notFound();
                    }
                    $this->visiblePost((int) $root['id']);
                    $section = $this->one('SELECT * FROM sections WHERE id = ?', [$thread['section_id']]);
                    if ($thread['is_locked'] && !$this->isStaff()) {
                        throw new ApiError(409, 'thread_locked', 'Тема закрыта.');
                    }
                }
                if (!$section) {
                    $this->notFound();
                }
                if ($section['is_archived'] && !$this->isStaff()) {
                    throw new ApiError(409, 'section_archived', 'Раздел находится в архиве.');
                }
                if ($isRoot) {
                    $this->run('INSERT INTO threads(section_id,title,is_news,is_featured) VALUES (?,?,?,?)', [
                        $sectionId, $title, (int) $news, (int) $featured,
                    ]);
                    $threadId = (int) $this->db->lastInsertId();
                }
                $status = $this->isStaff() || ($this->user && $this->user['auto_approve']) ? 'approved' : 'pending';
                $this->run('INSERT INTO posts(thread_id,user_id,is_root,body,status) VALUES (?,?,?,?,?)', [
                    $threadId, $this->user['id'] ?? null, (int) $isRoot, $body, $status,
                ]);
                $id = (int) $this->db->lastInsertId();
                foreach ($files as $file) {
                    $name = bin2hex(random_bytes(24));
                    $destination = $this->config['storage'] . '/uploads/' . $name;
                    if (!move_uploaded_file($file['tmp_name'], $destination)) {
                        throw new RuntimeException('Failed to store upload.');
                    }
                    $moved[] = $destination;
                    chmod($destination, 0600);
                    if (ImagePreview::isImage($file['mime'])) {
                        $previews = new ImagePreview($this->config['storage']);
                        $moved[] = $previews->path($name);
                        $previews->ensure($destination, $name, $file['mime']);
                    }
                    $this->run('INSERT INTO attachments(post_id,storage_name,original_name,mime_type,byte_size,spoiler) VALUES (?,?,?,?,?,?)', [
                        $id, $name, $file['name'], $file['mime'], $file['size'], (int) $file['spoiler'],
                    ]);
                }
                http_response_code(201);
                return ['post_id' => $id, 'thread_id' => $threadId, 'status' => $status];
            });
        } catch (Throwable $e) {
            foreach ($moved as $path) {
                if (is_file($path)) {
                    unlink($path);
                }
            }
            throw $e;
        }
    }

    private function moderate(int $id): array
    {
        $actor = $this->requireStaff();
        $action = $this->text('action', 1, 20);
        $statuses = ['approve' => 'approved', 'unapprove' => 'pending', 'reject' => 'rejected', 'delete' => 'deleted'];
        if (!isset($statuses[$action])) {
            $this->invalid('action: approve, unapprove, reject или delete.');
        }
        $reason = $this->text('reason', 0, 1000, '');
        return $this->transaction(function () use ($id, $action, $statuses, $reason, $actor) {
            $post = $this->one('SELECT * FROM posts WHERE id = ?', [$id]);
            if (!$post) {
                $this->notFound();
            }
            if ($post['status'] === 'deleted') {
                throw new ApiError(409, 'post_deleted', 'Удалённое сообщение нельзя восстановить через API.');
            }
            $status = $statuses[$action];
            $this->run("UPDATE posts SET status = ?, moderated_by = ?, moderated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?", [$status, $actor['id'], $id]);
            $this->audit($actor['id'], 'post.' . $action, 'post', $id, ['from' => $post['status'], 'to' => $status, 'reason' => $reason]);
            return ['post_id' => $id, 'status' => $status];
        });
    }

    private function manageUser(int $id, string $action): array
    {
        $actor = $action === 'role' ? $this->requireAdmin() : $this->requireStaff();
        return $this->transaction(function () use ($id, $action, $actor) {
            $target = $this->one('SELECT * FROM users WHERE id = ?', [$id]);
            if (!$target) {
                $this->notFound();
            }
            if ($target['role'] === 'admin' || (int) $actor['id'] === $id || ($actor['role'] !== 'admin' && $target['role'] !== 'user')) {
                throw new ApiError(403, 'forbidden', 'Нельзя изменять этого пользователя.');
            }
            $column = ['role' => 'role', 'trust' => 'auto_approve', 'ban' => 'is_banned'][$action];
            if ($action === 'role') {
                $value = $this->text('role', 1, 20);
                if (!in_array($value, ['user', 'moderator'], true)) {
                    $this->invalid('Через API можно назначить роль user или moderator.');
                }
            } else {
                $value = (int) $this->boolean('enabled');
            }
            $reason = $this->text('reason', 0, 1000, '');
            $this->run("UPDATE users SET $column = ? WHERE id = ?", [$value, $id]);
            $this->audit($actor['id'], 'user.' . $action, 'user', $id, ['from' => $target[$column], 'to' => $value, 'reason' => $reason]);
            return $this->publicUser($this->one('SELECT * FROM users WHERE id = ?', [$id]), true);
        });
    }

    private function threadSettings(int $id): array
    {
        $actor = $this->requireStaff();
        return $this->transaction(function () use ($id, $actor) {
            $thread = $this->one('SELECT * FROM threads WHERE id = ?', [$id]);
            if (!$thread) {
                $this->notFound();
            }
            $values = [];
            foreach (['is_locked', 'is_news', 'is_featured'] as $key) {
                $values[$key] = (int) $this->boolean($key, (bool) $thread[$key]);
            }
            $this->run('UPDATE threads SET is_locked = ?, is_news = ?, is_featured = ? WHERE id = ?', [...array_values($values), $id]);
            $this->audit($actor['id'], 'thread.settings', 'thread', $id, $values);
            return $this->one('SELECT * FROM threads WHERE id = ?', [$id]);
        });
    }

    private function sectionSettings(int $id): array
    {
        $actor = $this->requireAdmin();
        return $this->transaction(function () use ($id, $actor) {
            $section = $this->one('SELECT * FROM sections WHERE id = ?', [$id]);
            if (!$section) {
                $this->notFound();
            }
            $title = $this->text('title', 1, 200, $section['title']);
            $description = $this->text('description', 0, 4000, $section['description']);
            $archived = (int) $this->boolean('is_archived', (bool) $section['is_archived']);
            $this->run('UPDATE sections SET title = ?, description = ?, is_archived = ? WHERE id = ?', [$title, $description, $archived, $id]);
            $this->audit($actor['id'], 'section.settings', 'section', $id, ['is_archived' => $archived]);
            return $this->one('SELECT * FROM sections WHERE id = ?', [$id]);
        });
    }

    private function visiblePost(int $id): array
    {
        $post = $this->one('SELECT p.*, u.username, u.role AS author_role, u.is_banned AS author_banned
            FROM posts p LEFT JOIN users u ON u.id = p.user_id WHERE p.id = ?', [$id]);
        if (!$post) {
            $this->notFound();
        }
        if ($this->isStaff()) {
            return $post;
        }
        $root = $this->one('SELECT * FROM posts WHERE thread_id = ? AND is_root = 1', [$post['thread_id']]);
        if (!$root || !$this->canSee($root) || !$this->canSee($post)) {
            $this->notFound();
        }
        return $post;
    }

    private function canSee(array $post): bool
    {
        return $post['status'] === 'approved' || ($post['status'] === 'pending' && $this->user
            && (int) $post['user_id'] === (int) $this->user['id']);
    }

    private function postWithAttachments(array $post): array
    {
        unset($post['moderated_by']);
        $post['attachments'] = $this->all('SELECT id, original_name, mime_type, byte_size, spoiler FROM attachments WHERE post_id = ? ORDER BY id', [$post['id']]);
        foreach ($post['attachments'] as &$file) {
            $base = '/api/attachments/' . $file['id'];
            $file['download_url'] = $base . '/download';
            $file['is_image'] = ImagePreview::isImage($file['mime_type']);
            $file['view_url'] = $file['is_image'] ? $base . '/view' : null;
            $file['preview_url'] = $file['is_image'] ? $base . '/preview' : null;
        }
        return $post;
    }

    private function validateFiles(): array
    {
        if (!$_FILES) {
            return [];
        }
        if (array_keys($_FILES) !== ['files'] || !is_array($_FILES['files']['name'] ?? null)) {
            $this->invalid('Используйте поле files[].');
        }
        $input = $_FILES['files'];
        if (count($input['name']) > 10) {
            $this->invalid('Можно приложить не более 10 файлов.');
        }
        $spoilers = $this->input['spoilers'] ?? [];
        if (!is_array($spoilers)) {
            $this->invalid('spoilers[] должен быть массивом индексов файлов.');
        }
        foreach ($spoilers as $index) {
            if (!is_scalar($index) || !ctype_digit((string) $index) || (int) $index >= count($input['name'])) {
                $this->invalid('Некорректный индекс спойлера.');
            }
        }
        $files = [];
        $total = 0;
        $allowed = [
            'image/jpeg' => ['jpg', 'jpeg'], 'image/png' => ['png'], 'image/gif' => ['gif'],
            'image/webp' => ['webp'], 'text/plain' => ['txt'], 'application/pdf' => ['pdf'],
            'application/zip' => ['zip'], 'application/x-zip' => ['zip'],
        ];
        $finfo = new \finfo(FILEINFO_MIME_TYPE);
        foreach ($input['name'] as $i => $name) {
            $error = $input['error'][$i] ?? UPLOAD_ERR_NO_FILE;
            if ($error === UPLOAD_ERR_NO_FILE) {
                continue;
            }
            if ($error !== UPLOAD_ERR_OK) {
                throw new ApiError(422, 'upload_failed', 'Ошибка загрузки файла, код ' . (int) $error . '.');
            }
            $tmp = $input['tmp_name'][$i] ?? '';
            if (!is_string($tmp) || !is_uploaded_file($tmp)) {
                $this->invalid('Некорректный загруженный файл.');
            }
            $size = filesize($tmp);
            $total += $size;
            if ($size < 1 || $size > $this->config['max_file_bytes'] || $total > $this->config['max_post_bytes']) {
                throw new ApiError(413, 'file_too_large', 'Лимит: 5 МиБ на файл, 20 МиБ на сообщение.');
            }
            if (!is_string($name) || !preg_match('//u', $name)) {
                $this->invalid('Имя файла должно быть UTF-8.');
            }
            $name = basename(str_replace('\\', '/', $name));
            if (strlen($name) > 200 || preg_match('/[\x00-\x1F\x7F]/', $name)) {
                $this->invalid('Некорректное имя файла.');
            }
            $mime = $finfo->file($tmp);
            $extension = strtolower(pathinfo($name, PATHINFO_EXTENSION));
            if (!isset($allowed[$mime]) || !in_array($extension, $allowed[$mime], true)) {
                $this->invalid('Недопустимое содержимое или расширение файла.');
            }
            if (str_starts_with($mime, 'image/')) {
                $image = @getimagesize($tmp);
                if (!$image || $image[0] > 12000 || $image[1] > 12000 || $image[0] * $image[1] > 40000000) {
                    $this->invalid('Некорректное или слишком большое изображение.');
                }
            }
            $files[] = ['tmp_name' => $tmp, 'name' => $name, 'mime' => $mime, 'size' => $size,
                'spoiler' => in_array((string) $i, array_map('strval', $spoilers), true)];
        }
        return $files;
    }

    private function attachment(int $id, string $variant): never
    {
        $file = $this->one('SELECT * FROM attachments WHERE id = ?', [$id]);
        if (!$file) {
            $this->notFound();
        }
        $this->visiblePost((int) $file['post_id']);
        $path = $this->config['storage'] . '/uploads/' . $file['storage_name'];
        if (!is_file($path)) {
            $this->notFound();
        }
        if ($variant !== 'download' && !ImagePreview::isImage($file['mime_type'])) {
            $this->notFound();
        }
        session_write_close();
        $mime = 'application/octet-stream';
        $disposition = 'attachment';
        $name = $file['original_name'];
        if ($variant === 'preview') {
            $path = (new ImagePreview($this->config['storage']))->ensure($path, $file['storage_name'], $file['mime_type']);
            $mime = 'image/jpeg';
            $disposition = 'inline';
            $name = 'preview.jpg';
        } elseif ($variant === 'view') {
            $mime = $file['mime_type'];
            $disposition = 'inline';
        }
        if ($variant !== 'download') {
            header("Content-Security-Policy: default-src 'none'; img-src 'self'; frame-ancestors 'none'");
        }
        header('Content-Type: ' . $mime);
        header('Content-Length: ' . filesize($path));
        header("Content-Disposition: $disposition; filename=\"image\"; filename*=UTF-8''" . rawurlencode($name));
        readfile($path);
        exit;
    }

    private function publicUser(?array $user, bool $private = false): ?array
    {
        if (!$user) {
            return null;
        }
        $keys = ['id', 'username', 'role', 'is_banned', 'created_at'];
        if ($private) {
            $keys[] = 'auto_approve';
        }
        return array_intersect_key($user, array_flip($keys));
    }

    private function requireUser(): array
    {
        if (!$this->user) {
            throw new ApiError(401, 'authentication_required', 'Необходимо войти.');
        }
        if ($this->user['is_banned']) {
            throw new ApiError(403, 'banned', 'Аккаунт заблокирован.');
        }
        return $this->user;
    }

    private function isStaff(): bool
    {
        return $this->user && !$this->user['is_banned'] && in_array($this->user['role'], ['moderator', 'admin'], true);
    }

    private function requireStaff(): array
    {
        $user = $this->requireUser();
        if (!$this->isStaff()) {
            throw new ApiError(403, 'forbidden', 'Требуются права модератора.');
        }
        return $user;
    }

    private function requireAdmin(): array
    {
        $user = $this->requireStaff();
        if ($user['role'] !== 'admin') {
            throw new ApiError(403, 'forbidden', 'Требуются права администратора.');
        }
        return $user;
    }

    private function text(string $key, int $min, int $max, ?string $default = null): string
    {
        $value = $this->input[$key] ?? $default;
        if (!is_string($value) || !preg_match('//u', $value) || str_contains($value, "\0")) {
            $this->invalid('Некорректное поле ' . $key . '.');
        }
        $value = trim($value);
        if (strlen($value) < $min || strlen($value) > $max) {
            $this->invalid("Поле $key: от $min до $max байт UTF-8.");
        }
        return $value;
    }

    private function boolean(string $key, ?bool $default = null): bool
    {
        if (!array_key_exists($key, $this->input)) {
            if ($default !== null) {
                return $default;
            }
            $this->invalid('Необходимо поле ' . $key . '.');
        }
        $value = $this->input[$key];
        if (!in_array($value, [true, false, 1, 0, '1', '0'], true)) {
            $this->invalid('Поле ' . $key . ' должно быть true/false или 1/0.');
        }
        return in_array($value, [true, 1, '1'], true);
    }

    private function positiveInt(mixed $value): int
    {
        if ((!is_string($value) && !is_int($value)) || !preg_match('/\A[1-9][0-9]{0,8}\z/', (string) $value)) {
            $this->invalid('Ожидается положительное целое число до 999999999.');
        }
        return (int) $value;
    }

    private function page(string $sql, array $params): array
    {
        $page = isset($_GET['page']) ? $this->positiveInt($_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? min(100, $this->positiveInt($_GET['limit'])) : 20;
        $offset = ($page - 1) * $limit;
        $items = $this->all($sql . ' LIMIT ' . ($limit + 1) . ' OFFSET ' . $offset, $params);
        $hasMore = count($items) > $limit;
        return ['items' => array_slice($items, 0, $limit), 'page' => $page, 'limit' => $limit, 'has_more' => $hasMore];
    }

    private function rateLimit(string $scope, int $limit, int $seconds): void
    {
        // Do not trust client-supplied X-Forwarded-For. Configure the web server's trusted proxy instead.
        $key = trim(file_get_contents($this->config['storage'] . '/app.key'));
        $bucket = hash_hmac('sha256', $scope . ':' . ($_SERVER['REMOTE_ADDR'] ?? 'unknown'), $key);
        $now = time();
        $this->run('DELETE FROM rate_limits WHERE window_start < ?', [$now - 86400]);
        $this->run('INSERT INTO rate_limits(bucket,window_start,hits) VALUES (?,?,1)
            ON CONFLICT(bucket) DO UPDATE SET
            hits = CASE WHEN window_start <= ? THEN 1 ELSE hits + 1 END,
            window_start = CASE WHEN window_start <= ? THEN excluded.window_start ELSE window_start END', [
            $bucket, $now, $now - $seconds, $now - $seconds,
        ]);
        if ($this->one('SELECT hits FROM rate_limits WHERE bucket = ?', [$bucket])['hits'] > $limit) {
            throw new ApiError(429, 'rate_limited', 'Слишком много запросов. Повторите позже.', $seconds);
        }
    }

    private function audit(int $actor, string $action, string $type, int $id, array $details = []): void
    {
        $this->run('INSERT INTO audit_log(actor_id,action,target_type,target_id,details) VALUES (?,?,?,?,?)', [
            $actor, $action, $type, $id, json_encode($details, JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR),
        ]);
    }

    private function transaction(callable $action): mixed
    {
        $this->db->beginTransaction();
        try {
            $result = $action();
            $this->db->commit();
            return $result;
        } catch (Throwable $e) {
            if ($this->db->inTransaction()) {
                $this->db->rollBack();
            }
            throw $e;
        }
    }

    private function run(string $sql, array $params = []): \PDOStatement
    {
        $statement = $this->db->prepare($sql);
        $statement->execute($params);
        return $statement;
    }

    private function one(string $sql, array $params = []): ?array
    {
        return $this->run($sql, $params)->fetch() ?: null;
    }

    private function all(string $sql, array $params = []): array
    {
        return $this->run($sql, $params)->fetchAll();
    }

    private function invalid(string $message): never
    {
        throw new ApiError(422, 'validation_failed', $message);
    }

    private function notFound(): never
    {
        throw new ApiError(404, 'not_found', 'Не найдено.');
    }
}
