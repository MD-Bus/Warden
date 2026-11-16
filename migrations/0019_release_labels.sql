-- Release labels. Each track defines its labels (JSON array of { key, name, color }); NULL, as for every existing
-- track, means the default labels (urgent, security, bug_fix, feature). A release stores the keys of its labels,
-- comma separated, and sites receive them with the release.
ALTER TABLE release_tracks ADD COLUMN labels TEXT;
ALTER TABLE files ADD COLUMN labels TEXT NOT NULL DEFAULT '';

-- "Mark as urgent" (0.6.3) wrote [urgent] into the release notes. Those releases get the urgent label, and the marker
-- that button added is taken out of their notes.
UPDATE files SET labels = 'urgent' WHERE version <> '' AND track_id IS NOT NULL AND instr(lower(changelog), '[urgent]') > 0;
UPDATE files
SET changelog = trim(replace(replace(changelog, char(10) || char(10) || '[urgent]', ''), '[urgent]', ''), ' ' || char(9) || char(10) || char(13))
WHERE labels = 'urgent';
