/**
 * Release logic shared by the server, the dashboard and the tests. A release is a file with a version that has not
 * been withdrawn. Files without a version are attachments: they can be downloaded but are never offered as an update.
 */

/** Release channels. Stable releases are offered to every site; beta releases only to sites that ask for them. */
export const CHANNELS = ["stable", "beta"] as const
export type Channel = (typeof CHANNELS)[number]

export function isChannel(value: unknown): value is Channel {
  return typeof value === "string" && (CHANNELS as readonly string[]).includes(value)
}

/** The channels a site receives when it asks for `requested`: beta includes stable releases, stable only stable ones. */
export function channelsFor(requested: Channel): Channel[] {
  return requested === "beta" ? ["stable", "beta"] : ["stable"]
}

export const MAX_VERSION_LENGTH = 40
export const MAX_CHANGELOG_LENGTH = 10_000

/**
 * A version: numeric parts separated by dots (1 to 4 of them, an optional leading "v"), then an optional pre-release
 * suffix ("-beta.2") and build suffix ("+build.7"). Examples: 1.4.0, v2.0, 3.1.0-rc.1.
 */
export const VERSION_FORMAT = /^v?\d+(\.\d+){0,3}(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/

export function isValidVersion(value: string): boolean {
  return value.length <= MAX_VERSION_LENGTH && VERSION_FORMAT.test(value)
}

/** Reads a version reported by a site. Returns null when it is missing or not a valid version. */
export function readReportedVersion(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const value = raw.trim()
  return value && isValidVersion(value) ? value : null
}

/** Splits a version into its numeric parts and its pre-release parts. The build suffix is dropped. */
function parse(version: string): { core: number[]; pre: string[] } {
  const plain = version.trim().replace(/^v/i, "").split("+")[0]
  const dash = plain.indexOf("-")
  const main = dash === -1 ? plain : plain.slice(0, dash)
  const pre = dash === -1 ? [] : plain.slice(dash + 1).split(".").filter(Boolean)
  return { core: main.split(".").map((n) => Number.parseInt(n, 10) || 0), pre }
}

/**
 * Compares two versions following semantic versioning precedence: numeric parts first (1.10.0 > 1.9.2, 2.0 = 2.0.0),
 * then a version without a pre-release suffix ranks above one with it (2.0.0 > 2.0.0-rc.1), and pre-release parts are
 * compared one by one (numbers numerically, below words). Build suffixes and a leading "v" are ignored.
 * Returns a negative number, zero or a positive number.
 */
export function compareVersions(a: string, b: string): number {
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.core.length, y.core.length); i++) {
    const diff = (x.core[i] ?? 0) - (y.core[i] ?? 0)
    if (diff !== 0) return diff
  }
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined) return -1
    if (q === undefined) return 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn) {
      const diff = Number(p) - Number(q)
      if (diff !== 0) return diff
    } else if (pn !== qn) {
      return pn ? -1 : 1
    } else if (p !== q) {
      return p < q ? -1 : 1
    }
  }
  return 0
}

export type ReleaseLike = { version: string; channel: string; withdrawn_at: number | null }

/** True for a file that is offered as an update: it has a version and has not been withdrawn. */
export function isRelease(file: ReleaseLike): boolean {
  return file.version.trim() !== "" && file.withdrawn_at === null
}

/**
 * The release with the highest version among `files` in the channels `requested` receives. Ties keep the first entry,
 * so pass files newest first to prefer the most recent upload of a version.
 */
export function latestRelease<T extends ReleaseLike>(files: T[], requested: Channel = "stable"): T | null {
  const channels = channelsFor(requested) as string[]
  let best: T | null = null
  for (const file of files) {
    if (!isRelease(file) || !channels.includes(file.channel)) continue
    if (!best || compareVersions(file.version, best.version) > 0) best = file
  }
  return best
}

/** Whether a site on `installed` is behind `latest`. Unknown versions are never reported as outdated. */
export function isOutdated(installed: string | null | undefined, latest: string | null | undefined): boolean {
  return Boolean(installed && latest && compareVersions(installed, latest) < 0)
}

/** Sorts files for display: releases by version, newest first, then attachments by upload date, newest first. */
export function sortForDisplay<T extends ReleaseLike & { uploaded_at: number }>(files: T[]): T[] {
  return [...files].sort((a, b) => {
    const av = a.version.trim() !== ""
    const bv = b.version.trim() !== ""
    if (av !== bv) return av ? -1 : 1
    if (av && bv) {
      const diff = compareVersions(b.version, a.version)
      if (diff !== 0) return diff
    }
    return b.uploaded_at - a.uploaded_at
  })
}

/** The largest release limit a track accepts. */
export const MAX_KEEP_RELEASES = 1000

/**
 * Validates a track's release limit: null (or an empty string) keeps every release, otherwise a whole number from 1 to
 * MAX_KEEP_RELEASES. Returns the value, or an error message.
 */
export function readKeepReleases(raw: unknown): { keep: number | null } | { error: string } {
  if (raw === null || raw === "") return { keep: null }
  const n = typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_KEEP_RELEASES) return { error: `keep_releases must be a whole number from 1 to ${MAX_KEEP_RELEASES}, or null to keep every release.` }
  return { keep: n }
}

/**
 * The releases a track with the limit `keep` deletes: the oldest by version beyond the newest `keep`. Withdrawn
 * releases count towards the limit. The newest stable release and the newest beta release (the ones sites are offered)
 * are never returned, even when the limit is lower. Attachments (files without a version) are not releases.
 */
export function releasesToPrune<T extends ReleaseLike & { id: string; uploaded_at: number }>(files: T[], keep: number | null): T[] {
  if (keep === null) return []
  const releases = sortForDisplay(files.filter((f) => f.version.trim() !== ""))
  if (releases.length <= keep) return []
  const kept = new Set(releases.slice(0, keep).map((f) => f.id))
  for (const channel of CHANNELS) {
    const offered = latestRelease(releases, channel)
    if (offered) kept.add(offered.id)
  }
  return releases.filter((f) => !kept.has(f.id))
}
