-- Preserve IDs, password hashes, repository ownership and sessions. Existing
-- accounts receive deterministic unique usernames in ID order; email login
-- remains available so nobody needs to guess their generated username.
CREATE TABLE users_accounts (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL COLLATE NOCASE,
    email TEXT NOT NULL COLLATE NOCASE,
    password TEXT NOT NULL
);
--> statement-breakpoint
INSERT INTO users_accounts(id,username,email,password)
SELECT id, 'user-' || ROW_NUMBER() OVER (ORDER BY id), lower(trim(email)), password FROM users;
--> statement-breakpoint
DROP TABLE users;
--> statement-breakpoint
ALTER TABLE users_accounts RENAME TO users;
--> statement-breakpoint
CREATE UNIQUE INDEX users_username_unique ON users(username);
--> statement-breakpoint
CREATE UNIQUE INDEX users_email_unique ON users(email);
--> statement-breakpoint
CREATE INDEX idx_sessions_user_expires ON sessions(user,expires);
