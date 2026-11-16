import { MAX_FILE_BYTES } from "../lib/files"
import { generateSecret } from "../lib/random"
import {
  channelForVersion,
  IMPORT_CLAIM_MS,
  IMPORT_MAX_ATTEMPTS,
  IMPORT_TIMEOUT_MS,
  isProvider,
  isTrigger,
  packageFileName,
  packageFolderError,
  parseRepository,
  PROVIDER_INFO,
  PROVIDERS,
  TRIGGERS,
  versionFromTag,
  type ImportState,
  type ProviderKey,
  type TriggerKey,
} from "../lib/sources"
import { splitStatusKeys } from "../lib/statuses"
import { fillPart, planRepack, readDirectory, sourceRange, tailLength, ZipError } from "../lib/zip"
import { readTextUpTo } from "./api-http.server"
import { getApp } from "./apps.server"
import { findAppRepository, getGitHubApp, installationToken } from "./github-app.server"
import { fileKey, releaseWithVersion, statusSetForOwner, storeFile, type FileOwner } from "./files.server"
import { getLicense } from "./licenses.server"
import { blockSize, hashObject, readRange, sha256Hasher, uploadStream } from "./storage.server"
import { github } from "./source-providers/github.server"
import type { ProviderFailure, ProviderSource, SourceProvider } from "./source-providers/types"
import { getTrack, listTracks, type ReleaseTrack } from "./tracks.server"
import { json, newId } from "./util.server"
import { prefixForTag, TAG_PREFIX_PATTERN, trackView } from "../lib/tracks"
import { channelName, readTrackChannels, STABLE, type ChannelDef } from "../lib/channels"
import type { WebhookEvent } from "./source-providers/types"

/** A branch name as Git allows it, kept to the characters branch names use in practice. */
export const BRANCH_PATTERN = /^(?!\/)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}(?<![/.])$/

/** The implementation of each provider listed in app/lib/sources.ts. */
const PROVIDER_IMPLEMENTATIONS: Record<ProviderKey, SourceProvider> = {
  github,
}

export type ReleaseSource = {
  id: string
  app_id: string | null
  license_id: string | null
  provider: ProviderKey
  repository: string
  trigger: TriggerKey
  package_folder: string
  statuses: string
  check_domain: number
  /** Access token for a private repository. Never sent to the dashboard or the API. */
  token: string
  webhook_secret: string
  options: string
  enabled: number
  /** Set when the repository is reached through the install's GitHub App; null when it uses `token`. */
  installation_id: number | null
  /** The provider's numeric id of the repository, which survives renames. */
  repository_id: number | null
  /** The track this repository publishes into. */
  track_id: string | null
  /** Tags this source publishes start with this ("" for v1.4.0, "final-" for final-v1.4.0). */
  tag_prefix: string
  /** The channel of the track this source publishes into (stable by default). */
  channel: string
  /** The branch whose tags it publishes; "" takes tags made on any branch. */
  branch: string
  created_at: number
  updated_at: number
  last_delivery_at: number | null
}

export type SourceImport = {
  id: string
  source_id: string
  ref: string
  commit_sha: string
  version: string
  state: ImportState
  detail: string
  file_id: string | null
  started_at: number
  finished_at: number | null
  /** Progress of a pending import (migration 0015): see runImport. */
  stage: "" | "repack" | "store"
  upload_id: string
  package_key: string
  parts: string
  archive_size: number | null
  attempts: number
  claimed_until: number | null
}

/** A source as the dashboard and the API show it: without the token, with the webhook address. */
export type PublicSource = Omit<ReleaseSource, "token" | "options" | "enabled" | "check_domain"> & {
  /** app: through the install's GitHub App; token: an access token (optional) and a webhook of its own. */
  connection: "app" | "token"
  has_token: boolean
  enabled: boolean
  check_domain: boolean
  status_keys: string[]
  webhook_url: string
}

type Failure = { error: string; status: number }

const ownerColumn = (owner: FileOwner) => ("license" in owner ? "license_id" : "app_id")
const ownerId = (owner: FileOwner) => ("license" in owner ? owner.license.id : owner.app.id)

/** The repositories connected to an app or licence, one per channel of a track. */
export async function listSources(env: Env, owner: FileOwner): Promise<ReleaseSource[]> {
  return (await env.DB.prepare(`SELECT * FROM release_sources WHERE ${ownerColumn(owner)} = ? ORDER BY created_at`).bind(ownerId(owner)).all<ReleaseSource>()).results
}

/** The repository a channel of a track follows, if any. */
export function getSourceForTrack(env: Env, owner: FileOwner, trackId: string, channel: string = STABLE): Promise<ReleaseSource | null> {
  return env.DB.prepare(`SELECT * FROM release_sources WHERE track_id = ? AND channel = ? AND ${ownerColumn(owner)} = ?`).bind(trackId, channel, ownerId(owner)).first<ReleaseSource>()
}

export function getSourceById(env: Env, id: string): Promise<ReleaseSource | null> {
  return env.DB.prepare("SELECT * FROM release_sources WHERE id = ?").bind(id).first<ReleaseSource>()
}

export async function publicSource(env: Env, source: ReleaseSource, origin: string): Promise<PublicSource> {
  const { token, options: _options, ...rest } = source
  const owner = await ownerOf(env, source)
  const track = owner && source.track_id ? await getTrack(env, owner, source.track_id) : null
  const statuses = track?.statuses ?? source.statuses
  return {
    ...rest,
    connection: source.installation_id ? "app" : "token",
    has_token: token !== "",
    enabled: source.enabled === 1,
    check_domain: (track?.check_domain ?? source.check_domain) === 1,
    status_keys: owner ? splitStatusKeys(statuses, await statusSetForOwner(env, owner)) : statuses.split(",").filter(Boolean),
    webhook_url: `${origin}/hooks/${source.provider}/${source.id}`,
  }
}

async function ownerOf(env: Env, source: ReleaseSource): Promise<FileOwner | null> {
  if (source.app_id) {
    const app = await getApp(env, source.app_id)
    return app ? { app } : null
  }
  const license = source.license_id ? await getLicense(env, source.license_id) : null
  return license ? { license } : null
}

/** Fields accepted when connecting or editing a source. Absent fields keep their current value. */
export type SourceInput = {
  provider?: unknown
  repository?: unknown
  trigger?: unknown
  package_folder?: unknown
  /** Tags this source publishes start with this prefix ("" by default). */
  tag_prefix?: unknown
  /** Only tags made on this branch publish; "" (default) takes tags made on any branch. */
  branch?: unknown
  /** Not accepted: a repository publishes into its track, which decides availability. */
  statuses?: unknown
  check_domain?: unknown
  /** app (through the GitHub App) or token. Default for a new source: app when a GitHub App is connected and no token is sent. */
  connection?: unknown
  /** A new token; "" removes it; absent keeps the current one. Ignored with connection app. */
  token?: unknown
  enabled?: unknown
}

/**
 * Connects a repository to a channel of a track, or changes the connected one. The repository is checked with the
 * provider first, so a typo or a token without access is reported now rather than on the first tag.
 */
export async function saveSource(env: Env, owner: FileOwner, track: ReleaseTrack, input: SourceInput, now = Date.now(), channel: string = STABLE): Promise<{ source: ReleaseSource; created: boolean } | Failure> {
  if (input.statuses !== undefined || input.check_domain !== undefined) {
    return { error: `A repository publishes into its track ("${track.name}"), which decides which statuses receive its releases. Change the track instead.`, status: 422 }
  }
  const channels = readTrackChannels(track.channels)
  if (!channels.some((c) => c.key === channel)) return { error: `The track "${track.name}" has no channel "${channel}". Its channels: ${channels.map((c) => c.key).join(", ")}.`, status: 422 }
  const current = await getSourceForTrack(env, owner, track.id, channel)
  const provider = input.provider === undefined ? (current?.provider ?? "github") : input.provider
  if (!isProvider(provider))
    return {
      error: `provider must be one of: ${PROVIDERS.join(", ")}.`,
      status: 422,
    }
  const trigger = input.trigger === undefined ? (current?.trigger ?? "tag") : input.trigger
  if (!isTrigger(trigger))
    return {
      error: `trigger must be one of: ${TRIGGERS.join(", ")}.`,
      status: 422,
    }

  const rawRepository = input.repository === undefined ? current?.repository : input.repository
  const repository = typeof rawRepository === "string" ? parseRepository(provider, rawRepository) : null
  if (!repository)
    return {
      error: `Enter the repository as ${PROVIDER_INFO[provider].repositoryHint}.`,
      status: 422,
    }

  const rawFolder = input.package_folder === undefined || input.package_folder === "" ? (current?.package_folder ?? repository.split("/")[1]) : input.package_folder
  const folder = typeof rawFolder === "string" ? rawFolder.trim() : ""
  const folderError = packageFolderError(folder)
  if (folderError) return { error: folderError, status: 422 }

  const rawPrefix = input.tag_prefix === undefined ? (current?.tag_prefix ?? "") : input.tag_prefix
  if (typeof rawPrefix !== "string" || !TAG_PREFIX_PATTERN.test(rawPrefix.trim())) return { error: "The tag prefix may contain only letters, digits, dots, dashes, underscores and slashes, up to 40 characters.", status: 422 }
  const tagPrefix = rawPrefix.trim()
  const rawBranch = input.branch === undefined ? (current?.branch ?? "") : input.branch
  if (typeof rawBranch !== "string" || (rawBranch.trim() !== "" && !BRANCH_PATTERN.test(rawBranch.trim()))) return { error: "Enter a branch name such as main or beta, or leave it empty to take tags made on any branch.", status: 422 }
  const branch = rawBranch.trim()
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") return { error: "enabled must be true or false.", status: 422 }
  if (input.token !== undefined && typeof input.token !== "string") return { error: "token must be a string.", status: 422 }
  let token = input.token === undefined ? (current?.token ?? "") : (input.token as string).trim()
  if (token.length > 500 || /\s/.test(token)) return { error: "The access token is not valid.", status: 422 }
  const enabled = input.enabled === undefined ? (current?.enabled ?? 1) : input.enabled ? 1 : 0

  // Two tracks fed by the same repository need different tag prefixes, or every tag would publish twice. Within a
  // track, channels can follow the same repository and prefix when each follows its own branch (one may follow none).
  const others = (await listSources(env, owner)).filter((o) => o.id !== current?.id)
  const same = others.filter((o) => o.provider === provider && o.repository.toLowerCase() === repository.toLowerCase() && o.tag_prefix === tagPrefix)
  const clash = same.find((o) => o.track_id !== track.id)
  const sibling = same.find((o) => o.track_id === track.id && o.branch === branch)
  if (sibling) {
    const name = channelName(channels, sibling.channel)
    return {
      error: branch
        ? `The channel ${name} already follows the branch ${branch} of ${repository}. Each channel of a track that follows the same repository needs its own branch.`
        : `The channel ${name} already takes tags from any branch of ${repository}. Enter the branch this channel follows, for example beta.`,
      status: 409,
    }
  }
  if (clash) {
    const tracks = await listTracks(env, owner)
    const name = tracks.find((t) => t.id === clash.track_id)?.name ?? "another track"
    return { error: `${repository} already publishes into "${name}" with ${tagPrefix ? `the tag prefix "${tagPrefix}"` : "no tag prefix"}. Use a different tag prefix for this track, for example "final-".`, status: 409 }
  }

  const githubApp = provider === "github" ? await getGitHubApp(env) : null
  const connection =
    input.connection !== undefined
      ? input.connection
      : current
        ? current.installation_id
          ? "app"
          : "token"
        : githubApp && !(typeof input.token === "string" && input.token.trim())
          ? "app"
          : "token"
  if (connection !== "app" && connection !== "token") return { error: "connection must be app or token.", status: 422 }

  // Check access only when what is checked changed: the repository, the provider, the connection or the token.
  let name = repository
  let installationId = current?.installation_id ?? null
  let repositoryId = current?.repository_id ?? null
  const unchanged = current && current.repository === repository && current.provider === provider
  if (connection === "app") {
    if (!githubApp) return { error: "No GitHub App is connected. Connect GitHub under Integrations, or connect this repository with an access token.", status: 422 }
    token = ""
    if (!unchanged || !current.installation_id) {
      const found = await findAppRepository(githubApp, repository)
      if ("error" in found) return { error: found.error, status: 422 }
      name = found.full_name
      installationId = found.installation_id
      repositoryId = found.repository_id
    }
  } else {
    installationId = null
    if (!unchanged || current.installation_id || current.token !== token) {
      const access = await PROVIDER_IMPLEMENTATIONS[provider].checkAccess({ repository, token, webhook_secret: "" })
      if ("error" in access) return { error: access.error, status: 422 }
      repositoryId = access.id
    }
  }

  if (current) {
    await env.DB.prepare(
      "UPDATE release_sources SET provider = ?, repository = ?, trigger = ?, package_folder = ?, tag_prefix = ?, branch = ?, statuses = ?, check_domain = ?, token = ?, enabled = ?, installation_id = ?, repository_id = ?, updated_at = ? WHERE id = ?",
    )
      .bind(provider, name, trigger, folder, tagPrefix, branch, track.statuses, track.check_domain, token, enabled, installationId, repositoryId, now, current.id)
      .run()
    return { source: (await getSourceById(env, current.id))!, created: false }
  }
  const id = newId("src")
  await env.DB.prepare(
    `INSERT INTO release_sources (id, app_id, license_id, track_id, channel, branch, tag_prefix, provider, repository, trigger, package_folder, statuses, check_domain, token, webhook_secret, enabled, installation_id, repository_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      "app" in owner ? owner.app.id : null,
      "license" in owner ? owner.license.id : null,
      track.id,
      channel,
      branch,
      tagPrefix,
      provider,
      name,
      trigger,
      folder,
      track.statuses,
      track.check_domain,
      token,
      generateSecret(40),
      enabled,
      installationId,
      repositoryId,
      now,
      now,
    )
    .run()
  return { source: (await getSourceById(env, id))!, created: true }
}

export async function regenerateWebhookSecret(env: Env, source: ReleaseSource): Promise<void> {
  await env.DB.prepare("UPDATE release_sources SET webhook_secret = ?, updated_at = ? WHERE id = ?").bind(generateSecret(40), Date.now(), source.id).run()
}

/** Disconnects the repository. Releases it already published stay. */
export async function deleteSource(env: Env, source: ReleaseSource): Promise<void> {
  // Imports in progress lose their record: their working copies and unpublished packages go first.
  const running = (await env.DB.prepare("SELECT id, stage, upload_id, package_key FROM source_imports WHERE source_id = ? AND state = 'pending'").bind(source.id).all<Work & { id: string }>()).results
  for (const row of running) await discardWork(env, row.id, row)
  await env.DB.batch([env.DB.prepare("DELETE FROM source_imports WHERE source_id = ?").bind(source.id), env.DB.prepare("DELETE FROM release_sources WHERE id = ?").bind(source.id)])
}

const timedOut = (row: SourceImport, now: number) => row.state === "pending" && now - row.started_at > IMPORT_TIMEOUT_MS
const TIMEOUT_DETAIL = "The import did not finish. Retry it."
const STOPPED_DETAIL = `Cloudflare stopped the import ${IMPORT_MAX_ATTEMPTS} times without progress, most likely at the Workers CPU or memory limit. Retry it, or make the repository archive smaller (export-ignore in .gitattributes).`

/** The working copy of an import in R2: the downloaded archive. The package is written directly as the release's file. */
const archiveKey = (importId: string) => `imports/${importId}/archive.zip`

/** The latest imports of a source, newest first. Imports pending for too long are reported as failed. */
export async function listImports(env: Env, sourceId: string, limit = 20, now = Date.now()): Promise<SourceImport[]> {
  const rows = (await env.DB.prepare("SELECT * FROM source_imports WHERE source_id = ? ORDER BY started_at DESC, id DESC LIMIT ?").bind(sourceId, limit).all<SourceImport>()).results
  return rows.map((row) => (timedOut(row, now) ? { ...row, state: "failed", detail: TIMEOUT_DETAIL } : row))
}

export function getImport(env: Env, sourceId: string, importId: string): Promise<SourceImport | null> {
  return env.DB.prepare("SELECT * FROM source_imports WHERE id = ? AND source_id = ?").bind(importId, sourceId).first<SourceImport>()
}

/**
 * Marks imports that never finished as failed, and deletes working copies left in R2 by imports that no longer run
 * (for example when their repository was disconnected during the import). Run by the daily cron.
 */
export async function pruneImports(env: Env, now = Date.now()): Promise<void> {
  const stale = (await env.DB.prepare("SELECT id FROM source_imports WHERE state = 'pending' AND started_at < ?").bind(now - IMPORT_TIMEOUT_MS).all<{ id: string }>()).results
  for (const row of stale) await finish(env, row.id, "failed", TIMEOUT_DETAIL)
  if (!env.FILES) return
  const listed = await env.FILES.list({ prefix: "imports/", limit: 1000 })
  const ids = [...new Set(listed.objects.map((o) => o.key.split("/")[1]))].slice(0, 100)
  for (const id of ids) {
    const row = await env.DB.prepare("SELECT state FROM source_imports WHERE id = ?").bind(id).first<{ state: string }>()
    if (row?.state !== "pending") await env.FILES.delete(archiveKey(id))
  }
}

type Work = Pick<SourceImport, "stage" | "upload_id" | "package_key">

/** Aborts the import's unfinished upload and deletes its working copy and its unpublished package. */
async function discardWork(env: Env, id: string, work: Work, keepPackage = false): Promise<void> {
  if (!env.FILES) return
  if (work.upload_id) await env.FILES.resumeMultipartUpload(work.stage === "repack" ? work.package_key : archiveKey(id), work.upload_id).abort().catch(() => {})
  await env.FILES.delete(work.package_key && !keepPackage ? [archiveKey(id), work.package_key] : archiveKey(id)).catch(() => {})
}

async function finish(env: Env, id: string, state: ImportState, detail: string, fileId: string | null = null): Promise<void> {
  const work = await env.DB.prepare("SELECT stage, upload_id, package_key FROM source_imports WHERE id = ?").bind(id).first<Work>()
  await env.DB.prepare("UPDATE source_imports SET state = ?, detail = ?, file_id = ?, finished_at = ?, stage = '', upload_id = '', package_key = '', parts = '[]', claimed_until = NULL WHERE id = ?")
    .bind(state, detail.slice(0, 500), fileId, Date.now(), id)
    .run()
  // A published package is the release's file: it stays.
  if (work) await discardWork(env, id, work, state === "imported")
}

/**
 * Records a tag to publish and starts publishing it in the background. A tag that was already published, skipped or
 * is in progress is left as it is, so repeated deliveries publish once; a failed one is tried again.
 */
export async function startImport(env: Env, ctx: ExecutionContext, source: ReleaseSource, tag: string, commit = "", now = Date.now()): Promise<SourceImport> {
  const ref = tag.trim().slice(0, 200)
  const version = ref.startsWith(source.tag_prefix) ? (versionFromTag(ref.slice(source.tag_prefix.length)) ?? "") : ""
  const inserted = await env.DB.prepare(
    "INSERT INTO source_imports (id, source_id, ref, commit_sha, version, state, started_at) VALUES (?, ?, ?, ?, ?, 'pending', ?) ON CONFLICT (source_id, ref) DO NOTHING RETURNING id",
  )
    .bind(newId("imp"), source.id, ref, commit, version, now)
    .first<{ id: string }>()
  let id = inserted?.id
  if (!id) {
    const existing = (await env.DB.prepare("SELECT * FROM source_imports WHERE source_id = ? AND ref = ?").bind(source.id, ref).first<SourceImport>())!
    if (existing.state !== "failed" && !timedOut(existing, now)) return existing
    await discardWork(env, existing.id, existing)
    await env.DB.prepare(
      `UPDATE source_imports SET state = 'pending', detail = '', commit_sha = ?, version = ?, file_id = NULL, started_at = ?, finished_at = NULL,
       stage = '', upload_id = '', package_key = '', parts = '[]', archive_size = NULL, attempts = 0, claimed_until = NULL WHERE id = ?`,
    )
      .bind(commit || existing.commit_sha, version, now, existing.id)
      .run()
    id = existing.id
  }
  if (!version) {
    const example = `${source.tag_prefix}v1.4.0`
    await finish(env, id, "skipped", `"${ref}" is not a version tag of this track, so nothing was published. Name its release tags like ${example}.`)
  } else {
    const importId = id
    ctx.waitUntil(runImport(env, importId).catch((error) => console.error("Release import failed:", error)))
  }
  return (await env.DB.prepare("SELECT * FROM source_imports WHERE id = ?").bind(id).first<SourceImport>())!
}

/** Tries an import again: after a failure, or after a skip once the reason was fixed (for example a deleted release). */
export async function retryImport(env: Env, ctx: ExecutionContext, source: ReleaseSource, row: SourceImport, now = Date.now()): Promise<SourceImport | Failure> {
  if (row.state === "pending" && !timedOut(row, now)) return { error: "This import is still in progress.", status: 409 }
  if (row.state === "imported")
    return {
      error: "This tag is already published. Delete the release first to publish it again.",
      status: 409,
    }
  await env.DB.prepare("UPDATE source_imports SET state = 'failed' WHERE id = ?").bind(row.id).run()
  return startImport(env, ctx, source, row.ref, row.commit_sha, now)
}

/**
 * Resumes an import whose Worker stopped before it finished. Run by the cron every 10 minutes, one import per run so
 * that each gets the run's whole CPU allowance. A run that has just started is left alone until its claim expires.
 */
export async function resumeImports(env: Env, now = Date.now()): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT id FROM source_imports WHERE state = 'pending' AND (claimed_until IS NULL OR claimed_until < ?) AND started_at < ? ORDER BY started_at LIMIT 1",
  )
    .bind(now, now - IMPORT_CLAIM_MS)
    .first<{ id: string }>()
  if (row) await runImport(env, row.id, now)
}

/** How a run ends. A step returns either the import as saved after it, or an outcome. */
type Outcome = { result: ImportState; detail: string; fileId?: string }
const failed = (detail: string): Outcome => ({ result: "failed", detail })

/**
 * Downloads, repacks and publishes one tag, in three steps that each record their progress: download the archive
 * into R2, repack it part by part into a second object, publish that object. A run continues from the last step
 * completed, so an import stopped by a Workers limit is resumed by the cron instead of starting over. Each step works
 * in blocks of 10 MiB (storage.server.ts), which keeps memory and CPU low whatever the size of the repository.
 * Records the outcome on the import; never throws.
 */
export async function runImport(env: Env, importId: string, now = Date.now()): Promise<void> {
  // Claim the import: a second run (a redelivery, the cron) leaves it alone while this one holds it.
  const claimed = await env.DB.prepare(
    "UPDATE source_imports SET attempts = attempts + 1, claimed_until = ? WHERE id = ? AND state = 'pending' AND (claimed_until IS NULL OR claimed_until < ?) RETURNING *",
  )
    .bind(now + IMPORT_CLAIM_MS, importId, now)
    .first<SourceImport>()
  if (!claimed) return
  let row = claimed
  let outcome: Outcome
  try {
    outcome = await (async (): Promise<Outcome> => {
      if (row.attempts > IMPORT_MAX_ATTEMPTS) return failed(STOPPED_DETAIL)
      const source = await getSourceById(env, row.source_id)
      if (!source) return failed("The repository was disconnected.")
      const target = await publishTarget(env, source, row)
      if ("result" in target) return target
      if (row.stage === "") {
        const downloaded = await download(env, source, row)
        if ("result" in downloaded) return downloaded
        row = downloaded
      }
      let sha256: string | null = null
      if (row.stage === "repack") {
        const repacked = await repack(env, source, row, target.owner)
        if ("result" in repacked) return repacked
        row = repacked.row
        sha256 = repacked.sha256
      }
      return publish(env, source, row, target, sha256)
    })()
  } catch (error) {
    outcome = failed(error instanceof ZipError ? error.message : `Unexpected error: ${error instanceof Error ? error.message : String(error)}`)
  }
  await finish(env, row.id, outcome.result, outcome.detail, outcome.fileId ?? null)
}

/**
 * Saves the import's state and holds it for another claim period. `advanced` marks completed work (a step or a part),
 * which starts the attempts again from zero; bookkeeping before the work does not, or a run that always stops at the
 * same point would be retried forever.
 */
async function save(env: Env, id: string, detail: string, changes: Record<string, string | number | null>, advanced: boolean): Promise<SourceImport> {
  const columns = Object.keys(changes)
  return (await env.DB.prepare(
    `UPDATE source_imports SET ${columns.map((c) => `${c} = ?, `).join("")}detail = ?, ${advanced ? "attempts = 0, " : ""}claimed_until = ? WHERE id = ? RETURNING *`,
  )
    .bind(...columns.map((c) => changes[c]), detail, Date.now() + IMPORT_CLAIM_MS, id)
    .first<SourceImport>())!
}

/** Where the tag is published, checked on every run: the owner or track may have been removed meanwhile. */
async function publishTarget(env: Env, source: ReleaseSource, row: SourceImport): Promise<{ owner: FileOwner; track: ReleaseTrack } | Outcome> {
  const owner = await ownerOf(env, source)
  if (!owner) return failed("The app or licence of this source no longer exists.")
  const track = source.track_id ? await getTrack(env, owner, source.track_id) : null
  if (!track) return failed("This repository is not connected to a track. Connect it to a track again.")
  // Versions are unique within a track: another track (a final build, say) may publish the same number.
  const duplicate = await releaseWithVersion(env, track.id, row.version)
  if (duplicate) {
    return { result: "skipped", detail: `Version ${row.version} is already published in "${track.name}" (${duplicate.name}). Withdraw or delete it, then retry, to publish this tag instead.` }
  }
  return { owner, track }
}

/** Step 1: streams the repository archive into R2. Not resumable midway (the provider's download cannot be), so a stopped download starts again. */
async function download(env: Env, source: ReleaseSource, row: SourceImport): Promise<SourceImport | Outcome> {
  await discardWork(env, row.id, row)
  const provider = PROVIDER_IMPLEMENTATIONS[source.provider]
  const access = await credentials(env, source)
  if ("error" in access) return failed(access.error)
  let commit = row.commit_sha
  if (!commit) {
    const resolved = await provider.resolveCommit(access, row.ref)
    if ("error" in resolved) return failed(resolved.error)
    commit = resolved.commit
  }
  row = await save(env, row.id, "Downloading the repository archive.", { commit_sha: commit, upload_id: "" }, false)
  const archive = await provider.downloadArchive(access, commit, MAX_FILE_BYTES)
  if ("error" in archive) return failed(archive.error)
  const size = await uploadStream(env, archiveKey(row.id), archive.body, MAX_FILE_BYTES, async (uploadId) => {
    await env.DB.prepare("UPDATE source_imports SET upload_id = ? WHERE id = ?").bind(uploadId, row.id).run()
  })
  if (size === null) return failed(`The repository archive exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB file limit.`)
  return save(env, row.id, "Repacking the archive.", { stage: "repack", archive_size: size, upload_id: "", parts: "[]" }, true)
}

/**
 * Step 2: writes the package (the archive with its top folder renamed) directly as the release's file, a multipart
 * upload of one part per loop turn. Each part is recorded, so a stopped run continues with the next one. The package
 * is hashed as it is written; a run that resumes midway leaves the hash to step 3.
 */
async function repack(env: Env, source: ReleaseSource, row: SourceImport, owner: FileOwner): Promise<{ row: SourceImport; sha256: string | null } | Outcome> {
  const archive = archiveKey(row.id)
  const size = row.archive_size ?? 0
  const tailOffset = size - tailLength(size)
  const tail = await readRange(env, archive, tailOffset, size - tailOffset)
  const directory = readDirectory(tail, tailOffset)
  const central = directory.centralOffset >= tailOffset ? tail.subarray(directory.centralOffset - tailOffset) : await readRange(env, archive, directory.centralOffset, size - directory.centralOffset)
  const plan = planRepack(central, directory, source.package_folder)
  if (plan.size > MAX_FILE_BYTES) return failed(`The package exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB file limit.`)

  const block = blockSize()
  const total = Math.ceil(plan.size / block)
  let parts = JSON.parse(row.parts) as R2UploadedPart[]
  let upload: R2MultipartUpload
  if (row.upload_id) {
    upload = env.FILES.resumeMultipartUpload(row.package_key, row.upload_id)
  } else {
    const fileId = newId("fil")
    const key = fileKey(owner, fileId)
    upload = await env.FILES.createMultipartUpload(key, { httpMetadata: { contentType: "application/zip" } })
    parts = []
    row = await save(env, row.id, row.detail, { file_id: fileId, package_key: key, upload_id: upload.uploadId, parts: "[]" }, false)
  }
  const hasher = parts.length === 0 ? sha256Hasher() : null
  // The original bytes of each part are read while the previous part uploads.
  const read = (n: number) => {
    const start = n * block
    const end = Math.min(plan.size, start + block)
    const range = sourceRange(plan, start, end)
    const bytes = range ? readRange(env, archive, range.from, range.to - range.from) : Promise.resolve(new Uint8Array(0))
    bytes.catch(() => {})
    return { start, end, from: range?.from ?? 0, bytes }
  }
  let next = parts.length < total ? read(parts.length) : null
  for (let n = parts.length; n < total; n++) {
    const current = next!
    next = n + 1 < total ? read(n + 1) : null
    const out = new Uint8Array(current.end - current.start)
    fillPart(plan, current.start, out, await current.bytes, current.from)
    await hasher?.update(out)
    parts.push(await upload.uploadPart(n + 1, out))
    row = await save(env, row.id, `Repacking the archive: part ${n + 1} of ${total} written.`, { parts: JSON.stringify(parts) }, true)
  }
  await upload.complete(parts)
  row = await save(env, row.id, "Publishing the package.", { stage: "store", upload_id: "" }, true)
  await env.FILES.delete(archive)
  return { row, sha256: hasher ? await hasher.digest() : null }
}

/**
 * The channel a tag is published on: the channel of its source. A stable source that follows no branch keeps the rule
 * from before channels: a version with a suffix (v2.0.0-beta.1) goes to beta, when the track has a beta channel.
 */
export function channelForImport(source: Pick<ReleaseSource, "channel" | "branch">, version: string, channels: ChannelDef[]): string {
  if (source.channel === STABLE && !source.branch) {
    const legacy = channelForVersion(version)
    return channels.some((c) => c.key === legacy) ? legacy : STABLE
  }
  return source.channel
}

/** Step 3: records the package as a release of the track. */
async function publish(env: Env, source: ReleaseSource, row: SourceImport, { owner, track }: { owner: FileOwner; track: ReleaseTrack }, sha256: string | null): Promise<Outcome> {
  const object = row.package_key ? await env.FILES.head(row.package_key) : null
  if (!object || !row.file_id) return failed("The repacked package is missing from storage. Retry the import.")
  const name = packageFileName(source.package_folder, row.version)
  const stored = await storeFile(env, owner, {
    name,
    version: row.version,
    channel: channelForImport(source, row.version, readTrackChannels(track.channels)),
    track: track.id,
    notes: `Published from ${PROVIDER_INFO[source.provider].host}/${source.repository}, tag ${row.ref}, commit ${row.commit_sha.slice(0, 7)}.`,
    contentType: "application/zip",
    size: object.size,
    body: null,
    stored: { id: row.file_id, key: row.package_key, sha256: sha256 ?? (await hashObject(env, row.package_key, object.size)) },
  })
  if ("error" in stored) return failed(stored.error)
  return { result: "imported", detail: `Published ${name}.`, fileId: stored.file.id }
}

/** What the provider is called with: the source's own token, or a short-lived token of the GitHub App. */
async function credentials(env: Env, source: ReleaseSource): Promise<ProviderSource | Failure> {
  if (!source.installation_id) return source
  const app = await getGitHubApp(env)
  if (!app) return { error: "The GitHub App is no longer connected. Connect GitHub again under Integrations, or switch this repository to an access token.", status: 502 }
  const token = await installationToken(app, source.installation_id)
  return "error" in token ? token : { ...source, token: token.token }
}

/**
 * The source a tag publishes through, among the sources of one app or licence connected to the repository:
 *   1. the tag prefix: the sources whose prefix the tag matches most specifically (they are all in one track);
 *   2. the branch: a source that follows a branch takes only tags whose commit is in that branch, one that follows
 *      none takes any tag;
 *   3. when several remain (a commit in two branches, for example right after a merge): the source whose branch the
 *      delivery names, then a source that follows a branch, then the track's first channel (stable).
 * Returns why nothing was chosen otherwise.
 */
export async function selectSource(env: Env, sources: ReleaseSource[], event: Extract<WebhookEvent, { kind: "tag" }>): Promise<{ source: ReleaseSource } | { ignored: string }> {
  const prefix = prefixForTag(event.tag, sources.map((s) => s.tag_prefix))
  if (prefix === null) return { ignored: "No track of this repository takes tags with this name." }
  const candidates = sources.filter((s) => s.tag_prefix === prefix)
  if (candidates.length === 1 && !candidates[0].branch) return { source: candidates[0] }
  const accepted: ReleaseSource[] = []
  for (const source of candidates) {
    if (!source.branch) {
      accepted.push(source)
      continue
    }
    if (event.branch === source.branch) {
      accepted.push(source)
      continue
    }
    const access = await credentials(env, source)
    if ("error" in access) return { ignored: `Could not check the branch ${source.branch}: ${access.error}` }
    const result = await PROVIDER_IMPLEMENTATIONS[source.provider].branchContains(access, source.branch, event.commit || event.tag)
    if ("error" in result) return { ignored: `Could not check the branch ${source.branch}: ${result.error}` }
    if (result.contains) accepted.push(source)
  }
  if (accepted.length === 0) return { ignored: `The tag is not on a branch a channel follows (${candidates.map((s) => s.branch).filter(Boolean).join(", ")}).` }
  const track = candidates[0].track_id ? await env.DB.prepare("SELECT channels FROM release_tracks WHERE id = ?").bind(candidates[0].track_id).first<{ channels: string | null }>() : null
  const order = readTrackChannels(track?.channels ?? null).map((c) => c.key)
  const rank = (s: ReleaseSource) => [s.branch !== "" && s.branch === event.branch ? 0 : 1, s.branch ? 0 : 1, order.indexOf(s.channel) === -1 ? order.length : order.indexOf(s.channel)]
  accepted.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })
  return { source: accepted[0] }
}

/** Webhook deliveries are small; a tag push carries no file contents. */
const MAX_WEBHOOK_BYTES = 1024 * 1024

/**
 * Receives a provider's webhook: POST /hooks/<provider>/<source id>. Authenticated by the delivery's signature, made
 * with the source's webhook secret. Answers quickly and publishes in the background.
 */
export async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext, providerKey: string, sourceId: string): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST." }, { status: 405, headers: { allow: "POST" } })
  const source = await getSourceById(env, sourceId)
  if (!source || source.provider !== providerKey) return json({ error: "No release source matches this address." }, { status: 404 })
  const body = await readTextUpTo(request, MAX_WEBHOOK_BYTES)
  if (body === null) return json({ error: "The delivery exceeds 1 MB." }, { status: 413 })

  const event = await PROVIDER_IMPLEMENTATIONS[source.provider].readWebhook(request, body, source)
  if ("error" in event) return json({ error: (event as ProviderFailure).error }, { status: event.status })
  await env.DB.prepare("UPDATE release_sources SET last_delivery_at = ? WHERE id = ?").bind(Date.now(), source.id).run()

  if (event.kind === "ping")
    return json({
      ok: true,
      message: "Webhook received. Push a tag to publish a release.",
    })
  if (event.kind === "ignored") return json({ ok: true, ignored: event.reason })
  if (source.enabled !== 1) return json({ ok: true, ignored: "The source is paused in Warden." })
  // The tag goes to one source of this repository: by tag prefix, then by branch (selectSource, as for the GitHub App).
  const siblings = (await env.DB.prepare("SELECT * FROM release_sources WHERE repository = ? AND provider = ? AND app_id IS ? AND license_id IS ?")
    .bind(source.repository, source.provider, source.app_id, source.license_id)
    .all<ReleaseSource>()).results
  const selected = await selectSource(env, siblings, event)
  if ("ignored" in selected) return json({ ok: true, ignored: selected.ignored })
  if (selected.source.id !== source.id) return json({ ok: true, ignored: `This tag is published by another channel or track of this repository (${selected.source.channel}${selected.source.branch ? `, branch ${selected.source.branch}` : ""}).` })
  const row = await startImport(env, ctx, source, event.tag, event.commit)
  return json(
    {
      ok: true,
      import: {
        id: row.id,
        tag: row.ref,
        version: row.version,
        state: row.state,
        detail: row.detail,
      },
    },
    { status: 202 },
  )
}

/**
 * Handles the source intents of an app or licence page. Returns `{ ok: true }` or `{ error }` for the page's
 * fetcher, or null when the intent is not a source intent.
 */
export async function applySourceForm(env: Env, ctx: ExecutionContext, owner: FileOwner, form: FormData): Promise<{ ok: true } | { error: string } | null> {
  const intent = String(form.get("intent"))
  if (!["save-source", "delete-source", "regenerate-source-secret", "import-tag", "retry-import"].includes(intent)) return null
  const track = await getTrack(env, owner, String(form.get("trackId") ?? ""))
  if (!track) return { error: "That track no longer exists. Reload the page." }
  const channel = String(form.get("channel") ?? "") || STABLE
  if (intent === "save-source") {
    const text = (name: string) => (form.has(name) ? String(form.get(name)) : undefined)
    const flag = (name: string) => (form.has(name) ? form.get(name) === "true" : undefined)
    const saved = await saveSource(env, owner, track, {
      connection: text("connection"),
      provider: text("provider"),
      repository: text("repository"),
      trigger: text("trigger"),
      package_folder: text("package_folder"),
      tag_prefix: text("tag_prefix"),
      branch: text("branch"),
      // An empty token field keeps the current token; removing it is a separate checkbox.
      token: form.get("remove_token") === "true" ? "" : text("token") || undefined,
      enabled: flag("enabled"),
    }, Date.now(), channel)
    return "error" in saved ? { error: saved.error } : { ok: true }
  }
  const source = await getSourceForTrack(env, owner, track.id, channel)
  if (!source) return { error: "No repository is connected to this channel. Reload the page." }
  if (intent === "delete-source") await deleteSource(env, source)
  else if (intent === "regenerate-source-secret") await regenerateWebhookSecret(env, source)
  else if (intent === "import-tag") {
    const tag = String(form.get("tag") ?? "").trim()
    if (!tag) return { error: `Enter the tag to publish, for example ${source.tag_prefix}v1.4.0.` }
    if (!tag.startsWith(source.tag_prefix)) return { error: `Tags of this track start with "${source.tag_prefix}", for example ${source.tag_prefix}v1.4.0.` }
    const row = await startImport(env, ctx, source, tag)
    if (row.state === "imported") return { error: `${row.ref} is already published.` }
  } else {
    const row = await getImport(env, source.id, String(form.get("importId")))
    if (!row) return { error: "That import no longer exists. Reload the page." }
    const retried = await retryImport(env, ctx, source, row)
    if ("error" in retried) return { error: retried.error }
  }
  return { ok: true }
}

/**
 * Receives the GitHub App's webhook: POST /hooks/github-app, one address for every repository the app can access.
 * Signed with the app's webhook secret. A tag push publishes a release for every enabled source connected to that
 * repository through the app.
 */
export async function handleAppWebhook(request: Request, env: Env, ctx: ExecutionContext, now = Date.now()): Promise<Response> {
  if (request.method !== "POST") return json({ error: "Use POST." }, { status: 405, headers: { allow: "POST" } })
  const app = await getGitHubApp(env)
  if (!app) return json({ error: "No GitHub App is connected to this Warden." }, { status: 404 })
  const body = await readTextUpTo(request, MAX_WEBHOOK_BYTES)
  if (body === null) return json({ error: "The delivery exceeds 1 MB." }, { status: 413 })

  const event = await PROVIDER_IMPLEMENTATIONS.github.readWebhook(request, body, { repository: "", token: "", webhook_secret: app.webhook_secret })
  if ("error" in event) return json({ error: event.error }, { status: event.status })
  await env.DB.prepare("UPDATE settings SET value = json_set(value, '$.last_delivery_at', ?) WHERE key = 'github_app'").bind(now).run()
  if (event.kind === "ping") return json({ ok: true, message: "Webhook received." })
  if (event.kind === "ignored") return json({ ok: true, ignored: event.reason })
  if (event.repository_id === null) return json({ ok: true, ignored: "The delivery names no repository." })

  const sources = (
    await env.DB.prepare("SELECT * FROM release_sources WHERE provider = 'github' AND installation_id IS NOT NULL AND repository_id = ?").bind(event.repository_id).all<ReleaseSource>()
  ).results
  if (sources.length === 0) return json({ ok: true, ignored: "No app or licence in Warden is connected to this repository." })
  // Within one app or licence, a tag goes to one source: by tag prefix, then by branch (selectSource).
  const ownerKey = (s: ReleaseSource) => s.app_id ?? `l:${s.license_id}`
  const chosen = new Set<string>()
  const ignored: string[] = []
  for (const key of new Set(sources.map(ownerKey))) {
    const selected = await selectSource(env, sources.filter((s) => ownerKey(s) === key), { ...event, repository: event.repository })
    if ("source" in selected) chosen.add(selected.source.id)
    else ignored.push(selected.ignored)
  }
  const imports = []
  for (const source of sources) {
    if (!chosen.has(source.id)) continue
    // Follow a renamed repository, so the dashboard shows its current name.
    await env.DB.prepare("UPDATE release_sources SET last_delivery_at = ?, repository = CASE WHEN ? = '' THEN repository ELSE ? END WHERE id = ?")
      .bind(now, event.repository, event.repository, source.id)
      .run()
    if (source.enabled !== 1) continue
    const row = await startImport(env, ctx, { ...source, repository: event.repository || source.repository }, event.tag, event.commit, now)
    imports.push({ source: source.id, id: row.id, tag: row.ref, version: row.version, state: row.state })
  }
  return json({ ok: true, imports, ...(ignored.length ? { ignored: ignored.join(" ") } : {}) }, { status: imports.length > 0 ? 202 : 200 })
}

/**
 * The tracks of an app or licence for its page: each with its channels, and for each channel its repository (without
 * secrets) and its latest imports.
 */
export async function trackPanels(env: Env, owner: FileOwner, origin: string, importsPerSource = 5) {
  const [tracks, sources] = await Promise.all([listTracks(env, owner), listSources(env, owner)])
  return Promise.all(
    tracks.map(async (track) => {
      const view = trackView(track)
      const channels = await Promise.all(
        view.channels.map(async (channel) => {
          const source = sources.find((s) => s.track_id === track.id && s.channel === channel.key) ?? null
          const [shown, imports] = source ? await Promise.all([publicSource(env, source, origin), listImports(env, source.id, importsPerSource)]) : [null, []]
          return { channel: channel.key, source: shown, imports }
        })
      )
      return { track: view, channels }
    })
  )
}
