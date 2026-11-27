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
    use ModerationTools;
    use Reactions;
    private NetworkAccess $network;
    private AbuseIdentity $identity;
    private ?array $user;
    private array $input = [];
    private FlagCatalog $flags;

    public function __construct(private PDO $db, private array $config)
    {
        $this->flags = new FlagCatalog();
        $this->identity = new AbuseIdentity($db, $config);
        // Reload permissions on every request: bans and trust revocation apply to existing sessions.
        $this->user = isset($_SESSION['user_id'])
            ? $this->one('SELECT * FROM users WHERE id = ?', [$_SESSION['user_id']]) : null;
        $this->network = new NetworkAccess($db, $this->identity, $this->user);
    }

    public function dispatch(string $method, string $path): mixed
    {
        // Request-local downgrade only: never changes the authenticated session or any write permission.
        // The presentation UI requests public data to avoid leaking pending counts/snippets on screen.
        if (in_array($method, ['GET', 'HEAD'], true) && $path !== '/api/session'
            && ($_SERVER['HTTP_X_FORBIRDS_PUBLIC_VIEW'] ?? '') === '1') {
            $this->user = null;
        }

        if ($method === 'HEAD' && preg_match('~^/api/attachments/([1-9][0-9]*)/(download|preview|view)$~D', $path, $m)) {
            $this->attachment((int) $m[1], $m[2]);
        }
        if (!in_array($method, ['GET', 'POST'], true)) {
            throw new ApiError(405, 'method_not_allowed', 'Используйте GET или POST.');
        }
        if ($method === 'POST') {
            $token = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
            if (!is_string($token) || !hash_equals($_SESSION['csrf'], $token)) {
                throw new ApiError(403, 'csrf_failed', 'Получите CSRF-токен через GET /api/session.');
            }
            $this->network->assertWritable();
            $this->input = $this->readInput();
            $this->rateLimit('write', 120, 60);
            if (!$this->isStaff() && !in_array($path, ['/api/auth/login', '/api/auth/logout'], true)) $this->identity->assertAllowed();
            if ($this->user && $this->user['is_banned'] && $path !== '/api/auth/logout') {
                throw new ApiError(403, 'banned', 'Аккаунт заблокирован.');
            }
        }

        if ($method === 'GET') {
            $extra = $this->moderationGet($path);
            if ($extra !== null) return $extra;
            if ($path === '/api/session') {
                return ['csrf_token' => $_SESSION['csrf'], 'user' => $this->publicUser($this->user, true), 'privacy_enabled' => $this->privacyEnabled(), 'read_only' => $this->network->readOnly()];
            }
            if ($path === '/api/posting-status') {
                return (new PostingGuard($this->db, $this->config, $this->user))->status();
            }
            if ($path === '/api/reactions') return array_values((new ReactionCatalog())->all());
            if (preg_match('~^/api/posts/([1-9][0-9]*)/reactions$~D', $path, $m)) {
                $this->visiblePost((int) $m[1]);
                return $this->reactionSummary((int) $m[1]);
            }
            if ($path === '/api/flags') {
                return array_values($this->flags->all());
            }
            if ($path === '/api/sections') {
                return $this->sectionsWithRecentPosts();
            }
            if ($path === '/api/threads') {
                return $this->listThreads();
            }
            if ($path === '/api/me/posts') {
                $user = $this->requireUser();
                return $this->page('SELECT p.* FROM posts p JOIN posts root ON root.thread_id=p.thread_id AND root.is_root=1 WHERE p.user_id = ? AND ' . $this->unrestrictedSql('p') . ' AND ' . $this->unrestrictedSql('root') . ' ORDER BY p.id DESC', [$user['id']]);
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
            if (preg_match('~^/api/users/([1-9][0-9]*)/posts$~D', $path, $m)) {
                return $this->userPosts((int) $m[1]);
            }
            if (preg_match('~^/api/users/([1-9][0-9]*)/avatar$~D', $path, $m)) {
                $this->avatar((int) $m[1]);
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
            $extra = $this->moderationPost($path);
            if ($extra !== null) return $extra;
            if (preg_match('~^/api/posts/([1-9][0-9]*)/reactions$~D', $path, $m)) return $this->react((int) $m[1]);
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
            if ($path === '/api/me/profile') {
                return $this->updateProfile();
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
        $this->network->assertAccountWritable((int) $user['id']);
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

    private function avatarUrl(mixed $id, ?string $name): string
    {
        return $id && $name ? '/api/users/' . (int) $id . '/avatar?v=' . $name : '/avatars/noavatar.png';
    }

    private function avatar(int $id): never
    {
        $user = $this->one('SELECT avatar_name FROM users WHERE id = ?', [$id]);
        if (!$user || !$user['avatar_name']) {
            $this->notFound();
        }
        $path = (new ImagePreview($this->config['storage'], 'avatars'))->path($user['avatar_name']);
        if (!is_file($path)) {
            $this->notFound();
        }
        if ((new MediaBans($this->db))->matches(MediaBans::hashes($path, 'image/jpeg'))) $this->notFound();
        session_write_close();
        header('Content-Type: image/jpeg');
        header('Content-Length: ' . filesize($path));
        header('Content-Disposition: inline; filename="avatar.jpg"');
        readfile($path);
        exit;
    }

    private function updateProfile(): array
    {
        $actor = $this->requireUser();
        $description = array_key_exists('description', $this->input)
            ? $this->text('description', 0, 4000) : null;
        $flag = null;
        $changeFlag = array_key_exists('flag_file', $this->input);
        if ($changeFlag) {
            $flag = $this->text('flag_file', 0, 80);
            if ($flag !== '' && !$this->flags->find($flag)) {
                $this->invalid('Выберите существующий флаг из списка.');
            }
            $flag = $flag !== '' ? $flag : null;
        }
        $remove = $this->boolean('remove_avatar', false);
        if (array_diff(array_keys($_FILES), ['avatar'])) {
            $this->invalid('Используйте поле avatar для аватарки.');
        }
        $file = $_FILES['avatar'] ?? null;
        $name = null;
        if ($actor['avatar_locked'] && ($remove || ($file && ($file['error'] ?? null) !== UPLOAD_ERR_NO_FILE))) {
            throw new ApiError(403, 'profile_locked', 'Изменение этого поля профиля заблокировано модератором.');
        }
        $previews = new ImagePreview($this->config['storage'], 'avatars');
        if ($file && ($file['error'] ?? null) !== UPLOAD_ERR_NO_FILE) {
            $this->rateLimit('avatar', 10, 60);
            if (!is_int($file['error'] ?? null) || $file['error'] !== UPLOAD_ERR_OK
                || !is_string($file['tmp_name'] ?? null) || !is_uploaded_file($file['tmp_name'])) {
                $this->invalid('Не удалось загрузить аватарку. Выберите один файл.');
            }
            if ($remove) {
                $this->invalid('Нельзя одновременно загрузить и удалить аватарку.');
            }
            $size = filesize($file['tmp_name']);
            if ($size < 1 || $size > 2 * 1024 * 1024) {
                throw new ApiError(413, 'avatar_too_large', 'Аватарка должна быть не больше 2 МиБ.');
            }
            $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($file['tmp_name']);
            if (!ImagePreview::isImage($mime)) {
                $this->invalid('Аватарка: JPEG, PNG, GIF или WebP.');
            }
            (new MediaBans($this->db))->check(MediaBans::hashes($file['tmp_name'], $mime));
            $name = bin2hex(random_bytes(24));
            $previews->ensure($file['tmp_name'], $name, $mime);
        }
        $old = null;
        try {
            $result = $this->transaction(function () use ($actor, $description, $remove, $name, $flag, $changeFlag, &$old) {
                // Read the latest avatar inside the transaction, not the potentially stale session snapshot.
                if ($name) (new MediaBans($this->db))->check(MediaBans::hashes((new ImagePreview($this->config['storage'], 'avatars'))->path($name), 'image/jpeg'));
                $current = $this->one('SELECT * FROM users WHERE id = ?', [$actor['id']]);
                if (($name || $remove) && $current['avatar_locked']) {
                    throw new ApiError(403, 'profile_locked', 'Изменение этого поля профиля заблокировано модератором.');
                }
                $nextDescription = $description ?? $current['description'];
                if ($current['description_locked'] && $nextDescription !== $current['description']) {
                    throw new ApiError(403, 'profile_locked', 'Изменение этого поля профиля заблокировано модератором.');
                }
                if ($description !== null && TextBans::matches($this->db, $description)) {
                    throw new ApiError(422, 'description_banned', 'Такое описание профиля запрещено.');
                }
                $old = $current['avatar_name'];
                $avatar = $name ?? ($remove ? null : $old);
                $this->run('UPDATE users SET description = ?, avatar_name = ?, flag_file = ? WHERE id = ?',
                    [$nextDescription, $avatar, $changeFlag ? $flag : $current['flag_file'], $actor['id']]);
                return $this->one('SELECT * FROM users WHERE id = ?', [$actor['id']]);
            });
        } catch (Throwable $e) {
            if ($name && is_file($previews->path($name))) {
                unlink($previews->path($name));
            }
            throw $e;
        }
        if (($name || $remove) && $old && is_file($previews->path($old))) {
            @unlink($previews->path($old));
        }
        $this->user = $result;
        return $this->publicUser($result, true);
    }

    private function userPosts(int $id): array
    {
        if (!$this->one('SELECT id FROM users WHERE id = ?', [$id])) {
            $this->notFound();
        }
        // Apply the same post AND parent visibility as direct post/thread access.
        $visible = static fn (string $alias): string => "$alias.status = 'approved'";
        $params = [$id];
        if ($this->isStaff()) {
            $visible = static fn (string $alias): string => '1 = 1';
        } elseif ($this->user) {
            $viewer = (int) $this->user['id'];
            $visible = static fn (string $alias): string => "($alias.status = 'approved' OR ($alias.status = 'pending' AND $alias.user_id = $viewer))";
        }
        $postVisible = '(' . $visible('p') . ') AND ' . $this->unrestrictedSql('p');
        $rootVisible = '(' . $visible('root') . ') AND ' . $this->unrestrictedSql('root');
        $replyVisible = '(' . $visible('r') . ') AND ' . $this->unrestrictedSql('r');
        $data = $this->page("SELECT p.id, p.thread_id, p.is_root, p.status, p.is_hidden, p.is_blocked, p.created_at,
            substr(p.body, 1, 180) AS excerpt, t.title, t.section_id,
            (SELECT count(*) FROM posts r WHERE r.thread_id = p.thread_id AND r.is_root = 0
                AND r.id < p.id AND ($replyVisible)) AS preceding_replies
            FROM posts p JOIN threads t ON t.id = p.thread_id
            JOIN posts root ON root.thread_id = p.thread_id AND root.is_root = 1
            WHERE p.user_id = ? AND ($postVisible) AND ($rootVisible) ORDER BY p.id DESC", $params);
        foreach ($data['items'] as &$item) {
            $page = $item['is_root'] ? 1 : 1 + intdiv((int) $item['preceding_replies'], 20);
            $item['url'] = '/post.html?id=' . $item['thread_id'] . '&page=' . $page . '#post-' . $item['id'];
            unset($item['preceding_replies']);
        }
        return $data;
    }

    private function sectionsWithRecentPosts(): array
    {
        $sections = $this->all('SELECT * FROM sections ORDER BY id');
        $statuses = $this->isStaff() ? "('approved','pending')" : "('approved')";
        // Links must count the same visible replies as the destination thread page.
        $replyVisibility = "r.status = 'approved'";
        if ($this->isStaff()) {
            $replyVisibility = '1 = 1';
        } elseif ($this->user) {
            $viewer = (int) $this->user['id'];
            $replyVisibility = "(r.status = 'approved' OR (r.status = 'pending' AND r.user_id = $viewer))";
        }
        $replyVisibility = '(' . $replyVisibility . ') AND ' . $this->unrestrictedSql('r');
        $recentVisibility = $this->unrestrictedSql('p') . ' AND ' . $this->unrestrictedSql('root');
        $recent = $this->all("WITH recent AS (
            SELECT p.id, p.thread_id, p.is_root, p.status, p.created_at, substr(p.body,1,100) AS excerpt,
                t.section_id, t.title, u.username,
                row_number() OVER (PARTITION BY t.section_id ORDER BY p.id DESC) AS position
            FROM posts p JOIN threads t ON t.id = p.thread_id
            JOIN posts root ON root.thread_id = t.id AND root.is_root = 1
            LEFT JOIN users u ON u.id = p.user_id
            WHERE p.status IN $statuses AND root.status IN $statuses AND $recentVisibility
        ) SELECT recent.*, (SELECT count(*) FROM posts r
            WHERE r.thread_id = recent.thread_id AND r.is_root = 0 AND r.id < recent.id
                AND ($replyVisibility)) AS preceding_replies
            FROM recent WHERE position <= 5 ORDER BY section_id, id DESC");
        $bySection = [];
        foreach ($recent as $item) {
            $page = $item['is_root'] ? 1 : 1 + intdiv((int) $item['preceding_replies'], 20);
            $item['url'] = '/post.html?id=' . $item['thread_id'] . '&page=' . $page . '#post-' . $item['id'];
            unset($item['position'], $item['preceding_replies']);
            $bySection[$item['section_id']][] = $item;
        }
        foreach ($sections as &$section) {
            $section['recent_posts'] = $bySection[$section['id']] ?? [];
        }
        return $sections;
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
        $where = ["p.status IN $statuses", $this->unrestrictedSql('p')];
        $searchVisible = $this->unrestrictedSql('search_post');
        $replyVisible = $this->unrestrictedSql('r');
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
                AND search_post.status IN $statuses AND $searchVisible AND instr(unicode_lower(search_post.body), unicode_lower(?)) > 0))";
            array_push($params, $_GET['q'], $_GET['q']);
        }
        $pendingCount = $this->isStaff()
            ? "(SELECT count(*) FROM posts r WHERE r.thread_id = t.id AND r.is_root = 0 AND r.status = 'pending')" : '0';
        $bumpOrder = "(SELECT coalesce(max(bp.bump_order),0) FROM posts bp WHERE bp.thread_id=t.id AND bp.status='approved' AND bp.is_hidden=0 AND bp.is_blocked=0) DESC, t.id DESC";
        $order = ($this->isStaff() ? "(p.status = 'pending') DESC, (pending_reply_count > 0) DESC, " : '') . $bumpOrder;
        return $this->page("SELECT t.*, p.id AS post_id, p.body, p.user_id, p.status, u.username,
            (SELECT count(*) FROM posts r WHERE r.thread_id = t.id AND r.is_root = 0 AND r.status IN $statuses AND $replyVisible) AS reply_count,
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
        $condition = "($condition) AND " . $this->unrestrictedSql('p');
        $replies = $this->page("SELECT p.*, u.username, u.role AS author_role, u.is_banned AS author_banned, u.avatar_name AS author_avatar_name, u.flag_file AS author_flag_file
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
        $postAs = null;
        $falseflagReason = null;
        if (array_key_exists('post_as_user_id', $this->input)) {
            $this->requireAdmin();
            $postAs = $this->positiveInt($this->input['post_as_user_id']);
            $falseflagReason = $this->text('falseflag_reason', 1, 1000);
        }
        $sage = $threadId !== null && $this->boolean('sage', false);
        $files = $this->validateFiles();
        $moved = [];
        try {
            return $this->transaction(function () use ($threadId, $body, $title, $sectionId, $news, $featured, $files, $sage, $postAs, $falseflagReason, &$moved) {
                (new PostingGuard($this->db, $this->config, $this->user))->consume($this->input);
                $target = null;
                $actor = null;
                if ($postAs !== null) {
                    // Recheck privilege under the write lock. Attribution never changes the session/PoW subject.
                    $actor = $this->one('SELECT * FROM users WHERE id=?', [$this->user['id']]);
                    if (!$actor || $actor['is_banned'] || $actor['role'] !== 'admin') throw new ApiError(403, 'forbidden', 'Требуются права администратора.');
                    $target = $this->one('SELECT id,username FROM users WHERE id=?', [$postAs]);
                    if (!$target) $this->notFound();
                }
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
                $this->run('INSERT INTO posts(thread_id,user_id,is_root,body,status,sage,bump_order,author_ip,browser_id,fingerprint) VALUES (?,?,?,?,?,?,?,?,?,?)', [
                    $threadId, $postAs ?? ($this->user['id'] ?? null), (int) $isRoot, $body, $status, (int) $sage,
                    $status === 'approved' && !$sage ? (int) $this->one('SELECT coalesce(max(bump_order),0)+1 AS n FROM posts')['n'] : 0,
                    $this->identity->ip, $this->identity->browser, $this->identity->fingerprint,
                ]);
                $id = (int) $this->db->lastInsertId();
                if ($target) {
                    $this->run('INSERT INTO falseflag_posts(post_id,actor_id,target_user_id,actor_name,target_name,reason) VALUES (?,?,?,?,?,?)',
                        [$id, $actor['id'], $target['id'], $actor['username'], $target['username'], $falseflagReason]);
                }
                foreach ($files as $file) {
                    // Decode and screen only after a valid proof and cooldown check.
                    $file += MediaBans::hashes($file['tmp_name'], $file['mime']);
                    (new MediaBans($this->db))->check($file);
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
                    $this->run('INSERT INTO attachments(post_id,storage_name,original_name,mime_type,byte_size,spoiler,sha256,dhash,ahash) VALUES (?,?,?,?,?,?,?,?,?)', [
                        $id, $name, $file['name'], $file['mime'], $file['size'], (int) $file['spoiler'],
                        $file['sha256'], $file['dhash'], $file['ahash'],
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
            if ($status === 'approved' && $post['is_blocked']) throw new ApiError(409, 'post_blocked', 'Сначала разблокируйте сообщение.');
            if ($status === 'approved' && $post['status'] !== 'approved' && !$post['sage']) {
                $this->run('UPDATE posts SET bump_order = (SELECT coalesce(max(bump_order),0)+1 FROM posts) WHERE id = ?', [$id]);
            }
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
        $post = $this->one('SELECT p.*, u.username, u.role AS author_role, u.is_banned AS author_banned, u.avatar_name AS author_avatar_name, u.flag_file AS author_flag_file
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

    private function unrestrictedSql(string $alias): string
    {
        return $this->isStaff() ? '1=1' : "($alias.is_hidden=0 AND $alias.is_blocked=0)";
    }

    private function canSee(array $post): bool
    {
        return !$post['is_hidden'] && !$post['is_blocked'] && ($post['status'] === 'approved' || ($post['status'] === 'pending' && $this->user
            && (int) $post['user_id'] === (int) $this->user['id']));
    }

    private function postWithAttachments(array $post): array
    {
        $post['avatar_url'] = $this->avatarUrl($post['user_id'] ?? null, $post['author_avatar_name'] ?? null);
        $post['flag'] = $this->flags->find($post['author_flag_file'] ?? null);
        unset($post['moderated_by'], $post['author_avatar_name'], $post['author_flag_file']);
        $post['reactions'] = $this->reactionSummary((int) $post['id']);
        $post['attachments'] = [];
        foreach ($this->all('SELECT * FROM attachments WHERE post_id = ? ORDER BY id', [$post['id']]) as $stored) {
            $stored = $this->indexedAttachment($stored);
            $blocked = $stored['sha256'] && (new MediaBans($this->db))->matches($stored);
            $available = $stored['moderation_state'] === 'visible' && !$blocked;
            if (!$available && !$this->isStaff()) continue;
            $file = array_intersect_key($stored, array_flip(['id','original_name','mime_type','byte_size','spoiler','moderation_state']));
            $file['blocked'] = (bool) $blocked;
            $base = '/api/attachments/' . $file['id'];
            $file['download_url'] = $available ? $base . '/download' : null;
            $file['is_image'] = ImagePreview::isImage($file['mime_type']);
            $file['is_audio'] = MediaFile::isAudio($file['mime_type'], $file['original_name']);
            $file['is_video'] = !$file['is_audio'] && MediaFile::isVideo($file['mime_type']);
            $file['view_url'] = $available && ($file['is_image'] || $file['is_video'] || $file['is_audio']) ? $base . '/view' : null;
            $file['preview_url'] = $available && $file['is_image'] ? $base . '/preview' : null;
            $post['attachments'][] = $file;
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
            'video/mp4' => ['mp4'], 'video/webm' => ['webm'],
        ];
        foreach (MediaFile::AUDIO_TYPES as $mime => $extensions) {
            $allowed[$mime] = array_merge($allowed[$mime] ?? [], $extensions);
        }
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
        $file = $this->indexedAttachment($file);
        if ($file['moderation_state'] !== 'visible' || ($file['sha256'] && (new MediaBans($this->db))->matches($file))) $this->notFound();
        $path = $this->config['storage'] . '/uploads/' . $file['storage_name'];
        if (!is_file($path)) {
            $this->notFound();
        }
        if (($variant === 'preview' && !ImagePreview::isImage($file['mime_type']))
            || ($variant === 'view' && !ImagePreview::isImage($file['mime_type']) && !MediaFile::isVideo($file['mime_type']) && !MediaFile::isAudio($file['mime_type'], $file['original_name']))) {
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
            $mime = MediaFile::playbackMime($file['mime_type'], $file['original_name']);
            $disposition = 'inline';
        }
        if ($variant !== 'download') {
            header("Content-Security-Policy: default-src 'none'; img-src 'self'; media-src 'self'; frame-ancestors 'none'");
        }
        MediaFile::send($path, $mime, $disposition, $name);
    }

    private function publicUser(?array $user, bool $private = false): ?array
    {
        if (!$user) {
            return null;
        }
        if (TextBans::matches($this->db, $user['description'])) $user['description'] = '';
        $user['avatar_url'] = $this->avatarUrl($user['id'], $user['avatar_name'] ?? null);
        $user['flag'] = $this->flags->find($user['flag_file'] ?? null);
        $keys = ['id', 'username', 'role', 'is_banned', 'created_at', 'description', 'avatar_url', 'flag'];
        if ($private) {
            $keys[] = 'auto_approve';
            $keys[] = 'avatar_locked';
            $keys[] = 'description_locked';
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
