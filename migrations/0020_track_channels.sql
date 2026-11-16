-- Channels per track. A track stores its channels as JSON (array of { key, name, includes }); NULL, as for every
-- existing track, means stable and beta, with beta including stable: exactly how channels behaved before.
ALTER TABLE release_tracks ADD COLUMN channels TEXT;

-- Each channel of a track can follow its own repository and branch. Existing sources become the stable channel's
-- source with no branch, which keeps their rule: a tag with a suffix such as v2.0.0-beta.1 is published on beta.
ALTER TABLE release_sources ADD COLUMN channel TEXT NOT NULL DEFAULT 'stable';
ALTER TABLE release_sources ADD COLUMN branch TEXT NOT NULL DEFAULT '';
DROP INDEX IF EXISTS idx_release_sources_track;
CREATE UNIQUE INDEX idx_release_sources_track_channel ON release_sources (track_id, channel) WHERE track_id IS NOT NULL;

-- Sites can now check on a channel a track defines, so the reported channel is no longer limited to stable and beta.
-- SQLite cannot drop a CHECK constraint: the table is rebuilt with the same rows.
CREATE TABLE activation_versions_new (
  attachment_id TEXT NOT NULL REFERENCES license_apps (id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  version TEXT,
  last_seen_at INTEGER NOT NULL,
  channel TEXT NOT NULL DEFAULT 'stable',
  PRIMARY KEY (attachment_id, domain)
);
INSERT INTO activation_versions_new (attachment_id, domain, version, last_seen_at, channel)
SELECT attachment_id, domain, version, last_seen_at, channel FROM activation_versions;
DROP TABLE activation_versions;
ALTER TABLE activation_versions_new RENAME TO activation_versions;
