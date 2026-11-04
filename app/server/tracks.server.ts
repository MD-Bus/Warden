import { defaultReleaseStatuses } from "../lib/files"
import { readKeepReleases, releasesToPrune } from "../lib/releases"
import { describeStatusKeys, parseStatusKeys, type StatusSet } from "../lib/statuses"
import { MAX_TRACK_NAME, trackNameError, trackOverlaps, trackStatusKeys } from "../lib/tracks"
import type { App } from "./apps.server"
import type { License } from "./licenses.server"
import { getStatusSetForApp, getStatusSetForLicense } from "./statuses.server"
import { newId } from "./util.server"

/** The owner of a track (and of files): one licence, or an app. Same shape as FileOwner in files.server. */
export type TrackOwner = { license: License } | { app: App }

export type ReleaseTrack = {
  id: string
  app_id: string | null
  license_id: string | null
  name: string
  /** Comma-separated status keys; exclusive within the owner. */
  statuses: string
  check_domain: number
  /** How many releases the track keeps; null keeps all. Older ones are deleted. */
  keep_releases: number | null
  position: number
  created_at: number
  updated_at: number
}

type Failure = { error: string; status: number }

const ownerColumn = (owner: TrackOwner) => ("license" in owner ? "license_id" : "app_id")
const ownerId = (owner: TrackOwner) => ("license" in owner ? owner.license.id : owner.app.id)
const statusSetOf = (env: Env, owner: TrackOwner): Promise<StatusSet> => ("license" in owner ? getStatusSetForLicense(env, owner.license) : getStatusSetForApp(env, owner.app.id))

export async function listTracks(env: Env, owner: TrackOwner): Promise<ReleaseTrack[]> {
  return (await env.DB.prepare(`SELECT * FROM release_tracks WHERE ${ownerColumn(owner)} = ? ORDER BY position, created_at`).bind(ownerId(owner)).all<ReleaseTrack>()).results
}

/** The tracks of an app, by app id (for a licence's inherited tracks). */
export async function listAppTracks(env: Env, appId: string): Promise<ReleaseTrack[]> {
  return (await env.DB.prepare("SELECT * FROM release_tracks WHERE app_id = ? ORDER BY position, created_at").bind(appId).all<ReleaseTrack>()).results
}

export function getTrack(env: Env, owner: TrackOwner, id: string): Promise<ReleaseTrack | null> {
  return env.DB.prepare(`SELECT * FROM release_tracks WHERE id = ? AND ${ownerColumn(owner)} = ?`).bind(id, ownerId(owner)).first<ReleaseTrack>()
}

/** Finds a track of the owner by id or, case-insensitively, by name. */
export async function findTrack(env: Env, owner: TrackOwner, ref: string): Promise<ReleaseTrack | null> {
  const tracks = await listTracks(env, owner)
  return tracks.find((t) => t.id === ref) ?? tracks.find((t) => t.name.toLowerCase() === ref.trim().toLowerCase()) ?? null
}

export type TrackInput = { name?: unknown; statuses?: unknown; check_domain?: unknown; position?: unknown; keep_releases?: unknown }

function overlapError(overlaps: { status: string; track: ReleaseTrack }[], set: StatusSet): string {
  const first = overlaps[0]
  const label = set.find((s) => s.key === first.status)?.label ?? first.status
  return `${label} already belongs to the track "${first.track.name}". Each status can belong to one track only: remove it there first.`
}

/** Reads and validates the fields of a track. `current` supplies the values the input leaves out. */
async function readTrack(env: Env, owner: TrackOwner, input: TrackInput, current: ReleaseTrack | null): Promise<{ name: string; statuses: string[]; checkDomain: number; position: number; keep: number | null } | Failure> {
  const set = await statusSetOf(env, owner)
  const rawName = input.name === undefined ? (current?.name ?? "") : input.name
  if (typeof rawName !== "string") return { error: "name must be a string.", status: 422 }
  const nameError = trackNameError(rawName)
  if (nameError) return { error: nameError, status: 422 }

  let statuses = current ? trackStatusKeys(current) : []
  if (input.statuses !== undefined) {
    const parsed = input.statuses === "" || (Array.isArray(input.statuses) && input.statuses.length === 0) ? [] : parseStatusKeys(input.statuses, set)
    if (!parsed) return { error: `statuses must be a comma separated list of licence statuses: ${set.map((s) => s.key).join(", ")}.`, status: 422 }
    statuses = parsed
  }
  const tracks = await listTracks(env, owner)
  const overlaps = trackOverlaps(tracks, statuses, current?.id ?? null)
  if (overlaps.length > 0) return { error: overlapError(overlaps, set), status: 409 }

  if (input.check_domain !== undefined && typeof input.check_domain !== "boolean") return { error: "check_domain must be true or false.", status: 422 }
  const checkDomain = input.check_domain === undefined ? (current?.check_domain ?? 1) : input.check_domain ? 1 : 0
  if (input.position !== undefined && (!Number.isInteger(input.position) || (input.position as number) < 0)) return { error: "position must be a whole number from 0.", status: 422 }
  const position = input.position === undefined ? (current?.position ?? tracks.reduce((n, t) => Math.max(n, t.position + 1), 0)) : (input.position as number)
  const keep = input.keep_releases === undefined ? { keep: current?.keep_releases ?? null } : readKeepReleases(input.keep_releases)
  if ("error" in keep) return { error: keep.error, status: 422 }
  return { name: rawName.trim().slice(0, MAX_TRACK_NAME), statuses, checkDomain, position, keep: keep.keep }
}

export async function createTrack(env: Env, owner: TrackOwner, input: TrackInput, now = Date.now()): Promise<{ track: ReleaseTrack } | Failure> {
  const read = await readTrack(env, owner, input, null)
  if ("error" in read) return read
  const id = newId("trk")
  await env.DB.prepare(
    "INSERT INTO release_tracks (id, app_id, license_id, name, statuses, check_domain, position, keep_releases, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
    .bind(id, "app" in owner ? owner.app.id : null, "license" in owner ? owner.license.id : null, read.name, read.statuses.join(","), read.checkDomain, read.position, read.keep, now, now)
    .run()
  return { track: (await getTrack(env, owner, id))! }
}

/**
 * Changes a track. Its statuses and domain check are copied onto its releases, which is what downloads evaluate.
 * Lowering the release limit deletes the oldest releases beyond it; `pruned` is how many were deleted.
 */
export async function updateTrack(env: Env, owner: TrackOwner, track: ReleaseTrack, input: TrackInput, now = Date.now()): Promise<{ track: ReleaseTrack; pruned: number } | Failure> {
  const read = await readTrack(env, owner, input, track)
  if ("error" in read) return read
  const statuses = read.statuses.join(",")
  const statements = [
    env.DB.prepare("UPDATE release_tracks SET name = ?, statuses = ?, check_domain = ?, position = ?, keep_releases = ?, updated_at = ? WHERE id = ?").bind(read.name, statuses, read.checkDomain, read.position, read.keep, now, track.id),
    env.DB.prepare("UPDATE files SET statuses = ?, check_domain = ? WHERE track_id = ?").bind(statuses, read.checkDomain, track.id),
  ]
  if ("license" in owner && (statuses !== track.statuses || read.checkDomain !== track.check_domain)) {
    const set = await statusSetOf(env, owner)
    const detail = `Track updated: ${read.name} (receives ${describeStatusKeys(read.statuses, set) || "no status"})`
    statements.push(env.DB.prepare("INSERT INTO activity (license_id, at, event, status, detail) VALUES (?, ?, 'change', ?, ?)").bind(owner.license.id, now, owner.license.status, detail))
  }
  await env.DB.batch(statements)
  const updated = (await getTrack(env, owner, track.id))!
  const pruned = await pruneTrack(env, owner, updated, now)
  return { track: updated, pruned }
}

/** The releases a track would delete now to respect its limit, oldest first. Nothing is deleted. */
export async function releasesOverLimit(env: Env, track: Pick<ReleaseTrack, "id" | "keep_releases">, keep = track.keep_releases, spare: string | null = null) {
  const rows = (
    await env.DB.prepare("SELECT id, name, version, channel, withdrawn_at, uploaded_at, r2_key FROM files WHERE track_id = ? AND version <> ''")
      .bind(track.id)
      .all<{ id: string; name: string; version: string; channel: string; withdrawn_at: number | null; uploaded_at: number; r2_key: string }>()
  ).results
  return releasesToPrune(rows, keep).filter((f) => f.id !== spare).reverse()
}

/**
 * Deletes the oldest releases of a track beyond its limit, with their files in R2. Returns how many were deleted.
 * Called when a release is added and when the limit is lowered; a track without a limit is left alone. `spare` is a
 * release that is never deleted: the one just added, even when its version is older than the others.
 */
export async function pruneTrack(env: Env, owner: TrackOwner, track: ReleaseTrack, now = Date.now(), spare: string | null = null): Promise<number> {
  if (track.keep_releases === null) return 0
  const doomed = await releasesOverLimit(env, track, track.keep_releases, spare)
  if (doomed.length === 0) return 0
  if (env.FILES) for (let i = 0; i < doomed.length; i += 1000) await env.FILES.delete(doomed.slice(i, i + 1000).map((f) => f.r2_key))
  const statements: D1PreparedStatement[] = []
  for (let i = 0; i < doomed.length; i += 50) {
    const ids = doomed.slice(i, i + 50).map((f) => f.id)
    statements.push(env.DB.prepare(`DELETE FROM files WHERE id IN (${ids.map(() => "?").join(",")})`).bind(...ids))
  }
  if ("license" in owner) {
    const detail = `Releases removed by the limit of the track ${track.name} (keeps ${track.keep_releases}): ${doomed.map((f) => f.version).join(", ")}`.slice(0, 500)
    statements.push(env.DB.prepare("INSERT INTO activity (license_id, at, event, status, detail) VALUES (?, ?, 'change', ?, ?)").bind(owner.license.id, now, owner.license.status, detail))
  }
  await env.DB.batch(statements)
  return doomed.length
}

/**
 * Deletes a track. Its releases move to `moveTo` (another track of the owner), or the deletion is refused while it
 * has releases. Its connected repository is disconnected; releases it published stay.
 */
export async function deleteTrack(env: Env, owner: TrackOwner, track: ReleaseTrack, moveTo: string | null): Promise<{ ok: true } | Failure> {
  const count = (await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE track_id = ?").bind(track.id).first<{ n: number }>())?.n ?? 0
  const statements: D1PreparedStatement[] = []
  if (count > 0) {
    if (!moveTo) return { error: `The track "${track.name}" has ${count} release${count === 1 ? "" : "s"}. Choose a track to move ${count === 1 ? "it" : "them"} to, or delete ${count === 1 ? "it" : "them"} first.`, status: 409 }
    const target = await getTrack(env, owner, moveTo)
    if (!target || target.id === track.id) return { error: "Choose another track of the same app or licence to move the releases to.", status: 422 }
    statements.push(env.DB.prepare("UPDATE files SET track_id = ?, statuses = ?, check_domain = ? WHERE track_id = ?").bind(target.id, target.statuses, target.check_domain, track.id))
  }
  statements.push(
    env.DB.prepare("DELETE FROM source_imports WHERE source_id IN (SELECT id FROM release_sources WHERE track_id = ?)").bind(track.id),
    env.DB.prepare("DELETE FROM release_sources WHERE track_id = ?").bind(track.id),
    env.DB.prepare("DELETE FROM release_tracks WHERE id = ?").bind(track.id)
  )
  await env.DB.batch(statements)
  return { ok: true }
}

/**
 * The track a new release goes into, when the upload names none:
 *   - `statuses` given: the track with exactly those statuses, or a new track with them if no other track serves them;
 *   - nothing given: the owner's only track, or a new track "Releases" with the default release statuses when it has
 *     none. An owner with several tracks must name one.
 */
export async function resolveTrackForRelease(
  env: Env,
  owner: TrackOwner,
  trackRef: string | null,
  statuses: unknown,
  /** The domain check of a track created here. */
  checkDomain = true,
  now = Date.now()
): Promise<{ track: ReleaseTrack } | Failure> {
  if (trackRef) {
    const track = await findTrack(env, owner, trackRef)
    return track ? { track } : { error: `No track of this ${"license" in owner ? "licence" : "app"} matches "${trackRef}".`, status: 422 }
  }
  const tracks = await listTracks(env, owner)
  const set = await statusSetOf(env, owner)
  if (statuses !== undefined && statuses !== "") {
    const parsed = parseStatusKeys(statuses, set)
    if (!parsed) return { error: `statuses must be a comma separated list of licence statuses: ${set.map((s) => s.key).join(", ")}.`, status: 422 }
    const same = tracks.find((t) => t.statuses === parsed.join(","))
    if (same) return { track: same }
    const name = tracks.length === 0 ? "Releases" : `Releases for ${describeStatusKeys(parsed, set)}`.slice(0, MAX_TRACK_NAME)
    return createTrack(env, owner, { name, statuses: parsed, check_domain: checkDomain }, now)
  }
  if (tracks.length === 1) return { track: tracks[0] }
  if (tracks.length === 0) return createTrack(env, owner, { name: "Releases", statuses: defaultReleaseStatuses(set), check_domain: checkDomain }, now)
  return { error: `This ${"license" in owner ? "licence" : "app"} has ${tracks.length} tracks: choose the track of the release (${tracks.map((t) => t.name).join(", ")}).`, status: 422 }
}

/** Statuses a licence's own tracks cover: for these, the app's releases do not apply to the licence. */
export async function overriddenStatuses(env: Env, license: License): Promise<Set<string>> {
  if (!license.app_id) return new Set()
  const own = await listTracks(env, { license })
  return new Set(own.flatMap(trackStatusKeys))
}

/**
 * Handles the track intents of an app or licence page: "create-track", "update-track" and "delete-track". Returns
 * `{ ok: true }` or `{ error }` for the page's fetcher, or null when the intent is not a track intent.
 */
export async function applyTrackForm(env: Env, owner: TrackOwner, form: FormData): Promise<{ ok: true } | { error: string } | null> {
  const intent = String(form.get("intent"))
  if (!["create-track", "update-track", "delete-track"].includes(intent)) return null
  const input: TrackInput = {
    name: form.has("name") ? String(form.get("name")) : undefined,
    statuses: form.has("statuses") ? String(form.get("statuses")) : undefined,
    check_domain: form.has("check_domain") ? form.get("check_domain") === "true" : undefined,
    keep_releases: form.has("keep_releases") ? String(form.get("keep_releases")) : undefined,
  }
  if (intent === "create-track") {
    const created = await createTrack(env, owner, input)
    return "error" in created ? { error: created.error } : { ok: true }
  }
  const track = await getTrack(env, owner, String(form.get("trackId") ?? ""))
  if (!track) return { error: "That track no longer exists. Reload the page." }
  if (intent === "update-track") {
    const updated = await updateTrack(env, owner, track, input)
    return "error" in updated ? { error: updated.error } : { ok: true }
  }
  const moveTo = String(form.get("move_to") ?? "") || null
  const deleted = await deleteTrack(env, owner, track, moveTo)
  return "error" in deleted ? { error: deleted.error } : { ok: true }
}
