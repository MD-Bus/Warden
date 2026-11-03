import { isValidSlug, slugify } from "../lib/apps"
import { compareVersions, isOutdated, latestRelease } from "../lib/releases"
import { defaultStatusKey, effectiveStatusKey, findStatus, MAX_GRACE_DAYS, type StatusSet } from "../lib/statuses"
import { deleteAppFiles } from "./files.server"
import { parseGraceDays, parseOptionalCount, type LicenseInput } from "./licenses.server"
import { getStatusSetForApp, loadStatusSets, setForApp } from "./statuses.server"
import { newId } from "./util.server"

export type App = {
  id: string
  base_app_id?: string | null
  name: string
  slug: string
  description: string
  default_duration_days: number | null
  /** Key of the status new licences of this app start with, within the app's status set. */
  default_status: string
  default_max_sites: number | null
  default_message: string
  notes: string
  /** Days the app's licences stay valid after their expiry date, unless a licence has its own setting. Null: none. */
  grace_days: number | null
  created_at: number
  updated_at: number
}

/** `grace_days` left out: unchanged (none on create). */
export type AppInput = Omit<App, "id" | "created_at" | "updated_at" | "grace_days"> & { grace_days?: number | null }

export type AppSummary = App & {
  licenses: number
  /** Licences that are currently valid for sites: completed, or active and not expired. */
  /** Licences for which a check currently returns valid: true. */
  valid: number
  /** Total number of site activations across the app's licences. */
  sites: number
  files: number
  /** The highest stable version among the app's current releases. */
  latest_version: string | null
}

export const MAX_DURATION_DAYS = 3650

/** Validates the dashboard form and returns the cleaned input, or an error message. `statuses` is the status set the app uses. */
export function readAppForm(form: FormData, statuses: StatusSet): { input: AppInput } | { error: string } {
  const name = String(form.get("name") ?? "").trim()
  if (!name) return { error: "Enter a name for the app." }
  if (name.length > 80) return { error: "The name must be 80 characters or fewer." }
  const slug = String(form.get("slug") ?? "").trim().toLowerCase() || slugify(name)
  if (!isValidSlug(slug)) return { error: "The identifier must be 2 to 48 characters: lowercase letters, digits and single hyphens." }
  const status = String(form.get("default_status") ?? defaultStatusKey(statuses))
  if (!findStatus(statuses, status)) return { error: "Choose a valid default status." }
  const duration = parseOptionalCount(form.get("default_duration_days"), MAX_DURATION_DAYS)
  if (duration === "invalid") return { error: `Default duration must be a whole number of days from 1 to ${MAX_DURATION_DAYS}, or empty for no expiry.` }
  const maxSites = parseOptionalCount(form.get("default_max_sites"))
  if (maxSites === "invalid") return { error: "Default maximum sites must be a whole number of 1 or more, or empty for unlimited." }
  const graceDays = parseGraceDays(form.get("grace_days"), 1)
  if (graceDays === "invalid") return { error: `The grace period must be a whole number of days from 1 to ${MAX_GRACE_DAYS}, or empty for none.` }
  return {
    input: {
      name,
      slug,
      description: String(form.get("description") ?? "").trim().slice(0, 500),
      default_duration_days: duration,
      default_status: status,
      default_max_sites: maxSites,
      default_message: String(form.get("default_message") ?? "").trim().slice(0, 300),
      notes: String(form.get("notes") ?? "").trim().slice(0, 4000),
      grace_days: graceDays,
    },
  }
}

export function getApp(env: Env, id: string): Promise<App | null> {
  return env.DB.prepare("SELECT * FROM apps WHERE id = ?").bind(id).first<App>()
}

/** Finds an app by its id (app_...) or its slug. */
export function findApp(env: Env, idOrSlug: string): Promise<App | null> {
  return env.DB.prepare("SELECT * FROM apps WHERE id = ? OR slug = ?").bind(idOrSlug, idOrSlug).first<App>()
}

export async function createApp(env: Env, input: AppInput): Promise<{ app: App } | { error: string }> {
  if (await env.DB.prepare("SELECT 1 AS taken FROM apps WHERE slug = ?").bind(input.slug).first()) return { error: "Another app already uses this identifier." }
  const id = newId("app")
  const now = Date.now()
  try {
    await env.DB.prepare(
      `INSERT INTO apps (id, name, slug, description, default_duration_days, default_status, default_max_sites, default_message, notes, grace_days, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, input.name, input.slug, input.description, input.default_duration_days, input.default_status, input.default_max_sites, input.default_message, input.notes, input.grace_days ?? null, now, now).run()
  } catch (error) {
    // Another request created an app with the same identifier between the check above and this insert.
    if (/UNIQUE/i.test(String(error instanceof Error ? error.message : error))) return { error: "Another app already uses this identifier." }
    throw error
  }
  return { app: (await getApp(env, id))! }
}

export async function updateApp(env: Env, app: App, input: AppInput): Promise<{ app: App } | { error: string }> {
  if (input.slug !== app.slug && (await env.DB.prepare("SELECT 1 AS taken FROM apps WHERE slug = ? AND id != ?").bind(input.slug, app.id).first())) {
    return { error: "Another app already uses this identifier." }
  }
  await env.DB.prepare(
    `UPDATE apps SET name = ?, slug = ?, description = ?, default_duration_days = ?, default_status = ?, default_max_sites = ?, default_message = ?, notes = ?, grace_days = ?, updated_at = ? WHERE id = ?`
  ).bind(input.name, input.slug, input.description, input.default_duration_days, input.default_status, input.default_max_sites, input.default_message, input.notes, input.grace_days === undefined ? app.grace_days : input.grace_days, Date.now(), app.id).run()
  return { app: (await getApp(env, app.id))! }
}

/** Deletes an app and its files. Refused while the app still has licences, so no licence loses its app by accident. */
export async function deleteApp(env: Env, app: App): Promise<{ ok: true } | { error: string }> {
  const count = await env.DB.prepare("SELECT COUNT(*) AS c FROM licenses WHERE app_id = ? OR id IN (SELECT license_id FROM license_apps WHERE app_id = ?)").bind(app.id, app.id).first<{ c: number }>()
  if (await env.DB.prepare("SELECT 1 FROM apps WHERE base_app_id = ? LIMIT 1").bind(app.id).first()) return { error: "This app supplies inherited releases to a migrated project app. Remove that dependency before deleting it." }
  if (await env.DB.prepare("SELECT 1 FROM license_templates, json_each(slots) WHERE json_extract(json_each.value, '$.app') = ? LIMIT 1").bind(app.id).first()) return { error: "This app is selected in a licence template. Remove it from the template first." }
  if ((count?.c ?? 0) > 0) return { error: `This app still has ${count!.c} licence${count!.c === 1 ? "" : "s"}. Delete them or move them to another app first.` }
  await deleteAppFiles(env, app.id)
  await env.DB.batch([
    env.DB.prepare("DELETE FROM files WHERE app_id = ?").bind(app.id),
    env.DB.prepare("DELETE FROM statuses WHERE app_id = ?").bind(app.id),
    env.DB.prepare("DELETE FROM source_imports WHERE source_id IN (SELECT id FROM release_sources WHERE app_id = ?)").bind(app.id),
    env.DB.prepare("DELETE FROM release_sources WHERE app_id = ?").bind(app.id),
    env.DB.prepare("UPDATE files SET track_id = NULL WHERE track_id IN (SELECT id FROM release_tracks WHERE app_id = ?)").bind(app.id),
    env.DB.prepare("DELETE FROM release_tracks WHERE app_id = ?").bind(app.id),
    env.DB.prepare("DELETE FROM apps WHERE id = ?").bind(app.id),
  ])
  return { ok: true }
}

export async function listApps(env: Env, now = Date.now()): Promise<AppSummary[]> {
  // Independent reads, sent together: one round trip to the database instead of four.
  const [{ results: apps }, { results: versions }, sets, { results: licenses }] = await Promise.all([
    env.DB.prepare(
      `SELECT a.*,
        (SELECT COUNT(*) FROM licenses l WHERE (l.expiry_mode = 'legacy' AND l.app_id = a.id) OR EXISTS (SELECT 1 FROM license_apps e WHERE e.license_id=l.id AND e.app_id=a.id)) AS licenses,
        (SELECT COUNT(*) FROM activations x JOIN licenses l ON l.id = x.license_id WHERE (l.expiry_mode = 'legacy' AND l.app_id = a.id) OR EXISTS (SELECT 1 FROM activation_versions v JOIN license_apps e ON e.id=v.attachment_id WHERE e.license_id=l.id AND e.app_id=a.id AND v.domain=x.domain)) AS sites,
        (SELECT COUNT(*) FROM files f WHERE f.app_id = a.id) AS files
       FROM apps a ORDER BY a.name COLLATE NOCASE`
    ).all<Omit<AppSummary, "latest_version" | "valid">>(),
    env.DB.prepare("SELECT app_id, version, channel, withdrawn_at FROM files WHERE app_id IS NOT NULL AND version != '' AND withdrawn_at IS NULL").all<{ app_id: string; version: string; channel: string; withdrawn_at: null }>(),
    loadStatusSets(env),
    env.DB.prepare(`SELECT l.id, l.app_id, l.status, l.expires_at, l.grace_days, a.grace_days AS app_grace_days FROM licenses l JOIN apps a ON a.id = l.app_id WHERE l.expiry_mode='legacy' UNION ALL SELECT l.id,e.app_id,e.status,CASE WHEN l.expiry_mode='shared' THEN l.expires_at ELSE e.expires_at END,COALESCE(l.grace_days,e.grace_days),a.grace_days FROM license_apps e JOIN licenses l ON l.id=e.license_id JOIN apps a ON a.id=e.app_id`).all<{
      id: string
      app_id: string
      status: string
      expires_at: number | null
      grace_days: number | null
      app_grace_days: number | null
    }>(),
  ])
  return apps.map((app) => {
    const set = setForApp(sets, app.id)
    const valid = new Set(licenses.filter((l) => l.app_id === app.id && findStatus(set, effectiveStatusKey(l, set, now))?.grants_access).map((l) => l.id)).size
    return { ...app, valid, latest_version: latestRelease(versions.filter((v) => v.app_id === app.id || v.app_id === app.base_app_id))?.version ?? null }
  })
}

export async function getAppSummary(env: Env, idOrSlug: string): Promise<AppSummary | null> {
  return (await listApps(env)).find((a) => a.id === idOrSlug || a.slug === idOrSlug) ?? null
}

/** The licence values a new licence of this app starts with. Explicit input overrides them. */
export function appDefaults(app: App, now = Date.now()): Pick<LicenseInput, "status" | "expires_at" | "max_sites" | "message"> {
  return {
    status: app.default_status,
    expires_at: app.default_duration_days ? now + app.default_duration_days * 86_400_000 : null,
    max_sites: app.default_max_sites,
    message: app.default_message,
  }
}

export type VersionsInUse = {
  /** The highest stable version among the app's current releases, or null. */
  latest_version: string | null
  /** Sites registered under the app's licences, total and behind the latest release their own licence is offered. */
  sites: number
  outdated: number
  /** Sites per reported version, newest first. `version` is null for sites that never reported one; `behind` counts the sites on that version that are behind. */
  data: { version: string | null; sites: number; behind: number; outdated: boolean }[]
}

type SiteRow = { license_id: string; version: string | null; status: string; expires_at: number | null; grace_days: number | null; app_grace_days: number | null; last_check_at: number | null; created_at: number }
type ReleaseRow = { license_id: string | null; app_id: string | null; track_id: string | null; version: string; channel: string; statuses: string; withdrawn_at: null }

/**
 * Which versions the sites of an app's licences run, as reported with their checks (?version=). A site is behind
 * when its version is older than the latest stable release its own licence is offered: the latest of the track that
 * serves the licence's current status (its own track for that status, otherwise the app's).
 */
export async function versionsInUse(env: Env, appId: string, now = Date.now()): Promise<VersionsInUse> {
  const [sites, releases, ownTracks, set] = await Promise.all([
    env.DB.prepare(
      `SELECT x.license_id, x.version, l.status, l.expires_at, l.grace_days, a.grace_days AS app_grace_days, l.last_check_at, l.created_at FROM activations x JOIN licenses l ON l.id = x.license_id JOIN apps a ON a.id = l.app_id WHERE l.app_id = ? AND l.expiry_mode='legacy'
       UNION ALL SELECT e.license_id,v.version,e.status,CASE WHEN l.expiry_mode='shared' THEN l.expires_at ELSE e.expires_at END,COALESCE(l.grace_days,e.grace_days),a.grace_days,e.last_check_at,l.created_at FROM activation_versions v JOIN license_apps e ON e.id=v.attachment_id JOIN licenses l ON l.id=e.license_id JOIN apps a ON a.id=e.app_id WHERE e.app_id=?`
    ).bind(appId,appId).all<SiteRow>(),
    env.DB.prepare(
      "SELECT license_id, app_id, track_id, version, channel, statuses, withdrawn_at FROM files WHERE (app_id = ? OR license_id IN (SELECT id FROM licenses WHERE app_id = ?)) AND version != '' AND withdrawn_at IS NULL ORDER BY uploaded_at DESC"
    ).bind(appId, appId).all<ReleaseRow>(),
    env.DB.prepare("SELECT license_id, statuses FROM release_tracks WHERE license_id IN (SELECT id FROM licenses WHERE app_id = ?)").bind(appId).all<{ license_id: string; statuses: string }>(),
    getStatusSetForApp(env, appId),
  ])
  const app=await getApp(env,appId)
  if(app?.base_app_id) {
    const [baseFiles,own]=(await Promise.all([
      env.DB.prepare("SELECT license_id,app_id,track_id,version,channel,statuses,withdrawn_at FROM files WHERE app_id=? AND version<>'' AND withdrawn_at IS NULL ORDER BY uploaded_at DESC").bind(app.base_app_id).all<ReleaseRow>(),
      env.DB.prepare("SELECT statuses FROM release_tracks WHERE app_id=?").bind(appId).all<{statuses:string}>(),
    ]))
    const covered=new Set(own.results.flatMap((t) => t.statuses.split(",")))
    releases.results.push(...baseFiles.results.map((f) => ({...f,app_id:appId,statuses:f.statuses.split(",").filter((s) => !covered.has(s)).join(",")})))
  }
  const appReleases = releases.results.filter((r) => r.app_id === appId)
  const latestOverall = latestRelease(appReleases)?.version ?? null

  // Latest release per licence, computed once per licence.
  const ownKeys = new Map<string, Set<string>>()
  for (const t of ownTracks.results) ownKeys.set(t.license_id, new Set([...(ownKeys.get(t.license_id) ?? []), ...t.statuses.split(",").filter(Boolean)]))
  const latestFor = new Map<string, string | null>()
  const latestOf = (site: SiteRow) => {
    const cacheKey=`${site.license_id}:${site.status}`
    if (latestFor.has(cacheKey)) return latestFor.get(cacheKey)!
    const status = effectiveStatusKey(site, set, now)
    const replaced = ownKeys.get(site.license_id) ?? new Set<string>()
    const offered = releases.results.filter((r) => {
      const keys = r.statuses.split(",")
      if (r.license_id === site.license_id) return keys.includes(status)
      return r.app_id === appId && keys.includes(status) && !(r.track_id && replaced.has(status))
    })
    const latest = latestRelease(offered)?.version ?? null
    latestFor.set(cacheKey, latest)
    return latest
  }

  const groups = new Map<string | null, { sites: number; behind: number }>()
  for (const site of sites.results) {
    const group = groups.get(site.version) ?? { sites: 0, behind: 0 }
    group.sites++
    if (isOutdated(site.version, latestOf(site))) group.behind++
    groups.set(site.version, group)
  }
  const data = [...groups]
    .map(([version, g]) => ({ version, sites: g.sites, behind: g.behind, outdated: g.behind > 0 }))
    .sort((a, b) => (a.version === null ? 1 : b.version === null ? -1 : compareVersions(b.version, a.version)))
  return { latest_version: latestOverall, sites: data.reduce((n, r) => n + r.sites, 0), outdated: data.reduce((n, r) => n + r.behind, 0), data }
}

/** For each app: how many of its sites are behind the latest release their own licence is offered. */
export async function outdatedSitesByApp(env: Env, apps: AppSummary[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  const all = await Promise.all(apps.map((app) => versionsInUse(env, app.id)))
  apps.forEach((app, i) => {
    if (all[i].outdated > 0) out[app.id] = all[i].outdated
  })
  return out
}
