-- The release channel each site last checked on, so the dashboard compares a site with the same release its check is
-- offered. Existing sites start on stable and pick up their channel with their next check that reports a version.
ALTER TABLE activation_versions ADD COLUMN channel TEXT NOT NULL DEFAULT 'stable' CHECK (channel IN ('stable', 'beta'));
