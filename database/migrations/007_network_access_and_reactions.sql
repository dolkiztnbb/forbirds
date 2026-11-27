-- Network lists are operator-managed. No remote lookups occur during HTTP requests.
CREATE TABLE network_ranges (
    source TEXT NOT NULL CHECK (source IN ('tor','i2p')),
    cidr TEXT NOT NULL,
    imported_at INTEGER NOT NULL,
    PRIMARY KEY(source,cidr)
);
-- Separate from full account bans: these restrictions never hide public reading.
CREATE TABLE network_write_bans (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('browser','user')),
    value TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('tor','i2p')),
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE(kind,value)
);
CREATE TABLE network_ban_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL CHECK (action IN ('add','remove')),
    kind TEXT NOT NULL,
    value TEXT NOT NULL,
    source TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL
);
CREATE TABLE post_reactions (
    post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reaction_file TEXT NOT NULL,
    PRIMARY KEY(post_id,user_id)
);
CREATE INDEX post_reactions_counts ON post_reactions(post_id,reaction_file);
