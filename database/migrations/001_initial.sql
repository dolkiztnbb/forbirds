CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','moderator','admin')),
    auto_approve INTEGER NOT NULL DEFAULT 0 CHECK (auto_approve IN (0,1)),
    is_banned INTEGER NOT NULL DEFAULT 0 CHECK (is_banned IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE sections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_id INTEGER NOT NULL REFERENCES sections(id),
    title TEXT NOT NULL,
    is_news INTEGER NOT NULL DEFAULT 0 CHECK (is_news IN (0,1)),
    is_featured INTEGER NOT NULL DEFAULT 0 CHECK (is_featured IN (0,1)),
    is_locked INTEGER NOT NULL DEFAULT 0 CHECK (is_locked IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL REFERENCES threads(id),
    user_id INTEGER REFERENCES users(id),
    is_root INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0,1)),
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','deleted')),
    moderated_by INTEGER REFERENCES users(id),
    moderated_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX posts_one_root ON posts(thread_id) WHERE is_root = 1;
CREATE INDEX posts_thread_status ON posts(thread_id, status, id);
CREATE INDEX posts_queue ON posts(status, id);
CREATE INDEX posts_author ON posts(user_id, id);
CREATE INDEX threads_section ON threads(section_id, id);
CREATE TABLE attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL REFERENCES posts(id),
    storage_name TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size > 0),
    spoiler INTEGER NOT NULL DEFAULT 0 CHECK (spoiler IN (0,1)),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX attachments_post ON attachments(post_id);
CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    action TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    details TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE rate_limits (
    bucket TEXT PRIMARY KEY,
    window_start INTEGER NOT NULL,
    hits INTEGER NOT NULL
);
