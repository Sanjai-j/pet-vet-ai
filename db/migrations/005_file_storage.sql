-- Persistent file bytes for hosts without a disk.
--
-- Render's free web service has an ephemeral filesystem: anything written to
-- uploads/ disappears on the next restart or deploy. When FILE_STORAGE=db the
-- API keeps the bytes in this column instead, so a pet photo or a vet
-- credential still resolves after a redeploy. Development keeps using the
-- disk unless the flag is set.

ALTER TABLE files ADD COLUMN IF NOT EXISTS data bytea;
