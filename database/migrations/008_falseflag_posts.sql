-- Private attribution log, deliberately separate from posts.* and moderator-visible audit_log.
CREATE TABLE falseflag_posts (
    post_id INTEGER PRIMARY KEY REFERENCES posts(id),
    actor_id INTEGER NOT NULL REFERENCES users(id),
    target_user_id INTEGER NOT NULL REFERENCES users(id),
    actor_name TEXT NOT NULL,
    target_name TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX falseflag_posts_actor ON falseflag_posts(actor_id,post_id);
