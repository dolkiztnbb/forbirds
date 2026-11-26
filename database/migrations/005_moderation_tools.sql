ALTER TABLE posts ADD COLUMN sage INTEGER NOT NULL DEFAULT 0 CHECK (sage IN (0,1));
ALTER TABLE posts ADD COLUMN bump_order INTEGER NOT NULL DEFAULT 0;
ALTER TABLE posts ADD COLUMN author_ip TEXT;
ALTER TABLE posts ADD COLUMN browser_id TEXT;
ALTER TABLE posts ADD COLUMN fingerprint TEXT;
UPDATE posts SET bump_order = id WHERE status = 'approved';
CREATE INDEX posts_bump ON posts(thread_id, status, bump_order);
ALTER TABLE attachments ADD COLUMN moderation_state TEXT NOT NULL DEFAULT 'visible' CHECK (moderation_state IN ('visible','hidden','deleted'));
ALTER TABLE attachments ADD COLUMN sha256 TEXT;
ALTER TABLE attachments ADD COLUMN dhash TEXT;
ALTER TABLE attachments ADD COLUMN ahash TEXT;
CREATE INDEX attachments_sha ON attachments(sha256);
CREATE TABLE media_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sha256 TEXT NOT NULL UNIQUE,
    dhash TEXT,
    ahash TEXT,
    reason TEXT NOT NULL DEFAULT '',
    actor_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE TABLE identity_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('cidr','browser','fingerprint')),
    value TEXT NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    actor_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    UNIQUE(kind, value)
);
CREATE TABLE privacy_access (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    post_id INTEGER NOT NULL REFERENCES posts(id),
    created_at INTEGER NOT NULL
);
