ALTER TABLE users ADD COLUMN avatar_locked INTEGER NOT NULL DEFAULT 0 CHECK (avatar_locked IN (0,1));
ALTER TABLE users ADD COLUMN description_locked INTEGER NOT NULL DEFAULT 0 CHECK (description_locked IN (0,1));
ALTER TABLE posts ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0,1));
ALTER TABLE posts ADD COLUMN is_blocked INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0,1));
CREATE TABLE description_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text_hash TEXT NOT NULL UNIQUE,
    actor_id INTEGER NOT NULL REFERENCES users(id),
    reason TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
UPDATE users SET flag_file = 'apeson.png' WHERE flag_file = '''apeson.png';
UPDATE users SET flag_file = 'Cyber-Israel.png' WHERE flag_file = 'Cyber Israel.png';
UPDATE users SET flag_file = 'Gem-Pass.png' WHERE flag_file = 'Gem Pass.png';
UPDATE users SET flag_file = 'Great-Britain.png' WHERE flag_file = 'Great Britain.png';
UPDATE users SET flag_file = 'I-was-raped.png' WHERE flag_file = 'I was raped.png';
