import { useEffect, useRef, useState } from "react"
import { Link, useFetcher, useRevalidator } from "react-router"
import { Check, Copy, ExternalLink, GitBranch, MoreHorizontal, Pause, Play, RefreshCw, Settings2, Tag, Unplug, Webhook } from "lucide-react"
import { ConfirmAction } from "#/components/confirm-action"
import { FieldLabel, HelpTip } from "#/components/help-tip"
import { Ago } from "#/components/time"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu"
import { Input } from "#/components/ui/input"
import { NativeSelect } from "#/components/ui/native-select"
import type { AppRepository } from "#/lib/github-app"
import { IMPORT_STATE_LABELS, packageFileName, packageFolderError, PROVIDER_INFO, PROVIDERS, TRIGGER_INFO, TRIGGERS, type ImportState, type ProviderKey, type TriggerKey } from "#/lib/sources"

/** The connected repository, as the loader sends it (without the access token). */
export type SourceView = {
  id: string
  provider: ProviderKey
  repository: string
  /** app: through the install's GitHub App; token: an optional access token and a webhook of its own. */
  connection: "app" | "token"
  trigger: TriggerKey
  package_folder: string
  /** The track this repository publishes into, and the prefix its tags start with. */
  track_id: string | null
  tag_prefix: string
  /** The channel of the track it publishes into, and the branch whose tags it takes ("" for any branch). */
  channel: string
  branch: string
  status_keys: string[]
  check_domain: boolean
  has_token: boolean
  enabled: boolean
  webhook_url: string
  webhook_secret: string
  last_delivery_at: number | null
}

export type ImportView = {
  id: string
  ref: string
  version: string
  commit_sha: string
  state: ImportState
  detail: string
  started_at: number
  finished_at: number | null
}

type ActionResult = { ok?: true; error?: string }

const STATE_BADGE: Record<ImportState, "success" | "secondary" | "warning" | "destructive" | "info"> = {
  pending: "info",
  imported: "success",
  skipped: "secondary",
  failed: "destructive",
}

const PREFIX_HELP =
  "Tags of this track start with this text. Leave it empty for tags like v1.4.0. To publish two tracks from one repository, give one a prefix: final- takes final-v1.4.0, while v1.4.0 goes to the track without prefix."

const BRANCH_HELP =
  "Only tags made on this branch publish into this channel, for example main for Stable and beta for Beta. Two channels can follow the same repository this way. Leave it empty to take tags made on any branch; a Stable channel without a branch also sends tags with a suffix, such as v2.0.0-beta.1, to Beta."

const FOLDER_HELP =
  "The top-level folder inside the published zip. Archives from GitHub are wrapped in a folder named after the commit; Warden renames it to this name, so every release installs into the same folder. For a WordPress theme or plugin, use its slug."

/** A channel of a track, as TrackSource needs it. */
export type SourceChannel = { key: string; name: string }

/**
 * The repository a channel of a release track follows: its tags are downloaded, repacked and published into the track,
 * on that channel. Posts its intents, with the track's id and the channel, to the current route (save-source,
 * delete-source, regenerate-source-secret, import-tag, retry-import).
 */
export function TrackSource({ track, channel, source, imports, githubApp }: { track: { id: string; name: string }; channel: SourceChannel; source: SourceView | null; imports: ImportView[]; githubApp: boolean }) {
  const [editing, setEditing] = useState(false)
  const [setup, setSetup] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const action = useFetcher<ActionResult>()
  const revalidator = useRevalidator()

  // Open the webhook instructions right after a repository is connected with a token (the GitHub App needs none).
  const previous = useRef(source?.id ?? null)
  useEffect(() => {
    if (source && previous.current === null) {
      setEditing(false)
      if (source.connection === "token") setSetup(true)
    }
    previous.current = source?.id ?? null
  }, [source?.id])

  // Refresh while an import runs in the background.
  const running = imports.some((i) => i.state === "pending")
  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => revalidator.state === "idle" && revalidator.revalidate(), 3000)
    return () => clearInterval(timer)
  }, [running, revalidator])

  if (!source) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <GitBranch className="size-4" /> <span className="font-medium text-foreground">{channel.name}</span> No repository: releases are uploaded by hand.
        </span>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          <GitBranch /> Connect repository
        </Button>
        <SourceDialog open={editing} onOpenChange={setEditing} trackId={track.id} channel={channel} source={null} githubApp={githubApp} />
      </div>
    )
  }

  const provider = PROVIDER_INFO[source.provider]
  const repoUrl = `https://${provider.host}/${source.repository}`
  const toggle = () => action.submit({ intent: "save-source", trackId: track.id, channel: channel.key, enabled: String(!source.enabled) }, { method: "post" })
  const example = `${source.tag_prefix}v1.4.0`

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <GitBranch className="size-4 text-muted-foreground" />
            <span className="font-medium">{channel.name}</span>
            <a href={repoUrl} target="_blank" rel="noreferrer" className="font-mono font-medium break-all underline-offset-2 hover:underline">
              {source.repository}
            </a>
            <Badge variant="outline">{source.connection === "app" ? `${provider.label} App` : provider.label}</Badge>
            {!source.enabled && <Badge variant="warning">Paused</Badge>}
            {source.has_token && <Badge variant="secondary">Access token saved</Badge>}
            <Badge variant="secondary" className="font-mono">
              {source.branch ? `branch ${source.branch}` : "any branch"}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Tags like <span className="font-mono text-foreground">{example}</span> publish <span className="font-mono text-foreground">{packageFileName(source.package_folder, "1.4.0")}</span>
            {". "}
            {source.last_delivery_at ? (
              <>
                Last webhook delivery <Ago ts={source.last_delivery_at} />.
              </>
            ) : source.connection === "app" ? (
              "Push a tag to publish a release."
            ) : (
              <span className="text-amber-700 dark:text-amber-400">No webhook delivery received yet: add the webhook in GitHub.</span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setPublishing(true)} disabled={!source.enabled}>
            <Tag /> Publish a tag
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" className="size-8" aria-label={`Repository actions for ${track.name}, ${channel.name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              {source.connection === "token" && (
                <DropdownMenuItem onClick={() => setSetup(true)}>
                  <Webhook /> Webhook setup
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <Settings2 /> Repository settings
              </DropdownMenuItem>
              <DropdownMenuItem onClick={toggle}>
                {source.enabled ? <Pause /> : <Play />} {source.enabled ? "Pause publishing" : "Resume publishing"}
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <a href={repoUrl} target="_blank" rel="noreferrer">
                  <ExternalLink /> Open on {provider.label}
                </a>
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => setDisconnecting(true)}>
                <Unplug /> Disconnect repository
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {action.data?.error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{action.data.error}</div>}

      {imports.length > 0 && (
        <ul className="divide-y rounded-md border">
          {imports.map((row) => (
            <li key={row.id} className="grid gap-x-3 gap-y-1 px-3 py-2 text-sm sm:grid-cols-[minmax(6rem,auto)_minmax(0,1fr)_auto] sm:items-center">
              <div className="flex items-center gap-2">
                <span className="font-mono font-medium">{row.ref}</span>
                <Badge variant={STATE_BADGE[row.state]}>{IMPORT_STATE_LABELS[row.state]}</Badge>
              </div>
              <p className="min-w-0 text-xs text-muted-foreground">
                {row.detail || (row.state === "pending" ? "Downloading and publishing…" : "")} {row.commit_sha && <span className="font-mono">({row.commit_sha.slice(0, 7)})</span>}
              </p>
              <div className="flex items-center gap-2 text-xs whitespace-nowrap text-muted-foreground sm:justify-end">
                <Ago ts={row.finished_at ?? row.started_at} />
                {(row.state === "failed" || row.state === "skipped") && (
                  <Button variant="ghost" size="sm" className="h-7" disabled={action.state !== "idle"} onClick={() => action.submit({ intent: "retry-import", trackId: track.id, channel: channel.key, importId: row.id }, { method: "post" })}>
                    <RefreshCw /> Retry
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <SourceDialog open={editing} onOpenChange={setEditing} trackId={track.id} channel={channel} source={source} githubApp={githubApp} />
      <WebhookDialog open={setup} onOpenChange={setSetup} trackId={track.id} channel={channel.key} source={source} />
      <PublishTagDialog open={publishing} onOpenChange={setPublishing} trackId={track.id} channel={channel.key} prefix={source.tag_prefix} />
      <ConfirmAction
        intent="delete-source"
        fields={{ trackId: track.id, channel: channel.key }}
        open={disconnecting}
        onOpenChange={setDisconnecting}
        title={`Disconnect ${source.repository} from "${track.name}", ${channel.name}?`}
        description={
          source.connection === "app"
            ? `New tags are no longer published on ${channel.name}. Releases already published stay available.`
            : `New tags are no longer published on ${channel.name}. Releases already published stay available. Remove the webhook in GitHub as well.`
        }
        confirm="Disconnect"
      />
    </div>
  )
}

function SourceDialog({
  open,
  onOpenChange,
  trackId,
  channel,
  source,
  githubApp,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  trackId: string
  channel: SourceChannel
  source: SourceView | null
  githubApp: boolean
}) {
  const save = useFetcher<ActionResult>()
  const repos = useFetcher<{ repositories?: AppRepository[]; error?: string }>()
  const [connection, setConnection] = useState<"app" | "token">("token")
  const [filter, setFilter] = useState("")
  const [provider, setProvider] = useState<ProviderKey>("github")
  const [repository, setRepository] = useState("")
  const [token, setToken] = useState("")
  const [removeToken, setRemoveToken] = useState(false)
  const [trigger, setTrigger] = useState<TriggerKey>("tag")
  const [folder, setFolder] = useState("")
  const [folderTouched, setFolderTouched] = useState(false)
  const [tagPrefix, setTagPrefix] = useState("")
  const [branch, setBranch] = useState("")
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (!open) return
    setConnection(source?.connection ?? (githubApp ? "app" : "token"))
    setFilter("")
    setProvider(source?.provider ?? "github")
    setRepository(source?.repository ?? "")
    setToken("")
    setRemoveToken(false)
    setTrigger(source?.trigger ?? "tag")
    setFolder(source?.package_folder ?? "")
    setFolderTouched(Boolean(source))
    setTagPrefix(source?.tag_prefix ?? "")
    setBranch(source?.branch ?? (channel.key === "stable" ? "" : channel.key))
    setSubmitted(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => {
    if (submitted && save.state === "idle" && save.data?.ok) onOpenChange(false)
  }, [submitted, save.state, save.data, onOpenChange])

  // The repositories the GitHub App can access, for app mode.
  useEffect(() => {
    // Loaded on every opening, so repositories added to the installation on GitHub appear without a page reload.
    if (open && connection === "app") repos.load("/integrations/github/repositories")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, connection])
  const available = repos.data?.repositories ?? []
  const needle = filter.trim().toLowerCase()
  const shown = available.filter((r) => !needle || r.full_name.toLowerCase().includes(needle) || r.full_name === repository)
  const accounts = [...new Set(shown.map((r) => r.account))]

  // Suggest the repository name as the folder until the folder is edited.
  const suggested =
    repository
      .trim()
      .replace(/\.git$/i, "")
      .replace(/\/+$/, "")
      .split("/")
      .pop() ?? ""
  const shownFolder = folderTouched ? folder : suggested
  const folderError = shownFolder ? packageFolderError(shownFolder) : null
  const busy = save.state !== "idle"
  const info = PROVIDER_INFO[provider]

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{source ? `Repository settings, ${channel.name}` : `Connect a repository to ${channel.name}`}</DialogTitle>
          <DialogDescription>
            Warden downloads the repository as a zip when a tag is pushed and publishes it as a release of this track, on the {channel.name} channel. Nothing is built: the repository is published as it
            is.
            {!githubApp && (
              <>
                {" "}
                <Link to="/integrations" className="text-foreground underline underline-offset-2">
                  Connect GitHub
                </Link>{" "}
                once to pick repositories from a list instead of using an access token.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="source-provider">Provider</FieldLabel>
              <NativeSelect id="source-provider" value={provider} onChange={(e) => setProvider(e.target.value as ProviderKey)} disabled={busy}>
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {PROVIDER_INFO[p].label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="source-repository">Repository</FieldLabel>
              {connection === "app" ? (
                <>
                  {available.length > 12 && (
                    <Input aria-label="Filter repositories" placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} disabled={busy} className="mb-1.5" />
                  )}
                  <NativeSelect
                    id="source-repository"
                    value={repository}
                    onChange={(e) => setRepository(e.target.value)}
                    disabled={busy || repos.state !== "idle" || Boolean(repos.data?.error)}
                    className="font-mono"
                  >
                    <option value="">{repos.state !== "idle" ? "Loading repositories…" : available.length === 0 ? "No repository available" : "Choose a repository"}</option>
                    {repository && !available.some((r) => r.full_name === repository) && <option value={repository}>{repository}</option>}
                    {accounts.map((account) => (
                      <optgroup key={account} label={account}>
                        {shown
                          .filter((r) => r.account === account)
                          .map((r) => (
                            <option key={r.id} value={r.full_name}>
                              {r.full_name}
                              {r.private ? " (private)" : ""}
                            </option>
                          ))}
                      </optgroup>
                    ))}
                  </NativeSelect>
                  {repos.data?.error ? (
                    <p className="text-xs text-destructive">{repos.data.error}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">
                      Repositories the GitHub App can access. Missing one? Add it to the installation from{" "}
                      <Link to="/integrations" className="text-foreground underline underline-offset-2">
                        Integrations
                      </Link>
                      .
                    </p>
                  )}
                </>
              ) : (
                <>
                  <Input id="source-repository" value={repository} onChange={(e) => setRepository(e.target.value)} placeholder="harbor-studio/harbor-theme" className="font-mono" disabled={busy} />
                  <p className="text-xs text-muted-foreground">As {info.repositoryHint}.</p>
                </>
              )}
            </div>
          </div>
          {githubApp && provider === "github" && (
            <button
              type="button"
              className="-mt-2 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setConnection(connection === "app" ? "token" : "app")}
              disabled={busy}
            >
              {connection === "app" ? "Connect with an access token and a webhook instead" : "Pick a repository through the GitHub App instead"}
            </button>
          )}
          {connection === "token" && (
            <div className="space-y-1.5">
              <FieldLabel htmlFor="source-token" help={info.tokenHelp}>
                Access token
              </FieldLabel>
              <Input
                id="source-token"
                type="password"
                autoComplete="off"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                placeholder={source?.has_token ? "Saved. Enter a new token to replace it." : "Only for a private repository"}
                disabled={busy || removeToken}
                className="font-mono"
              />
              {source?.has_token && (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-primary" checked={removeToken} onChange={(e) => setRemoveToken(e.target.checked)} disabled={busy} />
                  Remove the saved token
                </label>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <FieldLabel htmlFor="source-branch" help={BRANCH_HELP}>
              Branch
            </FieldLabel>
            <Input id="source-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="Any branch" className="font-mono" disabled={busy} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <FieldLabel htmlFor="source-trigger" help={TRIGGER_INFO[trigger].help}>
                Trigger
              </FieldLabel>
              <NativeSelect id="source-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as TriggerKey)} disabled={busy}>
                {TRIGGERS.map((t) => (
                  <option key={t} value={t}>
                    {TRIGGER_INFO[t].label}
                  </option>
                ))}
              </NativeSelect>
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="source-prefix" help={PREFIX_HELP}>
                Tag prefix
              </FieldLabel>
              <Input id="source-prefix" value={tagPrefix} onChange={(e) => setTagPrefix(e.target.value)} placeholder="None" className="font-mono" disabled={busy} />
            </div>
            <div className="space-y-1.5">
              <FieldLabel htmlFor="source-folder" help={FOLDER_HELP}>
                Package folder
              </FieldLabel>
              <Input
                id="source-folder"
                value={shownFolder}
                onChange={(e) => {
                  setFolderTouched(true)
                  setFolder(e.target.value)
                }}
                placeholder="harbor-theme"
                className="font-mono"
                aria-invalid={Boolean(folderError)}
                disabled={busy}
              />
            </div>
          </div>
          {folderError ? (
            <p className="-mt-2 text-xs text-destructive">{folderError}</p>
          ) : (
            shownFolder && (
              <p className="-mt-2 text-xs text-muted-foreground">
                Tag <span className="font-mono">{tagPrefix.trim()}v1.4.0</span> publishes <span className="font-mono">{packageFileName(shownFolder, "1.4.0")}</span>, containing{" "}
                <span className="font-mono">{shownFolder}/</span>, on {channel.name}
                {branch.trim() ? (
                  <>
                    {" "}
                    when the tag is made on <span className="font-mono">{branch.trim()}</span>
                  </>
                ) : null}
                .
              </p>
            )
          )}
          {submitted && save.state === "idle" && save.data?.error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{save.data.error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || !repository.trim() || !shownFolder || Boolean(folderError)}
            onClick={() => {
              setSubmitted(true)
              save.submit(
                {
                  intent: "save-source",
                  trackId,
                  channel: channel.key,
                  branch: branch.trim(),
                  connection,
                  provider,
                  repository: repository.trim(),
                  token: token.trim(),
                  remove_token: String(removeToken),
                  trigger,
                  package_folder: shownFolder.trim(),
                  tag_prefix: tagPrefix.trim(),
                },
                { method: "post" },
              )
            }}
          >
            {busy ? "Checking the repository…" : source ? "Save changes" : "Connect repository"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function CopyField({ label, value, secret = false, help }: { label: string; value: string; secret?: boolean; help?: string }) {
  const [copied, setCopied] = useState(false)
  const [shown, setShown] = useState(!secret)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {}
  }
  return (
    <div className="min-w-0 space-y-1">
      <FieldLabel help={help}>{label}</FieldLabel>
      <div className="flex min-w-0 items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/50 px-2.5 py-1.5 font-mono text-xs">{shown ? value : "•".repeat(24)}</code>
        {secret && (
          <Button type="button" variant="outline" size="sm" onClick={() => setShown(!shown)}>
            {shown ? "Hide" : "Show"}
          </Button>
        )}
        <Button type="button" variant="outline" size="sm" onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
          {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  )
}

function WebhookDialog({ open, onOpenChange, trackId, channel, source }: { open: boolean; onOpenChange: (open: boolean) => void; trackId: string; channel: string; source: SourceView }) {
  const regenerate = useFetcher<ActionResult>()
  const settingsUrl = `https://${PROVIDER_INFO[source.provider].host}/${source.repository}/settings/hooks/new`
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-x-hidden overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Webhook setup</DialogTitle>
          <DialogDescription>GitHub notifies Warden of new tags through a webhook. Add it once in the repository settings.</DialogDescription>
        </DialogHeader>
        <ol className="min-w-0 list-decimal space-y-4 pl-5 text-sm marker:text-muted-foreground">
          <li className="space-y-2">
            <p>
              Open{" "}
              <a href={settingsUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2">
                Settings, Webhooks, Add webhook
              </a>{" "}
              for <span className="font-mono break-all">{source.repository}</span>.
            </p>
          </li>
          <li className="space-y-3">
            <p>Enter these values:</p>
            <CopyField label="Payload URL" value={source.webhook_url} />
            <div className="space-y-1">
              <FieldLabel>Content type</FieldLabel>
              <p className="font-mono text-xs">application/json</p>
            </div>
            <CopyField label="Secret" value={source.webhook_secret} secret help="Warden rejects deliveries that are not signed with this secret." />
          </li>
          <li>
            Under <span className="font-medium">Which events</span>, keep <span className="font-medium">Just the push event</span>, then select <span className="font-medium">Add webhook</span>.
          </li>
          <li>GitHub sends a test delivery. This page then shows the time of the last delivery.</li>
        </ol>
        <DialogFooter className="sm:justify-between">
          <Button
            variant="ghost"
            disabled={regenerate.state !== "idle"}
            onClick={() => regenerate.submit({ intent: "regenerate-source-secret", trackId, channel }, { method: "post" })}
            title="Replaces the secret. Update it in GitHub afterwards."
          >
            <RefreshCw /> {regenerate.state !== "idle" ? "Generating…" : "Generate a new secret"}
          </Button>
          <Button onClick={() => onOpenChange(false)}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function PublishTagDialog({ open, onOpenChange, trackId, channel, prefix }: { open: boolean; onOpenChange: (open: boolean) => void; trackId: string; channel: string; prefix: string }) {
  const publish = useFetcher<ActionResult>()
  const [tag, setTag] = useState("")
  const [submitted, setSubmitted] = useState(false)
  useEffect(() => {
    if (!open) return
    setTag(prefix)
    setSubmitted(false)
  }, [open])
  useEffect(() => {
    if (submitted && publish.state === "idle" && publish.data?.ok) onOpenChange(false)
  }, [submitted, publish.state, publish.data, onOpenChange])
  const busy = publish.state !== "idle"
  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Publish a tag</DialogTitle>
          <DialogDescription>Publishes the repository as it is at an existing tag, for example a tag pushed before the webhook was added.</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (!tag.trim()) return
            setSubmitted(true)
            publish.submit({ intent: "import-tag", trackId, channel, tag: tag.trim() }, { method: "post" })
          }}
        >
          <FieldLabel htmlFor="publish-tag">Tag</FieldLabel>
          <Input id="publish-tag" value={tag} onChange={(e) => setTag(e.target.value)} placeholder={`${prefix}v1.4.0`} className="font-mono" autoFocus disabled={busy} />
          {submitted && publish.state === "idle" && publish.data?.error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{publish.data.error}</div>}
          <DialogFooter className="pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !tag.trim()}>
              <Tag /> {busy ? "Starting…" : "Publish"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
