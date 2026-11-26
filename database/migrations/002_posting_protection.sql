-- Shared across sessions, processes and restarts. No raw IPs are stored.
CREATE TABLE posting_limits (
    subject TEXT PRIMARY KEY,
    last_post_at INTEGER NOT NULL
);
CREATE TABLE pow_challenges (
    id TEXT PRIMARY KEY,
    binding TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    difficulty INTEGER NOT NULL CHECK (difficulty BETWEEN 8 AND 24),
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX pow_expiry ON pow_challenges(expires_at);
