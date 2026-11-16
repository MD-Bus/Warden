/**
 * Release channels of a track. Pure and client-safe.
 *
 * Each track has its own channels. Stable always exists and is what a site receives when it asks for no channel (or
 * for one the track does not have); Beta exists by default. A channel can also receive the releases of other channels
 * ("includes"): Beta includes Stable, so a beta site is offered the newest of both. Each channel can follow its own
 * repository and branch (release-sources). A track stores its channels as JSON; NULL, for a track created before
 * channels existed, means DEFAULT_CHANNELS, which is exactly how stable and beta behaved before.
 */

export type ChannelDef = {
  /** What sites send (?channel=) and what releases store. Fixed once created. */
  key: string
  name: string
  /** Other channels whose releases this channel also receives. */
  includes: string[]
}

export const STABLE = "stable"
export const CHANNEL_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/
export const MAX_CHANNEL_NAME = 30
export const MAX_TRACK_CHANNELS = 10

export const DEFAULT_CHANNELS: ChannelDef[] = [
  { key: STABLE, name: "Stable", includes: [] },
  { key: "beta", name: "Beta", includes: [STABLE] },
]

/** The channel a check or download asks for: a well-formed key, or stable. Whether the track has it is decided later. */
export function readRequestedChannel(raw: unknown): string {
  return typeof raw === "string" && CHANNEL_KEY_PATTERN.test(raw.trim().toLowerCase()) ? raw.trim().toLowerCase() : STABLE
}

/** The key a channel gets from its name: "Release candidate" gives release-candidate. Empty when unusable. */
export function channelKeyFromName(name: string): string {
  const key = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 32)
    .replace(/-+$/, "")
  return CHANNEL_KEY_PATTERN.test(key) ? key : ""
}

/** The channels a track stores. NULL (a track from before channels) and unreadable data give the defaults. */
export function readTrackChannels(raw: string | null | undefined): ChannelDef[] {
  if (raw === null || raw === undefined) return DEFAULT_CHANNELS
  try {
    const parsed = parseChannelDefinitions(JSON.parse(raw))
    return "channels" in parsed ? parsed.channels : DEFAULT_CHANNELS
  } catch {
    return DEFAULT_CHANNELS
  }
}

/**
 * Validates the channels of a track: an array of { key?, name, includes? }. Stable must be there, first, and includes
 * nothing, because it is what sites that ask for no channel receive. A channel without a key takes one from its name.
 */
export function parseChannelDefinitions(input: unknown): { channels: ChannelDef[] } | { error: string } {
  if (!Array.isArray(input)) return { error: "channels must be an array of { key, name, includes }." }
  if (input.length > MAX_TRACK_CHANNELS) return { error: `A track can have up to ${MAX_TRACK_CHANNELS} channels.` }
  const channels: ChannelDef[] = []
  for (const item of input) {
    if (!item || typeof item !== "object") return { error: "Each channel must be an object with a name." }
    const { key: rawKey, name: rawName, includes: rawIncludes } = item as Record<string, unknown>
    const name = typeof rawName === "string" ? rawName.trim() : ""
    if (!name) return { error: "Each channel needs a name." }
    if (name.length > MAX_CHANNEL_NAME) return { error: `Channel names are limited to ${MAX_CHANNEL_NAME} characters.` }
    const key = typeof rawKey === "string" && rawKey.trim() ? rawKey.trim() : channelKeyFromName(name)
    if (!CHANNEL_KEY_PATTERN.test(key)) return { error: `The channel "${name}" needs a key: a lowercase letter, then up to 31 lowercase letters, digits, dashes or underscores.` }
    if (channels.some((c) => c.key === key)) return { error: `Two channels have the key "${key}".` }
    if (channels.some((c) => c.name.toLowerCase() === name.toLowerCase())) return { error: `Two channels are named "${name}".` }
    if (rawIncludes !== undefined && (!Array.isArray(rawIncludes) || rawIncludes.some((k) => typeof k !== "string"))) return { error: `includes of "${name}" must be a list of channel keys.` }
    channels.push({ key, name, includes: [...new Set((rawIncludes as string[] | undefined) ?? [])] })
  }
  const stable = channels.find((c) => c.key === STABLE)
  if (!stable) return { error: "The stable channel cannot be removed: sites that ask for no channel receive it." }
  if (stable.includes.length > 0) return { error: "Stable cannot include other channels: sites that ask for no channel must receive stable releases only." }
  for (const channel of channels) {
    const unknown = channel.includes.find((k) => k === channel.key || !channels.some((c) => c.key === k))
    if (unknown) return { error: `"${channel.name}" includes "${unknown}", which is not another channel of this track.` }
  }
  // Stable first: it is the default, and the order the dashboard shows.
  return { channels: [stable, ...channels.filter((c) => c !== stable)] }
}

/** The release channels a site asking for `requested` receives: that channel and those it includes. Unknown: stable. */
export function acceptedChannels(channels: ChannelDef[], requested: string): string[] {
  const def = channels.find((c) => c.key === requested) ?? channels.find((c) => c.key === STABLE)
  return def ? [def.key, ...def.includes] : [STABLE]
}

/** The name of a channel for display: its name in the track, or its key when the track no longer has it. */
export const channelName = (channels: ChannelDef[], key: string): string => channels.find((c) => c.key === key)?.name ?? key
