import { cleanFileName, defaultReleaseStatuses, MAX_FILE_BYTES } from "../lib/files"
import { CHANNELS, compareVersions, isChannel, isValidVersion, MAX_CHANGELOG_LENGTH, MAX_VERSION_LENGTH, type Channel } from "../lib/releases"
import { describeStatusKeys, parseStatusKeys, splitStatusKeys, type StatusSet } from "../lib/statuses"
import type { App } from "./apps.server"
import type { License } from "./licenses.server"
import { getStatusSetForApp, getStatusSetForLicense } from "./statuses.server"
import { getTrack, overriddenStatuses, resolveTrackForRelease } from "./tracks.server"
import { hashObject } from "./storage.server"
import { newId } from "./util.server"

/** The owner of a file: a single licence, or an app (shared by every licence of that app). */
export type FileOwner = { license: License } | { app: App }

const ownerId = (owner: FileOwner) => ("license" in owner ? owner.license.id : owner.app.id)
const ownerColumn = (owner: FileOwner) => ("license" in owner ? "license_id" : "app_id")

/** A file row as stored. `statuses` is a comma separated list of status keys; use `releaseRule` for the parsed form. */
export type LicenseFile = {
  id: string
  /** Set for a file that belongs to one licence. */
  license_id: string | null
  /** Set for a file shared by all licences of an app. */
  app_id: string | null
  name: string
  /** Empty for an attachment. A file with a version is a release. */
  version: string
  /** Internal notes, never sent to sites. */
  notes: string
  /** stable or beta. */
  channel: Channel
  /** Public release notes. */
  changelog: string
  /** Hex SHA-256 of the stored file. Empty for files uploaded before checksums were recorded. */
  sha256: string
  /** Set when the release was withdrawn: no longer offered or downloadable. */
  withdrawn_at: number | null
  /** The track of a release, whose statuses and domain check are copied onto `statuses` and `check_domain`. Null for an attachment. */
  track_id: string | null
  statuses: string
  check_domain: number
  size: number
  content_type: string
  r2_key: string
  uploaded_at: number
  download_count: number
  last_download_at: number | null
}

/** The release rule of a file, with the statuses read against the status set that applies to its owner. */
export const releaseRule = (f: Pick<LicenseFile, "statuses" | "check_domain">, set: StatusSet): { statuses: string[]; check_domain: boolean } => ({
  statuses: splitStatusKeys(f.statuses, set),
  check_domain: f.check_domain === 1,
})

/** The statuses a file's release rule refers to: those of its licence (own, app's or default), or of its app. */
export const statusSetForOwner = (env: Env, owner: FileOwner): Promise<StatusSet> => ("license" in owner ? getStatusSetForLicense(env, owner.license) : getStatusSetForApp(env, owner.app.id))

export function storageConfigured(env: Env): boolean {
  return Boolean(env.FILES)
}

/** The files owned directly by a licence or an app. */
export async function listFiles(env: Env, owner: FileOwner): Promise<LicenseFile[]> {
  return (await env.DB.prepare(`SELECT * FROM files WHERE ${ownerColumn(owner)} = ? ORDER BY uploaded_at DESC, id DESC`).bind(ownerId(owner)).all<LicenseFile>()).results
}

export function getFile(env: Env, owner: FileOwner, fileId: string): Promise<LicenseFile | null> {
  return env.DB.prepare(`SELECT * FROM files WHERE id = ? AND ${ownerColumn(owner)} = ?`).bind(fileId, ownerId(owner)).first<LicenseFile>()
}

/**
 * The release rule of an app's release as it applies to one licence: the statuses the licence's own tracks cover are
 * removed, because for those statuses the licence receives its own track instead.
 */
function forLicense(file: LicenseFile, overridden: Set<string>): LicenseFile {
  if (!file.app_id || !file.track_id || overridden.size === 0) return file
  return { ...file, statuses: file.statuses.split(",").filter((key) => key && !overridden.has(key)).join(",") }
}

/** Every file a licence can see: its own files and the files of its app (minus what its own tracks replace). */
export async function listFilesForLicense(env: Env, license: License): Promise<LicenseFile[]> {
  const [rows, overridden] = await Promise.all([
    env.DB.prepare("SELECT * FROM files WHERE license_id = ? OR app_id = ? ORDER BY uploaded_at DESC, id DESC").bind(license.id, license.app_id).all<LicenseFile>(),
    overriddenStatuses(env, license),
  ])
  const own = rows.results.map((f) => forLicense(f, overridden))
  const base = license.app_id ? await env.DB.prepare("SELECT base_app_id FROM apps WHERE id = ?").bind(license.app_id).first<{base_app_id: string | null}>() : null
  if (!base?.base_app_id) return own
  const tracks = (await env.DB.prepare("SELECT statuses FROM release_tracks WHERE app_id = ?").bind(license.app_id).all<{statuses:string}>()).results
  const covered = new Set(tracks.flatMap((t) => t.statuses.split(",")))
  const inherited = (await env.DB.prepare("SELECT * FROM files WHERE app_id = ? ORDER BY uploaded_at DESC, id DESC").bind(base.base_app_id).all<LicenseFile>()).results
  return [...own, ...inherited.map((f) => forLicense(f, covered))].sort((a,b) => b.uploaded_at - a.uploaded_at)

}

export async function getFileForLicense(env: Env, license: License, fileId: string): Promise<LicenseFile | null> {
  return (await listFilesForLicense(env, license)).find((f) => f.id === fileId) ?? null
}

export type StoreInput = {
  name: string
  /**
   * For an attachment: the statuses it is released in (comma separated string or array), by default the valid statuses.
   * For a release: chooses or creates the track with exactly these statuses when no `track` is given.
   */
  statuses?: unknown
  /** For a release: the track (id or name). See resolveTrackForRelease for the default. */
  track?: string | null
  /** Require the requesting site's domain to be allowed for the licence. Defaults to true. */
  checkDomain?: boolean
  version?: string
  notes?: string
  channel?: string
  changelog?: string
  contentType?: string | null
  size: number
  body: ReadableStream | null
  /** A file already written to R2 (by a repository import): recorded as it is, under this id, instead of `body`. */
  stored?: { id: string; key: string; sha256: string }
}

/** Where a file of this owner is kept in R2. */
export const fileKey = (owner: FileOwner, id: string) => `${ownerId(owner)}/${id}`

type Failure = { error: string; status: number }

/** Validates an optional version. Returns the cleaned value ("" for none) or an error message. */
function readVersion(raw: string | undefined): { version: string } | { error: string } {
  const version = (raw ?? "").trim()
  if (version && !isValidVersion(version)) {
    return { error: `"${version.slice(0, MAX_VERSION_LENGTH)}" is not a valid version. Use numbers separated by dots, optionally with a suffix, for example 1.4.0 or 2.0.0-beta.1.` }
  }
  return { version }
}

/**
 * The release of a track that already has this version, other than `exceptId`. Versions are compared by precedence,
 * so 1.4.0, v1.4.0 and 1.4 are the same version. Withdrawn releases do not count: a version can be published again
 * after its release is withdrawn.
 */
export async function releaseWithVersion(env: Env, trackId: string, version: string, exceptId: string | null = null): Promise<{ id: string; name: string; version: string } | null> {
  const rows = (await env.DB.prepare("SELECT id, name, version FROM files WHERE track_id = ? AND version <> '' AND withdrawn_at IS NULL").bind(trackId).all<{ id: string; name: string; version: string }>()).results
  return rows.find((r) => r.id !== exceptId && compareVersions(r.version, version) === 0) ?? null
}

const duplicateVersion = (version: string, trackName: string, existing: { name: string }): Failure => ({
  error: `Version ${version} is already published in the track "${trackName}" (${existing.name}). Withdraw or delete that release first.`,
  status: 409,
})

function readChannel(raw: string | undefined): { channel: Channel } | { error: string } {
  const channel = (raw ?? "").trim().toLowerCase() || "stable"
  return isChannel(channel) ? { channel } : { error: `channel must be one of: ${CHANNELS.join(", ")}.` }
}

/**
 * Streams the body to R2 untouched (a native copy, almost free in CPU), then hashes the stored object in blocks: far
 * cheaper than hashing the body chunk by chunk as it passes. In a Worker the body is wrapped in a FixedLengthStream,
 * because R2 needs to know the length of a stream in advance; it also fails the upload if fewer or more bytes arrive
 * than announced.
 */
async function putAndHash(env: Env, key: string, body: ReadableStream<Uint8Array>, size: number, contentType: string): Promise<string> {
  const stream = typeof FixedLengthStream === "function" ? body.pipeThrough(new FixedLengthStream(size)) : body
  await env.FILES.put(key, stream, { httpMetadata: { contentType } })
  try {
    return await hashObject(env, key, size)
  } catch (error) {
    await env.FILES.delete(key)
    throw error
  }
}

/** Validates the input, streams the body to R2 and records the file. */
export async function storeFile(env: Env, owner: FileOwner, input: StoreInput): Promise<{ file: LicenseFile } | Failure> {
  if (!storageConfigured(env)) return { error: "File storage (R2) is not configured for this deployment.", status: 501 }
  const name = cleanFileName(input.name)
  if (!name) return { error: "A file name is required.", status: 422 }
  const set = await statusSetForOwner(env, owner)
  if (!Number.isFinite(input.size) || input.size <= 0) return { error: "The request body is empty or has no Content-Length header.", status: 411 }
  if (input.size > MAX_FILE_BYTES) return { error: `The file exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`, status: 413 }
  if (!input.body && !input.stored) return { error: "The request has no body.", status: 422 }
  const version = readVersion(input.version)
  if ("error" in version) return { error: version.error, status: 422 }
  const channel = readChannel(input.channel)
  if ("error" in channel) return { error: channel.error, status: 422 }

  // A release takes its availability from its track; an attachment has its own.
  let statuses: string[] | null
  let checkDomain = input.checkDomain === false ? 0 : 1
  let trackId: string | null = null
  if (version.version) {
    const resolved = await resolveTrackForRelease(env, owner, input.track ?? null, input.statuses, input.checkDomain !== false)
    if ("error" in resolved) return resolved
    trackId = resolved.track.id
    statuses = resolved.track.statuses.split(",").filter(Boolean)
    checkDomain = resolved.track.check_domain
    const existing = await releaseWithVersion(env, trackId, version.version)
    if (existing) return duplicateVersion(version.version, resolved.track.name, existing)
  } else {
    statuses = input.statuses === undefined || input.statuses === "" ? defaultReleaseStatuses(set) : parseStatusKeys(input.statuses, set)
    if (!statuses) return { error: `statuses must be a comma separated list of licence statuses: ${set.map((s) => s.key).join(", ")}.`, status: 422 }
  }

  const id = input.stored?.id ?? newId("fil")
  const key = input.stored?.key ?? fileKey(owner, id)
  const contentType = (input.contentType || "application/octet-stream").slice(0, 120)
  const sha256 = input.stored?.sha256 ?? (await putAndHash(env, key, input.body!, input.size, contentType))
  const now = Date.now()
  const label = version.version ? `${name} (version ${version.version}${channel.channel === "beta" ? ", beta" : ""})` : name
  try {
    const statements = [
      env.DB.prepare(
        `INSERT INTO files (id, license_id, app_id, name, version, notes, channel, changelog, sha256, statuses, check_domain, size, content_type, r2_key, uploaded_at, track_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        id, "license" in owner ? owner.license.id : null, "app" in owner ? owner.app.id : null, name, version.version, (input.notes ?? "").trim().slice(0, 500),
        channel.channel, (input.changelog ?? "").trim().slice(0, MAX_CHANGELOG_LENGTH), sha256, statuses.join(","), checkDomain, input.size, contentType, key, now, trackId
      ),
    ]
    if ("license" in owner) statements.push(logChange(env, owner.license, now, `File added: ${label} (available when ${describeStatusKeys(statuses, set)})`))
    await env.DB.batch(statements)
  } catch (error) {
    await env.FILES.delete(key)
    throw error
  }
  return { file: (await getFile(env, owner, id))! }
}

export type FileChanges = {
  /** Attachments only: a release's statuses come from its track. */
  statuses?: unknown
  /** Attachments only: a release's domain check comes from its track. */
  checkDomain?: boolean
  /** Releases: move the release to this track (id or name). */
  track?: string
  version?: string
  notes?: string
  channel?: string
  changelog?: string
  /** true withdraws the release, false restores it. */
  withdrawn?: boolean
}

/**
 * Updates a file's metadata or availability. Only the fields present are changed. A release's availability is its
 * track's: change the track, or move the release to another track. Removing the version turns a release into an
 * attachment that keeps its current statuses; adding one puts an attachment into a track.
 */
export async function updateFile(env: Env, owner: FileOwner, file: LicenseFile, changes: FileChanges): Promise<{ file: LicenseFile } | Failure> {
  const set = await statusSetForOwner(env, owner)
  const version = changes.version === undefined ? { version: file.version } : readVersion(changes.version)
  if ("error" in version) return { error: version.error, status: 422 }
  const channel = changes.channel === undefined ? { channel: file.channel } : readChannel(changes.channel)
  if ("error" in channel) return { error: channel.error, status: 422 }

  let statuses = file.statuses
  let checkDomain = file.check_domain
  let trackId: string | null = file.track_id
  let trackName: string | null = null
  if (version.version) {
    let track = changes.track ? null : file.track_id ? await getTrack(env, owner, file.track_id) : null
    if (!track) {
      const resolved = await resolveTrackForRelease(env, owner, changes.track ?? null, changes.track ? undefined : changes.statuses, changes.checkDomain ?? file.check_domain === 1)
      if ("error" in resolved) return resolved
      track = resolved.track
    }
    const parsed = changes.statuses === undefined ? null : parseStatusKeys(changes.statuses, set)
    if ((parsed && parsed.join(",") !== track.statuses) || (changes.checkDomain !== undefined && (changes.checkDomain ? 1 : 0) !== track.check_domain)) {
      return { error: `A release is available according to its track ("${track.name}"). Change the track, or move the release to another track.`, status: 422 }
    }
    trackId = track.id
    trackName = track.name
    statuses = track.statuses
    checkDomain = track.check_domain
  } else {
    trackId = null
    if (changes.statuses !== undefined) {
      const parsed = parseStatusKeys(changes.statuses, set)
      if (!parsed) return { error: `statuses must be a comma separated list of licence statuses: ${set.map((s) => s.key).join(", ")}.`, status: 422 }
      statuses = parsed.join(",")
    }
    if (changes.checkDomain !== undefined) checkDomain = changes.checkDomain ? 1 : 0
  }

  const withdrawnAt = changes.withdrawn === undefined ? file.withdrawn_at : changes.withdrawn ? (file.withdrawn_at ?? Date.now()) : null
  // A release that gets a new version, moves to another track or is restored must not repeat a version of its track.
  if (version.version && trackId && withdrawnAt === null && (version.version !== file.version || trackId !== file.track_id || file.withdrawn_at !== null)) {
    const existing = await releaseWithVersion(env, trackId, version.version, file.id)
    if (existing) return duplicateVersion(version.version, trackName ?? (await getTrack(env, owner, trackId))?.name ?? "", existing)
  }
  const notes = changes.notes === undefined ? file.notes : changes.notes.trim().slice(0, 500)
  const changelog = changes.changelog === undefined ? file.changelog : changes.changelog.trim().slice(0, MAX_CHANGELOG_LENGTH)
  const statements = [
    env.DB.prepare("UPDATE files SET statuses = ?, check_domain = ?, track_id = ?, version = ?, notes = ?, channel = ?, changelog = ?, withdrawn_at = ? WHERE id = ?").bind(
      statuses, checkDomain, trackId, version.version, notes, channel.channel, changelog, withdrawnAt, file.id
    ),
  ]
  if ("license" in owner) {
    const now = Date.now()
    if (trackId !== file.track_id && trackName) statements.push(logChange(env, owner.license, now, `Release moved: ${file.name} to the track ${trackName}`))
    else if (statuses !== file.statuses || checkDomain !== file.check_domain) {
      statements.push(logChange(env, owner.license, now, `File updated: ${file.name} (available when ${describeStatusKeys(splitStatusKeys(statuses, set), set)})`))
    }
    if ((withdrawnAt === null) !== (file.withdrawn_at === null)) statements.push(logChange(env, owner.license, now, `${withdrawnAt === null ? "Release restored" : "Release withdrawn"}: ${file.name}`))
  }
  await env.DB.batch(statements)
  return { file: (await getFile(env, owner, file.id))! }
}

export async function deleteFile(env: Env, owner: FileOwner, file: LicenseFile): Promise<void> {
  if (storageConfigured(env)) await env.FILES.delete(file.r2_key)
  const statements = [env.DB.prepare("DELETE FROM files WHERE id = ?").bind(file.id)]
  if ("license" in owner) statements.push(logChange(env, owner.license, Date.now(), `File removed: ${file.name}`))
  await env.DB.batch(statements)
}

async function deleteStoredObjects(env: Env, column: "license_id" | "app_id", id: string): Promise<void> {
  if (!storageConfigured(env)) return
  const rows = (await env.DB.prepare(`SELECT r2_key FROM files WHERE ${column} = ?`).bind(id).all<{ r2_key: string }>()).results
  // Packages that imports in progress are writing, which have no file row yet.
  const packages = (
    await env.DB.prepare(`SELECT i.package_key FROM source_imports i JOIN release_sources s ON s.id = i.source_id WHERE s.${column} = ? AND i.package_key <> ''`)
      .bind(id)
      .all<{ package_key: string }>()
  ).results
  const keys = [...rows.map((r) => r.r2_key), ...packages.map((p) => p.package_key)]
  for (let i = 0; i < keys.length; i += 1000) await env.FILES.delete(keys.slice(i, i + 1000))
}

/** Deletes the stored objects of a licence. Called before the licence rows are removed. */
export const deleteLicenseFiles = (env: Env, licenseId: string) => deleteStoredObjects(env, "license_id", licenseId)

/** Deletes the stored objects of an app. Called before the app rows are removed. */
export const deleteAppFiles = (env: Env, appId: string) => deleteStoredObjects(env, "app_id", appId)

function logChange(env: Env, license: License, at: number, detail: string) {
  return env.DB.prepare("INSERT INTO activity (license_id, at, event, status, detail) VALUES (?, ?, 'change', ?, ?)").bind(license.id, at, license.status, detail)
}

/** Reads the file fields a dashboard form sent. Fields that are absent are left unchanged. */
function readFileForm(form: FormData): FileChanges {
  const text = (name: string) => (form.has(name) ? String(form.get(name)) : undefined)
  const flag = (name: string) => (form.has(name) ? form.get(name) === "true" : undefined)
  return { statuses: text("statuses"), checkDomain: flag("check_domain"), track: text("track") || undefined, version: text("version"), notes: text("notes"), channel: text("channel"), changelog: text("changelog"), withdrawn: flag("withdrawn") }
}

/**
 * Handles the file intents of a licence or app page: "update-file" and "delete-file". Returns `{ ok: true }` or
 * `{ error }` for the page's fetcher, or null when the intent is not a file intent.
 */
export async function applyFileForm(env: Env, owner: FileOwner, form: FormData): Promise<{ ok: true } | { error: string } | null> {
  const intent = String(form.get("intent"))
  if (intent !== "update-file" && intent !== "delete-file") return null
  const file = await getFile(env, owner, String(form.get("fileId")))
  if (!file) return { error: "That file no longer exists. Reload the page." }
  if (intent === "delete-file") {
    await deleteFile(env, owner, file)
    return { ok: true }
  }
  const updated = await updateFile(env, owner, file, readFileForm(form))
  return "error" in updated ? { error: updated.error } : { ok: true }
}
