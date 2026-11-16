/**
 * Release labels: the labels a track defines, each with a colour, and that its releases carry (urgent, security, ...).
 * Pure and client-safe.
 *
 * Each track has its own set of labels. A track stores them as JSON; a track created before labels existed stores
 * NULL and uses DEFAULT_RELEASE_LABELS. A release stores the keys of its labels, comma separated, and sites receive
 * those keys in `labels` with the release.
 */

export type ReleaseLabel = {
  /** Fixed once created: sites read it. Lowercase letter first, then lowercase letters, digits and underscores. */
  key: string
  name: string
  /** Hex colour, #rrggbb. */
  color: string
}

export const LABEL_KEY_PATTERN = /^[a-z][a-z0-9_]{0,31}$/
export const LABEL_COLOR_PATTERN = /^#[0-9a-f]{6}$/
export const MAX_LABEL_NAME = 30
export const MAX_TRACK_LABELS = 20

/** The labels of a new track. */
export const DEFAULT_RELEASE_LABELS: ReleaseLabel[] = [
  { key: "urgent", name: "Urgent", color: "#dc2626" },
  { key: "security", name: "Security", color: "#ea580c" },
  { key: "bug_fix", name: "Bug fix", color: "#2563eb" },
  { key: "feature", name: "New feature", color: "#16a34a" },
]

/** The key a label gets from its name: "Bug fix" gives bug_fix. Empty when the name has no usable letter. */
export function labelKeyFromName(name: string): string {
  const key = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 32)
    .replace(/_+$/, "")
  return LABEL_KEY_PATTERN.test(key) ? key : ""
}

/** The labels a track stores. NULL (a track from before labels) gives the default labels; unreadable data gives none. */
export function readTrackLabels(raw: string | null | undefined): ReleaseLabel[] {
  if (raw === null || raw === undefined) return DEFAULT_RELEASE_LABELS
  try {
    const parsed = parseLabelDefinitions(JSON.parse(raw))
    return "labels" in parsed ? parsed.labels : []
  } catch {
    return []
  }
}

/**
 * Validates the labels of a track: an array of { key?, name, color }. A label without a key takes one from its name.
 * Keys and names must be unique within the track.
 */
export function parseLabelDefinitions(input: unknown): { labels: ReleaseLabel[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "labels must be an array of { key, name, color }." }
  if (input.length > MAX_TRACK_LABELS) return { error: `A track can define up to ${MAX_TRACK_LABELS} labels.` }
  const labels: ReleaseLabel[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") return { error: "Each label must be an object with a name and a color." }
    const { key: rawKey, name: rawName, color: rawColor } = item as Record<string, unknown>
    const name = typeof rawName === "string" ? rawName.trim() : ""
    if (!name) return { error: "Each label needs a name." }
    if (name.length > MAX_LABEL_NAME) return { error: `Label names are limited to ${MAX_LABEL_NAME} characters ("${name.slice(0, MAX_LABEL_NAME)}...").` }
    const key = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : labelKeyFromName(name)
    if (!LABEL_KEY_PATTERN.test(key)) {
      return { error: `The label "${name}" needs a key: a lowercase letter, then up to 31 lowercase letters, digits or underscores.` }
    }
    const color = typeof rawColor === "string" ? rawColor.trim().toLowerCase() : ""
    if (!LABEL_COLOR_PATTERN.test(color)) return { error: `The colour of "${name}" must be a hex colour such as #dc2626.` }
    if (labels.some((l) => l.key === key)) return { error: `Two labels have the key "${key}". Each label needs its own key.` }
    if (labels.some((l) => l.name.toLowerCase() === name.toLowerCase())) return { error: `Two labels are named "${name}".` }
    labels.push({ key, name, color })
  }
  return { labels }
}

/** The label keys a release stores (comma separated). */
export const splitLabelKeys = (raw: string | null | undefined): string[] => (raw ?? "").split(",").filter(Boolean)

/**
 * Validates the labels given to a release: label keys of its track, as an array or a comma separated string. Returns
 * them in the track's order, without duplicates.
 */
export function parseReleaseLabels(input: unknown, labels: ReleaseLabel[]): { keys: string[] } | { error: string } {
  const list = Array.isArray(input) ? input : typeof input === "string" ? input.split(",") : null
  if (!list || list.some((k) => typeof k !== "string")) return { error: "labels must be a list of label keys." }
  const wanted = new Set((list as string[]).map((k) => k.trim()).filter(Boolean))
  const unknown = [...wanted].filter((k) => !labels.some((l) => l.key === k))
  if (unknown.length > 0) {
    return { error: `${unknown.map((k) => `"${k}"`).join(", ")} ${unknown.length === 1 ? "is not a label" : "are not labels"} of this track. Labels: ${labels.map((l) => l.key).join(", ") || "none"}.` }
  }
  return { keys: labels.filter((l) => wanted.has(l.key)).map((l) => l.key) }
}

/** The keys that are still labels of the track, in its order: used when a track's labels change or a release moves. */
export const keepKnownLabels = (keys: string[], labels: ReleaseLabel[]): string[] => labels.filter((l) => keys.includes(l.key)).map((l) => l.key)
