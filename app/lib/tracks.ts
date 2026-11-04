/**
 * Release tracks: what a set of licence statuses receives. Pure and client-safe.
 *
 * An app or a standalone licence has any number of tracks. Each status belongs to at most one track of its owner,
 * so a licence receives its releases from exactly one track: the highest version of that track it may download.
 * A licence of an app can have tracks of its own; for the statuses they cover, they replace the app's tracks.
 */

export const MAX_TRACK_NAME = 60

export type TrackLike = { id: string; name: string; statuses: string; position?: number }


export const trackStatusKeys = (track: Pick<TrackLike, "statuses">): string[] => track.statuses.split(",").filter(Boolean)

/** Statuses of `statuses` that another track (other than `exceptId`) already serves, with that track. */
export function trackOverlaps<T extends TrackLike>(tracks: T[], statuses: string[], exceptId: string | null = null): { status: string; track: T }[] {
  const out: { status: string; track: T }[] = []
  for (const track of tracks) {
    if (track.id === exceptId) continue
    const keys = trackStatusKeys(track)
    for (const status of statuses) if (keys.includes(status)) out.push({ status, track })
  }
  return out
}

/** Statuses served by more than one track. Only possible for data that predates tracks; edits cannot create them. */
export function statusConflicts<T extends TrackLike>(tracks: T[]): { status: string; tracks: T[] }[] {
  const byStatus = new Map<string, T[]>()
  for (const track of tracks) for (const key of trackStatusKeys(track)) byStatus.set(key, [...(byStatus.get(key) ?? []), track])
  return [...byStatus].filter(([, list]) => list.length > 1).map(([status, list]) => ({ status, tracks: list }))
}

/**
 * The track that serves a status for a licence: its own track for that status if it has one, otherwise its app's.
 * Returns null when no track serves the status.
 */
export function trackForStatus<T extends TrackLike>(status: string, ownTracks: T[], appTracks: T[] = []): { track: T; inherited: boolean } | null {
  const own = ownTracks.find((t) => trackStatusKeys(t).includes(status))
  if (own) return { track: own, inherited: false }
  const app = appTracks.find((t) => trackStatusKeys(t).includes(status))
  return app ? { track: app, inherited: true } : null
}

/** Validates a track name. Returns an error message, or null. */
export function trackNameError(name: string): string | null {
  if (!name.trim()) return "Enter a name for the track, for example Updates or Final build."
  if (name.trim().length > MAX_TRACK_NAME) return `The name is limited to ${MAX_TRACK_NAME} characters.`
  return null
}

/**
 * Tag prefixes tell apart tracks fed by the same repository: "" takes v1.4.0, "final-" takes final-v1.4.0.
 * Letters, digits, dot, dash, underscore and slash; up to 40 characters.
 */
export const TAG_PREFIX_PATTERN = /^[A-Za-z0-9._/-]{0,40}$/

/**
 * Among several prefixes of the same repository, the one a tag belongs to: the longest prefix the tag starts with.
 * Returns null when none matches.
 */
export function prefixForTag(tag: string, prefixes: string[]): string | null {
  let best: string | null = null
  for (const prefix of prefixes) if (tag.startsWith(prefix) && (best === null || prefix.length > best.length)) best = prefix
  return best
}

/** A track as the dashboard shows it: status keys as a list, the domain check as a boolean. */
export const trackView = (track: TrackLike & { check_domain: number; keep_releases: number | null }) => ({ id: track.id, name: track.name, statuses: trackStatusKeys(track), check_domain: track.check_domain === 1, keep_releases: track.keep_releases })
