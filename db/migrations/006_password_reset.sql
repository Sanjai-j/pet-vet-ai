-- Pet Vet AI — password reset tokens
--
-- A reset link carries one random, single-use token. Only its SHA-256 hash is
-- stored, so a database leak does not hand out working reset links, and the
-- raw token exists solely in the email that was sent.
--
-- One active token per account: requesting a new link deletes the previous
-- unused ones, so an old email stops working the moment a newer one is asked for.

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id           text PRIMARY KEY,
  user_id      text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   text NOT NULL,
  expires_at   timestamptz NOT NULL,
  used_at      timestamptz,
  requested_ip text,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS password_reset_tokens_hash_idx
  ON password_reset_tokens (token_hash);
CREATE INDEX IF NOT EXISTS password_reset_tokens_user_idx
  ON password_reset_tokens (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS password_reset_tokens_expiry_idx
  ON password_reset_tokens (expires_at);
