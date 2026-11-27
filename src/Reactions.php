<?php
declare(strict_types=1);

namespace ForBirds;

trait Reactions
{
    private function reactionSummary(int $id): array
    {
        $catalog = new ReactionCatalog();
        if (!$catalog->all()) return [];
        $counts = [];
        foreach ($this->all('SELECT reaction_file,count(*) AS total FROM post_reactions WHERE post_id=? GROUP BY reaction_file', [$id]) as $row) {
            $counts[$row['reaction_file']] = (int) $row['total'];
        }
        $mine = $this->user ? $this->one('SELECT reaction_file FROM post_reactions WHERE post_id=? AND user_id=?', [$id, $this->user['id']]) : null;
        $items = [];
        foreach ($catalog->all() as $file => $item) {
            $items[] = $item + ['count' => $counts[$file] ?? 0, 'selected' => ($mine['reaction_file'] ?? null) === $file];
        }
        return $items;
    }

    private function react(int $id): array
    {
        $user = $this->requireUser();
        $file = $this->text('reaction', 0, 100);
        // Empty string removes a vote, even if its image has been removed from the catalog.
        if ($file !== '' && !(new ReactionCatalog())->find($file)) $this->invalid('Неизвестная реакция.');
        $this->rateLimit('reaction', 30, 60);
        return $this->transaction(function () use ($id, $file, $user) {
            $post = $this->visiblePost($id);
            $root = $this->one('SELECT p.status,t.is_locked,s.is_archived FROM posts p JOIN threads t ON t.id=p.thread_id JOIN sections s ON s.id=t.section_id WHERE p.thread_id=? AND p.is_root=1', [$post['thread_id']]);
            if ($post['status'] !== 'approved' || $root['status'] !== 'approved' || $root['is_locked'] || $root['is_archived']) {
                throw new ApiError(409, 'reactions_unavailable', 'Реакции для этого сообщения недоступны.');
            }
            $this->run('DELETE FROM post_reactions WHERE post_id=? AND user_id=?', [$id, $user['id']]);
            if ($file !== '') $this->run('INSERT INTO post_reactions(post_id,user_id,reaction_file) VALUES (?,?,?)', [$id, $user['id'], $file]);
            return $this->reactionSummary($id);
        });
    }
}
