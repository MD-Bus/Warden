-- Release limit of a track: how many releases it keeps. When a release is added, or the limit is lowered, the oldest
-- releases beyond the limit (by version) are deleted together with their files. NULL keeps every release.
-- The newest stable release and the newest beta release are never deleted.
ALTER TABLE release_tracks ADD COLUMN keep_releases INTEGER;
