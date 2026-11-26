<?php
declare(strict_types=1);

namespace ForBirds;

/** Staff-only actions. All values are bound; identifiers and actions are allowlisted. */
trait ModerationTools
{
    private function privacyEnabled(): bool
    {
        return $this->isStaff() && $this->user['role'] === 'admin' && !empty($_SESSION['show_identity']);
    }

    private function identityForPost(int $id): array
    {
        $actor = $this->requireAdmin();
        if (!$this->privacyEnabled()) throw new ApiError(403, 'privacy_disabled', 'Сначала включите показ IP в панели управления.');
        $post = $this->one('SELECT author_ip,browser_id,fingerprint FROM posts WHERE id = ?', [$id]);
        if (!$post) $this->notFound();
        $this->run('INSERT INTO privacy_access(actor_id,post_id,created_at) VALUES (?,?,?)', [$actor['id'], $id, time()]);
        return ['ip' => $post['author_ip'], 'cid' => $post['browser_id'], 'hid' => $post['fingerprint']];
    }

    private function identityBan(): array
    {
        $actor = $this->requireAdmin();
        if (!$this->privacyEnabled()) throw new ApiError(403, 'privacy_disabled', 'Сначала включите показ IP в панели управления.');
        $kind = $this->text('kind', 1, 20);
        if (!in_array($kind, ['cidr', 'browser', 'fingerprint'], true)) $this->invalid('Некорректный тип блокировки.');
        if ($kind === 'cidr') {
            $value = AbuseIdentity::cidr($this->text('value', 1, 100));
            if ($value === null) $this->invalid('Некорректная IP-сеть.');
        } else {
            $id = $this->positiveInt($this->input['post_id'] ?? null);
            $row = $this->one('SELECT browser_id,fingerprint FROM posts WHERE id = ?', [$id]);
            if (!$row) $this->notFound();
            $value = $row[$kind === 'browser' ? 'browser_id' : 'fingerprint'];
            if (!$value) $this->invalid('Для этого сообщения нет такого идентификатора.');
        }
        $hours = $this->positiveInt($this->input['hours'] ?? 24);
        if ($hours > 8760) $this->invalid('Максимальный срок блокировки — 8760 часов.');
        $reason = $this->text('reason', 1, 1000);
        return $this->transaction(function () use ($actor, $kind, $value, $hours, $reason) {
            $this->run('INSERT INTO identity_bans(kind,value,reason,actor_id,expires_at) VALUES (?,?,?,?,?)
                ON CONFLICT(kind,value) DO UPDATE SET reason=excluded.reason,actor_id=excluded.actor_id,expires_at=excluded.expires_at',
                [$kind, $value, $reason, $actor['id'], time() + $hours * 3600]);
            $id = $this->one('SELECT id FROM identity_bans WHERE kind = ? AND value = ?', [$kind, $value])['id'];
            $this->audit($actor['id'], 'identity.ban', 'identity_ban', $id, ['kind' => $kind, 'hours' => $hours]);
            return ['id' => $id];
        });
    }

    private function movePost(int $id): array
    {
        $actor = $this->requireStaff();
        $reason = $this->text('reason', 1, 1000);
        return $this->transaction(function () use ($id, $actor, $reason) {
            $post = $this->one('SELECT * FROM posts WHERE id = ?', [$id]);
            if (!$post) $this->notFound();
            if ($post['is_root']) {
                $target = $this->positiveInt($this->input['section_id'] ?? null);
                if (!$this->one('SELECT id FROM sections WHERE id = ?', [$target])) $this->notFound();
                $from = $this->one('SELECT section_id FROM threads WHERE id = ?', [$post['thread_id']])['section_id'];
                if ((int) $from === $target) $this->invalid('Источник и назначение совпадают.');
                $this->run('UPDATE threads SET section_id = ? WHERE id = ?', [$target, $post['thread_id']]);
                $kind = 'section';
            } else {
                $target = $this->positiveInt($this->input['thread_id'] ?? null);
                $root = $this->one('SELECT id,status FROM posts WHERE thread_id = ? AND is_root = 1', [$target]);
                if (!$root || $root['status'] === 'deleted') $this->notFound();
                $from = (int) $post['thread_id'];
                if ($from === $target) $this->invalid('Источник и назначение совпадают.');
                $this->run('UPDATE posts SET thread_id = ? WHERE id = ?', [$target, $id]);
                $kind = 'thread';
            }
            $this->audit($actor['id'], 'post.move', 'post', $id, ['from' => $from, 'to' => $target, 'kind' => $kind, 'reason' => $reason]);
            return ['post_id' => $id, 'thread_id' => $post['is_root'] ? $post['thread_id'] : $target];
        });
    }

    private function indexedAttachment(array $file): array
    {
        if (!$file['sha256'] && $file['moderation_state'] !== 'deleted') {
            $path = $this->config['storage'] . '/uploads/' . $file['storage_name'];
            if (is_file($path)) {
                $hashes = MediaBans::hashes($path, $file['mime_type']);
                $this->run('UPDATE attachments SET sha256 = ?, dhash = ?, ahash = ? WHERE id = ?',
                    [$hashes['sha256'], $hashes['dhash'], $hashes['ahash'], $file['id']]);
                $file = array_merge($file, $hashes);
            }
        }
        return $file;
    }

    private function moderateAttachment(int $id): array
    {
        $actor = $this->requireStaff();
        $action = $this->text('action', 1, 20);
        if (!in_array($action, ['spoiler', 'unspoiler', 'hide', 'show', 'delete', 'hashban'], true)) $this->invalid('Некорректное действие с файлом.');
        $reason = $this->text('reason', 1, 1000);
        $file = $this->transaction(function () use ($id, $actor, $action, $reason) {
            $file = $this->one('SELECT * FROM attachments WHERE id = ?', [$id]);
            if (!$file) $this->notFound();
            if ($file['moderation_state'] === 'deleted') throw new ApiError(409, 'file_deleted', 'Файл уже удалён.');
            if ($action === 'hashban') {
                $file = $this->indexedAttachment($file);
                if (!$file['sha256']) $this->notFound();
                $this->run('INSERT INTO media_bans(sha256,dhash,ahash,reason,actor_id) VALUES (?,?,?,?,?)
                    ON CONFLICT(sha256) DO NOTHING', [$file['sha256'], $file['dhash'], $file['ahash'], $reason, $actor['id']]);
            }
            if ($action === 'spoiler' || $action === 'unspoiler') {
                $this->run('UPDATE attachments SET spoiler = ? WHERE id = ?', [(int) ($action === 'spoiler'), $id]);
            } else {
                $state = match ($action) { 'show' => 'visible', 'hide' => 'hidden', default => 'deleted' };
                $this->run('UPDATE attachments SET moderation_state = ? WHERE id = ?', [$state, $id]);
            }
            $this->audit($actor['id'], 'attachment.' . $action, 'attachment', $id, ['reason' => $reason, 'post_id' => $file['post_id']]);
            return $file;
        });
        if (in_array($action, ['delete', 'hashban'], true)) {
            foreach ([$this->config['storage'] . '/uploads/' . $file['storage_name'],
                (new ImagePreview($this->config['storage']))->path($file['storage_name'])] as $path) {
                if (is_file($path) && !@unlink($path)) error_log('Cannot purge moderated attachment #' . $id);
            }
        }
        return ['id' => $id, 'post_id' => $file['post_id']];
    }

    private function moderateProfile(int $id): array
    {
        $actor = $this->requireStaff();
        $action = $this->text('action', 1, 32);
        $actions = ['avatar_delete', 'avatar_hashban', 'avatar_lock', 'avatar_unlock',
            'description_delete', 'description_hashban', 'description_lock', 'description_unlock'];
        if (!in_array($action, $actions, true)) $this->invalid('Некорректное действие с профилем.');
        $reason = $this->text('reason', 1, 1000);
        $old = $this->transaction(function () use ($id, $actor, $action, $reason) {
            $target = $this->one('SELECT * FROM users WHERE id = ?', [$id]);
            if (!$target) $this->notFound();
            if ($target['role'] === 'admin' || (int) $actor['id'] === $id || ($actor['role'] !== 'admin' && $target['role'] !== 'user')) {
                throw new ApiError(403, 'forbidden', 'Нельзя изменять этого пользователя.');
            }
            if ($action === 'avatar_hashban') {
                if (!$target['avatar_name']) $this->notFound();
                $path = (new ImagePreview($this->config['storage'], 'avatars'))->path($target['avatar_name']);
                if (!is_file($path)) $this->notFound();
                $hashes = MediaBans::hashes($path, 'image/jpeg');
                $this->run('INSERT INTO media_bans(sha256,dhash,ahash,reason,actor_id) VALUES (?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING',
                    [$hashes['sha256'], $hashes['dhash'], $hashes['ahash'], $reason, $actor['id']]);
            }
            if ($action === 'description_hashban') {
                $hash = TextBans::hash($target['description']);
                if ($hash === TextBans::hash('')) $this->invalid('Нельзя запретить пустое описание.');
                $this->run('INSERT INTO description_bans(text_hash,actor_id,reason) VALUES (?,?,?) ON CONFLICT(text_hash) DO NOTHING',
                    [$hash, $actor['id'], $reason]);
            }
            if (in_array($action, ['avatar_delete', 'avatar_hashban'], true)) {
                $this->run('UPDATE users SET avatar_name=NULL WHERE id=?', [$id]);
            } elseif (in_array($action, ['description_delete', 'description_hashban'], true)) {
                $this->run("UPDATE users SET description='' WHERE id=?", [$id]);
            } else {
                $column = str_starts_with($action, 'avatar_') ? 'avatar_locked' : 'description_locked';
                $this->run("UPDATE users SET $column=? WHERE id=?", [(int) str_ends_with($action, '_lock'), $id]);
            }
            $this->audit($actor['id'], 'profile.' . $action, 'user', $id, ['reason' => $reason]);
            return $target['avatar_name'];
        });
        if ($old && in_array($action, ['avatar_delete', 'avatar_hashban'], true)) {
            $path = (new ImagePreview($this->config['storage'], 'avatars'))->path($old);
            if (is_file($path) && !@unlink($path)) error_log('Cannot purge moderated avatar for user #' . $id);
        }
        return $this->publicUser($this->one('SELECT * FROM users WHERE id=?', [$id]), true);
    }

    private function restrictPost(int $id): array
    {
        $actor = $this->requireStaff();
        $action = $this->text('action', 1, 20);
        if (!in_array($action, ['hide', 'unhide', 'block', 'unblock'], true)) $this->invalid('Некорректное ограничение поста.');
        $reason = $this->text('reason', 1, 1000);
        return $this->transaction(function () use ($id, $actor, $action, $reason) {
            $post = $this->one('SELECT * FROM posts WHERE id=?', [$id]);
            if (!$post) $this->notFound();
            $column = in_array($action, ['hide', 'unhide'], true) ? 'is_hidden' : 'is_blocked';
            $enabled = (int) in_array($action, ['hide', 'block'], true);
            $this->run("UPDATE posts SET $column=? WHERE id=?", [$enabled, $id]);
            $this->audit($actor['id'], 'post.' . $action, 'post', $id, ['reason' => $reason, 'from' => $post[$column], 'to' => $enabled]);
            return ['post_id' => $id, 'is_hidden' => $column === 'is_hidden' ? $enabled : $post['is_hidden'],
                'is_blocked' => $column === 'is_blocked' ? $enabled : $post['is_blocked']];
        });
    }

    private function moderationGet(string $path): ?array
    {
        if ($path === '/api/moderation/description-bans') {
            $this->requireStaff();
            return $this->page('SELECT id,reason,actor_id,created_at FROM description_bans ORDER BY id DESC', []);
        }
        if ($path === '/api/moderation/restricted') {
            $this->requireStaff();
            return $this->page('SELECT p.*,t.title FROM posts p JOIN threads t ON t.id=p.thread_id WHERE p.is_hidden=1 OR p.is_blocked=1 ORDER BY p.id DESC', []);
        }
        if ($path === '/api/moderation/archive') {
            $this->requireStaff();
            return $this->page("SELECT p.*,t.title FROM posts p JOIN threads t ON t.id=p.thread_id WHERE p.status IN ('deleted','rejected') ORDER BY p.id DESC", []);
        }
        if (preg_match('~^/api/posts/([1-9][0-9]*)/identity$~D', $path, $m)) return $this->identityForPost((int) $m[1]);
        if ($path === '/api/moderation/media-bans') {
            $this->requireStaff();
            return $this->page('SELECT id,reason,actor_id,created_at FROM media_bans ORDER BY id DESC', []);
        }
        if ($path === '/api/moderation/identity-bans') {
            $this->requireAdmin();
            if (!$this->privacyEnabled()) throw new ApiError(403, 'privacy_disabled', 'Сначала включите показ IP в панели управления.');
            return $this->page('SELECT * FROM identity_bans ORDER BY id DESC', []);
        }
        return null;
    }

    private function moderationPost(string $path): ?array
    {
        if ($path === '/api/moderation/privacy') {
            $actor = $this->requireAdmin();
            $enabled = $this->boolean('enabled');
            $_SESSION['show_identity'] = $enabled;
            $this->audit($actor['id'], 'privacy.toggle', 'user', $actor['id'], ['enabled' => $enabled]);
            return ['enabled' => $enabled];
        }
        if ($path === '/api/moderation/identity-bans') return $this->identityBan();
        if (preg_match('~^/api/users/([1-9][0-9]*)/profile/moderate$~D', $path, $m)) return $this->moderateProfile((int) $m[1]);
        if (preg_match('~^/api/posts/([1-9][0-9]*)/restrict$~D', $path, $m)) return $this->restrictPost((int) $m[1]);
        if (preg_match('~^/api/posts/([1-9][0-9]*)/move$~D', $path, $m)) return $this->movePost((int) $m[1]);
        if (preg_match('~^/api/attachments/([1-9][0-9]*)/moderate$~D', $path, $m)) return $this->moderateAttachment((int) $m[1]);
        if (preg_match('~^/api/moderation/(media-bans|identity-bans|description-bans)/([1-9][0-9]*)/remove$~D', $path, $m)) {
            $actor = $m[1] === 'identity-bans' ? $this->requireAdmin() : $this->requireStaff();
            if ($m[1] === 'identity-bans' && !$this->privacyEnabled()) throw new ApiError(403, 'privacy_disabled', 'Сначала включите показ IP в панели управления.');
            $reason = $this->text('reason', 1, 1000);
            $table = ['media-bans' => 'media_bans', 'identity-bans' => 'identity_bans', 'description-bans' => 'description_bans'][$m[1]];
            return $this->transaction(function () use ($table, $m, $actor, $reason) {
                if (!$this->one("SELECT id FROM $table WHERE id = ?", [(int) $m[2]])) $this->notFound();
                $this->run("DELETE FROM $table WHERE id = ?", [(int) $m[2]]);
                $this->audit($actor['id'], 'ban.remove', $table, (int) $m[2], ['reason' => $reason]);
                return ['removed' => true];
            });
        }
        return null;
    }
}
