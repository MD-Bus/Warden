-- Tagged product access under one key. Legacy columns remain until 1.0 for older integrations.
ALTER TABLE licenses ADD COLUMN expiry_mode TEXT NOT NULL DEFAULT 'legacy' CHECK (expiry_mode IN ('legacy', 'shared', 'separate'));
ALTER TABLE apps ADD COLUMN base_app_id TEXT REFERENCES apps (id);

CREATE TABLE license_apps (
  id TEXT PRIMARY KEY,
  license_id TEXT NOT NULL REFERENCES licenses (id) ON DELETE CASCADE,
  app_id TEXT NOT NULL REFERENCES apps (id),
  tag TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER,
  grace_days INTEGER,
  message TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  last_check_at INTEGER,
  check_count INTEGER NOT NULL DEFAULT 0,
  grace_notified_for INTEGER,
  expired_notified_for INTEGER,
  silent_notified_for INTEGER,
  UNIQUE (license_id, tag)
);
CREATE INDEX idx_license_apps_app ON license_apps (app_id);
CREATE INDEX idx_license_apps_license ON license_apps (license_id, position);

CREATE TABLE activation_versions (
  attachment_id TEXT NOT NULL REFERENCES license_apps (id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  version TEXT,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (attachment_id, domain)
);
ALTER TABLE activity ADD COLUMN app_id TEXT;
ALTER TABLE activity ADD COLUMN tag TEXT;
CREATE INDEX idx_activity_app_at ON activity (app_id, at);

CREATE TABLE license_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  expiry_mode TEXT NOT NULL CHECK (expiry_mode IN ('shared', 'separate')),
  slots TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

-- A project app preserves standalone settings and licence-specific release overrides.
-- Its base app continues supplying releases for statuses not overridden by its own tracks.
CREATE TABLE migration_project_apps AS
SELECT l.id AS license_id, 'app_' || lower(hex(randomblob(12))) AS app_id
FROM licenses l
WHERE l.app_id IS NULL
   OR EXISTS (SELECT 1 FROM files f WHERE f.license_id = l.id)
   OR EXISTS (SELECT 1 FROM release_tracks t WHERE t.license_id = l.id)
   OR EXISTS (SELECT 1 FROM release_sources s WHERE s.license_id = l.id);

INSERT INTO apps (id, name, slug, description, default_status, default_max_sites, default_message, grace_days, notes, created_at, updated_at, base_app_id)
SELECT p.app_id, substr(l.name, 1, 80), 'project-' || substr(p.app_id, 5), 'Migrated custom project', l.status, l.max_sites, l.message,
       COALESCE(l.grace_days, a.grace_days), l.notes, l.created_at, l.updated_at, l.app_id
FROM migration_project_apps p JOIN licenses l ON l.id = p.license_id LEFT JOIN apps a ON a.id = l.app_id;

INSERT INTO statuses (app_id, key, label, description, color, grants_access, on_expiry, check_message, is_default, position)
SELECT p.app_id, s.key, s.label, s.description, s.color, s.grants_access, s.on_expiry, s.check_message, s.is_default, s.position
FROM migration_project_apps p JOIN licenses l ON l.id = p.license_id JOIN statuses s
ON (l.app_id IS NOT NULL AND s.app_id = l.app_id) OR (l.app_id IS NULL AND s.license_id = l.id);

UPDATE files SET app_id = (SELECT p.app_id FROM migration_project_apps p WHERE p.license_id = files.license_id), license_id = NULL WHERE license_id IN (SELECT license_id FROM migration_project_apps);
UPDATE release_tracks SET app_id = (SELECT p.app_id FROM migration_project_apps p WHERE p.license_id = release_tracks.license_id), license_id = NULL WHERE license_id IN (SELECT license_id FROM migration_project_apps);
UPDATE release_sources SET app_id = (SELECT p.app_id FROM migration_project_apps p WHERE p.license_id = release_sources.license_id), license_id = NULL WHERE license_id IN (SELECT license_id FROM migration_project_apps);
DELETE FROM statuses WHERE license_id IN (SELECT license_id FROM migration_project_apps);
UPDATE licenses SET app_id = (SELECT p.app_id FROM migration_project_apps p WHERE p.license_id = licenses.id) WHERE id IN (SELECT license_id FROM migration_project_apps);
DROP TABLE migration_project_apps;

INSERT INTO license_apps (id, license_id, app_id, tag, status, expires_at, grace_days, message, last_check_at, check_count, grace_notified_for, expired_notified_for, silent_notified_for)
SELECT 'ent_' || lower(hex(randomblob(12))), l.id, l.app_id, 'default', l.status, l.expires_at, l.grace_days, l.message,
       l.last_check_at, l.check_count, l.grace_notified_for, l.expired_notified_for, l.silent_notified_for FROM licenses l;
INSERT INTO activation_versions (attachment_id, domain, version, last_seen_at)
SELECT e.id, a.domain, a.version, a.last_seen_at FROM activations a JOIN license_apps e ON e.license_id = a.license_id;
UPDATE activity SET app_id = (SELECT l.app_id FROM licenses l WHERE l.id = activity.license_id), tag = 'default';
UPDATE licenses SET expiry_mode = 'shared';
