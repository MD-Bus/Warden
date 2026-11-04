import { useEffect, useMemo, useRef, useState } from "react"
import { Link, useFetcher, useRevalidator } from "react-router"
import { Archive, ArchiveRestore, Copy, FileUp, FlaskConical, Layers, Link2, MoreHorizontal, Paperclip, Pencil, Plus, Trash2, Upload } from "lucide-react"
import { ConfirmAction } from "#/components/confirm-action"
import { TrackSource, type ImportView, type SourceView } from "#/components/release-source"
import { FieldLabel, HelpTip } from "#/components/help-tip"
import { StatusPicker } from "#/components/status-picker"
import { Ago } from "#/components/time"
import { Badge } from "#/components/ui/badge"
import { Button } from "#/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "#/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "#/components/ui/dropdown-menu"
import { Input } from "#/components/ui/input"
import { NativeSelect } from "#/components/ui/native-select"
import { Textarea } from "#/components/ui/textarea"
import { defaultReleaseStatuses, evaluateFileAccess, MAX_FILE_BYTES } from "#/lib/files"
import { CHANNELS, isValidVersion, latestRelease, MAX_CHANGELOG_LENGTH, MAX_KEEP_RELEASES, releasesToPrune, sortForDisplay, type Channel } from "#/lib/releases"
import { describeStatusKeys, splitStatusKeys, type StatusSet } from "#/lib/statuses"
import { statusConflicts, trackOverlaps } from "#/lib/tracks"
import { cn } from "#/lib/utils"

export type FileRow = {
  id: string
  name: string
  version: string
  channel: Channel
  changelog: string
  notes: string
  sha256: string
  withdrawn_at: number | null
  /** The track of a release; null for an attachment. */
  track_id: string | null
  statuses: string
  check_domain: number
  size: number
  uploaded_at: number
  download_count: number
  last_download_at: number | null
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

type LicenseState = { status: string; expires_at: number | null; domains: string }

/** Files shared by the licence's app. `statuses` are the app's statuses, which the files' release rules refer to. */
export type SharedFiles = { appName: string; appHref: string; files: FileRow[]; statuses: StatusSet; tracks: TrackView[] }

/** A release track as the pages send it: `statuses` are status keys. */
export type TrackView = { id: string; name: string; statuses: string[]; check_domain: boolean; keep_releases: number | null }

/** A track of the page's owner, with the repository connected to it. */
export type TrackPanel = { track: TrackView; source: SourceView | null; imports: ImportView[] }

type ActionResult = { ok?: true; error?: string }

const AVAILABILITY_HELP =
  "The file can be downloaded only while the licence has one of these statuses. Typical choices: the valid statuses for updates, only the paid-in-full status for a final release, or only the suspended status for a maintenance notice."
const DOMAIN_HELP = "When on, the download must include a domain (?domain=) the licence allows, within its site limit. Turn it off for files someone downloads by hand. Ignored when the licence has no allowed domains and no site limit."
const TRACK_HELP =
  "A track is what a set of licence statuses receives. Each status belongs to one track at most, so a licence is always offered the latest release of exactly one track: for example Updates for Active licences and a Final build for Completed ones. A track receives releases by upload, or from a connected repository."
const VERSION_HELP = "A version makes the file a release: sites that send their version with their check are offered it as an update. Leave it empty for an attachment such as a manual or a notice."
const CHANNEL_HELP = "Stable releases are offered to every site. Beta releases are offered only to sites that check with channel=beta."
const CHANGELOG_HELP = "Public. Returned to sites with the release, so they can show what changed before updating."

/** Suggests a version from a file name such as harbor-theme-1.4.0.zip or plugin_v2.1.zip. */
export function versionFromFileName(name: string): string {
  const match = name.replace(/\.(zip|tar\.gz|tgz|gz|rar|7z|pdf|exe|dmg|msi|jar)$/i, "").match(/(?:^|[^0-9A-Za-z])v?(\d+(?:\.\d+){1,3}(?:-[0-9A-Za-z.]+)?)$/)
  return match && isValidVersion(match[1]) ? match[1] : ""
}

type Row = { file: FileRow; shared: boolean; statuses: StatusSet }

export function FilesSection({
  description,
  uploadPath,
  downloadUrl,
  license = null,
  files,
  statuses: statusSet,
  shared = null,
  configured,
  ownerLabel,
  tracks,
  receiving = null,
  githubApp,
}: {
  description: string
  /** Where uploads are sent, for example /licenses/<id>/files. */
  uploadPath: string
  /** Builds the public download link of a file. Omit for app files, which have no single link. */
  downloadUrl?: (fileId: string) => string
  /** The licence the files are checked against, to show what it can download now. Omit for app files. */
  license?: LicenseState | null
  files: FileRow[]
  /** The statuses the files' release rules refer to. */
  statuses: StatusSet
  /** Read-only files that come from the licence's app. */
  shared?: SharedFiles | null
  configured: boolean
  /** "app" or "licence", for the texts. */
  ownerLabel: string
  /** The owner's release tracks, with their repositories. */
  tracks: TrackPanel[]
  /** On a licence page: the track that serves the licence's current status, if any. */
  receiving?: { trackId: string | null; status: string } | null
  githubApp: boolean
}) {
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<FileRow | null>(null)
  const [removing, setRemoving] = useState<FileRow | null>(null)
  const [trackDialog, setTrackDialog] = useState<TrackView | "new" | null>(null)
  const [deletingTrack, setDeletingTrack] = useState<TrackView | null>(null)
  const action = useFetcher<ActionResult>()
  const [copied, setCopied] = useState<string | null>(null)

  const rows: Row[] = useMemo(() => {
    const own = files.map((file) => ({ file, shared: false, statuses: statusSet }))
    const fromApp = (shared?.files ?? []).map((file) => ({ file, shared: true, statuses: shared!.statuses }))
    const all = [...own, ...fromApp]
    const order = sortForDisplay(all.map((r) => r.file))
    return order.map((f) => all.find((r) => r.file === f)!)
  }, [files, shared, statusSet])

  const availability = (row: Row) => {
    if (!license) return null
    if (row.file.withdrawn_at !== null) return false
    const rule = { statuses: splitStatusKeys(row.file.statuses, row.statuses), check_domain: row.file.check_domain === 1 }
    return evaluateFileAccess(license, rule, null, Date.now(), true, statusSet, row.statuses).allowed
  }
  // In each track, the release a site is offered: the newest stable one available (to this licence, on a licence page).
  const latestIn = (list: Row[]) => latestRelease(list.filter((r) => availability(r) !== false).map((r) => r.file))?.id ?? null
  const releases = rows.filter((r) => r.file.version.trim() !== "")
  const attachments = rows.filter((r) => r.file.version.trim() === "")
  const ownTracks = tracks.map((p) => p.track)
  const appTracks = shared?.tracks ?? []
  const knownTracks = new Set([...ownTracks, ...appTracks].map((t) => t.id))
  const withoutTrack = releases.filter((r) => !r.file.track_id || !knownTracks.has(r.file.track_id))
  const conflicts = statusConflicts(ownTracks.map((t) => ({ id: t.id, name: t.name, statuses: t.statuses.join(",") })))
  const ownKeys = new Set(ownTracks.flatMap((t) => t.statuses))

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
      setTimeout(() => setCopied(null), 1600)
    } catch {}
  }
  const setWithdrawn = (file: FileRow, withdrawn: boolean) => action.submit({ intent: "update-file", fileId: file.id, withdrawn: String(withdrawn) }, { method: "post" })

  if (!configured) {
    return (
      <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">
        File storage is not configured. Activate R2 in the Cloudflare dashboard and redeploy; the <code>FILES</code> bucket is created automatically.
      </p>
    )
  }

  /** Rows of files. Releases inside a track omit their rule (the track shows it); attachments show their own. */
  const table = (list: Row[], kind: "releases" | "attachments", latestId: string | null = null, framed = true) => (
    <ul className={cn("divide-y", framed && "rounded-lg border bg-card")}>
      {list.map((row) => {
        const f = row.file
        const available = availability(row)
        const withdrawn = f.withdrawn_at !== null
        const isLatest = latestId === f.id
        return (
          <li key={f.id} className={cn("grid gap-x-4 gap-y-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto]", withdrawn && "bg-muted/40")}>
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                {kind === "releases" ? (
                  <span className={cn("font-mono text-sm font-semibold", withdrawn && "text-muted-foreground line-through")}>{f.version}</span>
                ) : (
                  <Paperclip className="size-3.5 text-muted-foreground" />
                )}
                {isLatest && <Badge variant="success">Latest</Badge>}
                {f.channel === "beta" && (
                  <Badge variant="info">
                    <FlaskConical /> Beta
                  </Badge>
                )}
                {withdrawn && <Badge variant="secondary">Withdrawn</Badge>}
                {row.shared && kind === "attachments" && <Badge variant="outline">From {shared?.appName}</Badge>}
                {available !== null && !withdrawn && <Badge variant={available ? "success" : "secondary"}>{available ? "Available now" : "Not available now"}</Badge>}
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                <span className={cn("break-all", kind === "attachments" && "text-sm font-medium text-foreground")}>{f.name}</span>
                <span>{formatBytes(f.size)}</span>
                <span>
                  Uploaded <Ago ts={f.uploaded_at} />
                </span>
                <span>
                  {f.download_count} download{f.download_count === 1 ? "" : "s"}
                </span>
              </div>
              {kind === "attachments" && (
                <div className="text-xs text-muted-foreground">
                  Available when status is <span className="text-foreground">{describeStatusKeys(splitStatusKeys(f.statuses, row.statuses), row.statuses) || "no status"}</span>
                  {f.check_domain ? ", for allowed sites" : ", without a domain check"}
                </div>
              )}
              {f.changelog && <p className="line-clamp-2 max-w-prose text-sm whitespace-pre-line text-muted-foreground">{f.changelog}</p>}
            </div>
            <div className="flex items-start gap-1 sm:justify-end">
              {copied?.startsWith(f.id) && <span className="py-1.5 text-xs text-muted-foreground">Copied</span>}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for ${f.name}`}>
                    <MoreHorizontal className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  {!row.shared && (
                    <DropdownMenuItem onClick={() => setEditing(f)}>
                      <Pencil /> Edit
                    </DropdownMenuItem>
                  )}
                  {downloadUrl && (
                    <DropdownMenuItem onClick={() => copy(downloadUrl(f.id), `${f.id}-link`)}>
                      <Link2 /> Copy download link
                    </DropdownMenuItem>
                  )}
                  {f.sha256 && (
                    <DropdownMenuItem onClick={() => copy(f.sha256, `${f.id}-sha`)}>
                      <Copy /> Copy SHA-256 checksum
                    </DropdownMenuItem>
                  )}
                  {!row.shared && f.version && (
                    <DropdownMenuItem onClick={() => setWithdrawn(f, !withdrawn)}>
                      {withdrawn ? <ArchiveRestore /> : <Archive />} {withdrawn ? "Restore release" : "Withdraw release"}
                    </DropdownMenuItem>
                  )}
                  {!row.shared && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setRemoving(f)}>
                        <Trash2 /> Delete
                      </DropdownMenuItem>
                    </>
                  )}
                  {row.shared && (
                    <DropdownMenuItem asChild>
                      <Link to={shared!.appHref + "?tab=releases"}>Manage on the app page</Link>
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </li>
        )
      })}
    </ul>
  )

  /** A track: what it receives, its repository (own tracks) and its releases. */
  const trackCard = (track: TrackView, list: Row[], panel: TrackPanel | null, set: StatusSet) => {
    const isShared = panel === null
    // On a licence page, the app's track does not apply to the statuses the licence's own tracks cover.
    const replaced = isShared ? track.statuses.filter((k) => ownKeys.has(k)) : []
    const serves = track.statuses.filter((k) => !replaced.includes(k))
    return (
      <section key={track.id} className="overflow-hidden rounded-lg border bg-card">
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Layers className="size-4 text-muted-foreground" />
              <h3 className="font-medium">{track.name}</h3>
              {receiving?.trackId === track.id && <Badge variant="success">Receives now</Badge>}
              {isShared && <Badge variant="outline">From {shared?.appName}</Badge>}
            </div>
            <p className="text-xs text-muted-foreground">
              {serves.length > 0 ? (
                <>
                  For licences that are <span className="text-foreground">{describeStatusKeys(serves, set)}</span>
                  {track.check_domain ? ", on allowed sites" : ", without a domain check"}.
                </>
              ) : replaced.length > 0 ? (
                "Not used by this licence."
              ) : (
                "For no status yet: its releases are not available to any licence."
              )}
              {replaced.length > 0 && ` For ${describeStatusKeys(replaced, set)}, this licence receives its own track instead.`}
              {track.keep_releases !== null && ` Keeps the newest ${track.keep_releases} release${track.keep_releases === 1 ? "" : "s"}${list.length > track.keep_releases ? `; ${list.length} are stored` : ""}.`}
            </p>
          </div>
          {isShared ? (
            <Button asChild variant="ghost" size="sm">
              <Link to={shared!.appHref + "?tab=releases"}>Manage on the app page</Link>
            </Button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="size-8" aria-label={`Actions for the track ${track.name}`}>
                  <MoreHorizontal className="size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={() => setTrackDialog(track)}>
                  <Pencil /> Edit track
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onClick={() => setDeletingTrack(track)}>
                  <Trash2 /> Delete track
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        {panel && (
          <div className="border-b bg-muted/20 px-4 py-3">
            <TrackSource track={track} source={panel.source} imports={panel.imports} githubApp={githubApp} />
          </div>
        )}
        {list.length > 0 ? (
          table(list, "releases", latestIn(list), false)
        ) : (
          <p className="px-4 py-3 text-sm text-muted-foreground">No release in this track yet.{panel ? (panel.source ? " Push a tag, or upload a build." : " Upload a build, or connect a repository.") : ""}</p>
        )}
      </section>
    )
  }

  const nothing = rows.length === 0 && tracks.length === 0 && appTracks.length === 0
  const receivingLabel = receiving ? describeStatusKeys([receiving.status], statusSet) || receiving.status : ""
  const receivingTrack = receiving?.trackId ? [...ownTracks, ...appTracks].find((t) => t.id === receiving.trackId) : null

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-prose text-sm text-muted-foreground">{description}</p>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setTrackDialog("new")}>
            <Plus /> New track
          </Button>
          <Button onClick={() => setUploading(true)}>
            <Upload /> Upload
          </Button>
        </div>
      </div>
      {action.data?.error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{action.data.error}</div>}

      {receiving && (
        <p className="text-sm">
          This licence is <span className="font-medium">{receivingLabel}</span>:{" "}
          {receivingTrack ? (
            <>
              it receives the track <span className="font-medium">{receivingTrack.name}</span>.
            </>
          ) : (
            <span className="text-muted-foreground">no track serves this status, so it is offered no update.</span>
          )}
        </p>
      )}

      {conflicts.length > 0 && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
          {conflicts.map((c) => (
            <p key={c.status}>
              {describeStatusKeys([c.status], statusSet) || c.status} belongs to {c.tracks.map((t) => `"${t.name}"`).join(" and ")}: the highest version among them is offered. Edit the tracks so
              each status belongs to one track only.
            </p>
          ))}
        </div>
      )}

      {nothing ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <Layers className="mx-auto mb-2 size-6 text-muted-foreground" />
          <p className="font-medium">No release yet</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            A track is what a set of licence statuses receives, for example Updates for Active licences and a Final build for Completed ones. Create one, or upload a build with a version: a track
            named Releases is created for it.
          </p>
        </div>
      ) : (
        <>
          <section className="space-y-3">
            <h3 className="flex items-center gap-1.5 text-sm font-medium">
              Tracks <HelpTip>{TRACK_HELP}</HelpTip>
            </h3>
            {tracks.map((p) => trackCard(p.track, releases.filter((r) => !r.shared && r.file.track_id === p.track.id), p, statusSet))}
            {appTracks.map((t) => trackCard(t, releases.filter((r) => r.shared && r.file.track_id === t.id), null, shared!.statuses))}
            {withoutTrack.length > 0 && (
              <section className="space-y-2">
                <h4 className="text-sm font-medium">Releases without a track</h4>
                {table(withoutTrack, "releases", latestIn(withoutTrack))}
              </section>
            )}
          </section>
          {attachments.length > 0 && (
            <section className="space-y-2">
              <h3 className="flex items-center gap-1.5 text-sm font-medium">
                Attachments <HelpTip>Files without a version, such as a manual or a notice. Each one has its own release rule and is never offered as an update.</HelpTip>
              </h3>
              {table(attachments, "attachments")}
            </section>
          )}
        </>
      )}

      <UploadDialog open={uploading} onOpenChange={setUploading} uploadPath={uploadPath} statuses={statusSet} ownerLabel={ownerLabel} tracks={ownTracks} />
      <EditDialog file={editing} onClose={() => setEditing(null)} statuses={statusSet} tracks={ownTracks} />
      <TrackDialog track={trackDialog} onClose={() => setTrackDialog(null)} statuses={statusSet} tracks={ownTracks} stored={Object.fromEntries(ownTracks.map((t) => [t.id, releases.filter((r) => !r.shared && r.file.track_id === t.id).map((r) => r.file)]))} />
      {deletingTrack && <DeleteTrackDialog track={deletingTrack} onClose={() => setDeletingTrack(null)} others={ownTracks.filter((t) => t.id !== deletingTrack.id)} releases={releases.filter((r) => !r.shared && r.file.track_id === deletingTrack.id).length} />}

      <Dialog open={removing !== null} onOpenChange={(next) => !next && setRemoving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {removing?.name}?</DialogTitle>
            <DialogDescription>
              The file is removed from storage and its download link stops working. Copies already downloaded are not affected.{removing?.version ? " To stop offering a release but keep its record, withdraw it instead." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={action.state !== "idle"}
              onClick={() => {
                if (removing) action.submit({ intent: "delete-file", fileId: removing.id }, { method: "post" })
                setRemoving(null)
              }}
            >
              Delete file
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function ReleaseFields({
  version,
  setVersion,
  channel,
  setChannel,
  changelog,
  setChangelog,
  disabled,
}: {
  version: string
  setVersion: (v: string) => void
  channel: Channel
  setChannel: (c: Channel) => void
  changelog: string
  setChangelog: (v: string) => void
  disabled?: boolean
}) {
  const invalid = version.trim() !== "" && !isValidVersion(version.trim())
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <div className="space-y-1.5">
          <FieldLabel htmlFor="release-version" help={VERSION_HELP}>
            Version
          </FieldLabel>
          <Input
            id="release-version"
            value={version}
            onChange={(e) => setVersion(e.target.value)}
            placeholder="1.4.0, or empty for an attachment" disabled={disabled} aria-invalid={invalid} className="font-mono" />
          {invalid && <p className="text-xs text-destructive">Use numbers separated by dots, optionally with a suffix: 1.4.0 or 2.0.0-beta.1.</p>}
        </div>
        <div className="space-y-1.5">
          <FieldLabel htmlFor="release-channel" help={CHANNEL_HELP}>
            Channel
          </FieldLabel>
          <NativeSelect id="release-channel" value={channel} onChange={(e) => setChannel(e.target.value as Channel)} disabled={disabled || !version.trim()}>
            {CHANNELS.map((c) => (
              <option key={c} value={c}>
                {c === "stable" ? "Stable" : "Beta"}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {version.trim() && (
        <div className="space-y-1.5">
          <FieldLabel htmlFor="release-changelog" help={CHANGELOG_HELP}>
            Release notes
          </FieldLabel>
          <Textarea id="release-changelog" rows={4} maxLength={MAX_CHANGELOG_LENGTH} value={changelog} onChange={(e) => setChangelog(e.target.value)} placeholder="What changed in this version" disabled={disabled} />
        </div>
      )}
    </>
  )
}

function UploadDialog({
  open,
  onOpenChange,
  uploadPath,
  statuses: statusSet,
  ownerLabel,
  tracks,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  uploadPath: string
  statuses: StatusSet
  ownerLabel: string
  tracks: TrackView[]
}) {
  const revalidator = useRevalidator()
  const notes = useFetcher<ActionResult>()
  const input = useRef<HTMLInputElement>(null)
  const [file, setFile] = useState<File | null>(null)
  const [dragging, setDragging] = useState(false)
  const [version, setVersion] = useState("")
  const [channel, setChannel] = useState<Channel>("stable")
  const [changelog, setChangelog] = useState("")
  const [statuses, setStatuses] = useState<string[]>(() => defaultReleaseStatuses(statusSet))
  const [checkDomain, setCheckDomain] = useState(true)
  const [trackId, setTrackId] = useState("")
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState("")

  useEffect(() => {
    if (!open) return
    setFile(null)
    setVersion("")
    setChannel("stable")
    setChangelog("")
    setStatuses(defaultReleaseStatuses(statusSet))
    setCheckDomain(true)
    setTrackId(tracks[0]?.id ?? "")
    setError("")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const isRelease = version.trim() !== ""
  const track = tracks.find((t) => t.id === trackId) ?? null

  const choose = (picked: File | undefined) => {
    if (!picked) return
    setFile(picked)
    if (!version) setVersion(versionFromFileName(picked.name))
  }

  const busy = progress !== null

  function upload() {
    if (!file) return setError("Choose a file to upload.")
    if (file.size > MAX_FILE_BYTES) return setError(`The file exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`)
    if (version.trim() && !isValidVersion(version.trim())) return setError("Enter a valid version, or leave it empty for an attachment.")
    if (!isRelease && statuses.length === 0) return setError("Select at least one licence status.")
    if (isRelease && tracks.length > 0 && !track) return setError("Choose the track of this release.")
    setError("")
    setProgress(0)
    // A release takes its availability from its track; an attachment has its own.
    const query = new URLSearchParams(
      isRelease
        ? { name: file.name, version: version.trim(), channel, ...(track ? { track: track.id } : {}) }
        : { name: file.name, version: "", channel, statuses: statuses.join(","), check_domain: String(checkDomain) }
    )
    const xhr = new XMLHttpRequest()
    xhr.open("PUT", `${uploadPath}?${query}`)
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream")
    xhr.upload.onprogress = (e) => e.lengthComputable && setProgress(e.loaded / e.total)
    xhr.onerror = () => {
      setProgress(null)
      setError("The upload failed. Check your connection and try again.")
    }
    xhr.onload = () => {
      setProgress(null)
      let body: { file?: { id: string }; error?: string } = {}
      try {
        body = JSON.parse(xhr.responseText)
      } catch {}
      if (xhr.status !== 201 || !body.file) return setError(body.error ?? "The upload was rejected.")
      // Release notes can be long, so they are saved with a second request rather than in the upload address.
      if (version.trim() && changelog.trim()) notes.submit({ intent: "update-file", fileId: body.file.id, changelog }, { method: "post" })
      else revalidator.revalidate()
      onOpenChange(false)
    }
    xhr.send(file)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>Upload a file</DialogTitle>
          <DialogDescription>
            {ownerLabel === "app" ? "For every licence of this app:" : "For this licence only:"} a release is available according to its track, an attachment according to its own statuses. Up to{" "}
            {MAX_FILE_BYTES / 1024 / 1024} MB.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault()
              setDragging(false)
              choose(e.dataTransfer.files[0])
            }}
            disabled={busy}
            className={cn("flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-4 py-6 text-center text-sm transition-colors hover:bg-muted/50", dragging && "border-foreground bg-muted/50")}
          >
            <FileUp className="size-5 text-muted-foreground" />
            {file ? (
              <>
                <span className="font-medium break-all">{file.name}</span>
                <span className="text-xs text-muted-foreground">{formatBytes(file.size)}. Click to choose another file.</span>
              </>
            ) : (
              <>
                <span className="font-medium">Drop a file here, or click to choose one</span>
                <span className="text-xs text-muted-foreground">A version in the file name, such as theme-1.4.0.zip, is filled in for you.</span>
              </>
            )}
          </button>
          <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label="File" onChange={(e) => choose(e.target.files?.[0])} />

          <ReleaseFields version={version} setVersion={setVersion} channel={channel} setChannel={setChannel} changelog={changelog} setChangelog={setChangelog} disabled={busy} />

          {isRelease ? (
            <TrackPicker tracks={tracks} value={trackId} onChange={setTrackId} statuses={statusSet} disabled={busy} />
          ) : (
            <>
              <div className="space-y-1.5">
                <FieldLabel help={AVAILABILITY_HELP}>Available when licence status is</FieldLabel>
                <StatusPicker statuses={statusSet} value={statuses} onChange={setStatuses} disabled={busy} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={checkDomain} onChange={(e) => setCheckDomain(e.target.checked)} disabled={busy} />
                Only for allowed sites (domain check)
                <HelpTip>{DOMAIN_HELP}</HelpTip>
              </label>
            </>
          )}
          {busy && (
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuenow={Math.round((progress ?? 0) * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div className="h-full bg-primary transition-[width]" style={{ width: `${Math.round((progress ?? 0) * 100)}%` }} />
            </div>
          )}
          {error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={upload} disabled={busy || !file}>
            <Upload /> {busy ? `Uploading ${Math.round((progress ?? 0) * 100)}%` : version.trim() ? `Publish ${version.trim()}` : "Upload"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditDialog({ file, onClose, statuses: statusSet, tracks }: { file: FileRow | null; onClose: () => void; statuses: StatusSet; tracks: TrackView[] }) {
  const update = useFetcher<ActionResult>()
  const [version, setVersion] = useState("")
  const [channel, setChannel] = useState<Channel>("stable")
  const [changelog, setChangelog] = useState("")
  const [notes, setNotes] = useState("")
  const [statuses, setStatuses] = useState<string[]>([])
  const [checkDomain, setCheckDomain] = useState(true)
  const [trackId, setTrackId] = useState("")
  const [submitted, setSubmitted] = useState(false)

  useEffect(() => {
    if (!file) return
    setTrackId(file.track_id ?? tracks[0]?.id ?? "")
    setVersion(file.version)
    setChannel(file.channel)
    setChangelog(file.changelog)
    setNotes(file.notes)
    setStatuses(splitStatusKeys(file.statuses, statusSet))
    setCheckDomain(file.check_domain === 1)
    setSubmitted(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file?.id])

  // Close once the save succeeded; keep the dialog open to show an error.
  useEffect(() => {
    if (submitted && update.state === "idle" && update.data?.ok) onClose()
  }, [submitted, update.state, update.data, onClose])

  const busy = update.state !== "idle"
  return (
    <Dialog open={file !== null} onOpenChange={(next) => !busy && !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="break-all">Edit {file?.name}</DialogTitle>
          <DialogDescription>Change the version and notes of this file, and its track (a release) or when it can be downloaded (an attachment).</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <ReleaseFields version={version} setVersion={setVersion} channel={channel} setChannel={setChannel} changelog={changelog} setChangelog={setChangelog} />
          {version.trim() ? (
            <TrackPicker tracks={tracks} value={trackId} onChange={setTrackId} statuses={statusSet} />
          ) : (
            <>
              <div className="space-y-1.5">
                <FieldLabel help={AVAILABILITY_HELP}>Available when licence status is</FieldLabel>
                <StatusPicker statuses={statusSet} value={statuses} onChange={setStatuses} />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={checkDomain} onChange={(e) => setCheckDomain(e.target.checked)} />
                Only for allowed sites (domain check)
                <HelpTip>{DOMAIN_HELP}</HelpTip>
              </label>
            </>
          )}
          <div className="space-y-1.5">
            <FieldLabel htmlFor="file-notes" help="For your own reference. Never sent to sites.">
              Internal notes
            </FieldLabel>
            <Input id="file-notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
          </div>
          {submitted && update.state === "idle" && update.data?.error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{update.data.error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            disabled={busy || (version.trim() === "" && statuses.length === 0) || (version.trim() !== "" && !isValidVersion(version.trim()))}
            onClick={() => {
              if (!file) return
              setSubmitted(true)
              update.submit(
                version.trim()
                  ? { intent: "update-file", fileId: file.id, version: version.trim(), channel, changelog, notes, ...(trackId ? { track: trackId } : {}) }
                  : { intent: "update-file", fileId: file.id, version: "", channel, changelog: file.changelog, notes, statuses: statuses.join(","), check_domain: String(checkDomain) },
                { method: "post" }
              )
            }}
          >
            {busy ? "Saving..." : "Save changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Chooses the track of a release, and says what that track receives. */
function TrackPicker({ tracks, value, onChange, statuses, disabled }: { tracks: TrackView[]; value: string; onChange: (id: string) => void; statuses: StatusSet; disabled?: boolean }) {
  const track = tracks.find((t) => t.id === value) ?? null
  if (tracks.length === 0) {
    return (
      <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
        A track named <span className="font-medium text-foreground">Releases</span> is created for this release, for licences that are {describeStatusKeys(defaultReleaseStatuses(statuses), statuses)}.
        Change it afterwards from the track&apos;s menu.
      </p>
    )
  }
  return (
    <div className="space-y-1.5">
      <FieldLabel htmlFor="release-track" help={TRACK_HELP}>
        Track
      </FieldLabel>
      <NativeSelect id="release-track" value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {tracks.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </NativeSelect>
      {track && (
        <p className="text-xs text-muted-foreground">
          {track.statuses.length > 0 ? `Available to licences that are ${describeStatusKeys(track.statuses, statuses)}${track.check_domain ? ", on allowed sites" : ""}.` : "This track serves no status yet."}
        </p>
      )}
    </div>
  )
}

/** Creates or edits a track. Statuses that another track serves cannot be chosen. */
function TrackDialog({ track, onClose, statuses: statusSet, tracks, stored }: { track: TrackView | "new" | null; onClose: () => void; statuses: StatusSet; tracks: TrackView[]; stored: Record<string, FileRow[]> }) {
  const save = useFetcher<ActionResult>()
  const [name, setName] = useState("")
  const [selected, setSelected] = useState<string[]>([])
  const [checkDomain, setCheckDomain] = useState(true)
  const [limit, setLimit] = useState("")
  const [submitted, setSubmitted] = useState(false)
  const editing = track !== null && track !== "new" ? track : null

  useEffect(() => {
    if (track === null) return
    setName(editing?.name ?? (tracks.length === 0 ? "Releases" : ""))
    setSelected(editing?.statuses ?? [])
    setCheckDomain(editing?.check_domain ?? true)
    setLimit(editing?.keep_releases ? String(editing.keep_releases) : "")
    setSubmitted(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track])

  useEffect(() => {
    if (submitted && save.state === "idle" && save.data?.ok) onClose()
  }, [submitted, save.state, save.data, onClose])

  const taken = (key: string) => trackOverlaps(tracks.map((t) => ({ id: t.id, name: t.name, statuses: t.statuses.join(",") })), [key], editing?.id ?? null)[0]?.track ?? null
  const busy = save.state !== "idle"
  const limitNumber = limit.trim() === "" ? null : Number(limit)
  const limitValid = limitNumber === null || (Number.isInteger(limitNumber) && limitNumber >= 1 && limitNumber <= MAX_KEEP_RELEASES)
  const doomed = editing && limitNumber !== null && limitValid ? releasesToPrune(stored[editing.id] ?? [], limitNumber) : []
  return (
    <Dialog open={track !== null} onOpenChange={(next) => !busy && !next && onClose()}>
      <DialogContent className="sm:max-w-lg" onOpenAutoFocus={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${editing.name}` : "New track"}</DialogTitle>
          <DialogDescription>A track is what a set of licence statuses receives. Each status belongs to one track at most.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <FieldLabel htmlFor="track-name">Name</FieldLabel>
            <Input id="track-name" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} placeholder="Updates, Final build, Maintenance" disabled={busy} />
          </div>
          <div className="space-y-1.5">
            <FieldLabel help="Licences with one of these statuses are offered the latest release of this track. A status that another track serves is shown with that track's name: remove it there first.">
              For licences that are
            </FieldLabel>
            <div className="flex flex-wrap gap-x-4 gap-y-2" role="group" aria-label="Licence statuses">
              {statusSet.map((status) => {
                const other = taken(status.key)
                return (
                  <label key={status.key} className={cn("flex items-center gap-1.5 text-sm", other && "text-muted-foreground")} title={other ? `Served by ${other.name}` : status.description}>
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={selected.includes(status.key)}
                      disabled={busy || Boolean(other)}
                      onChange={(e) => setSelected(statusSet.filter((s) => (s.key === status.key ? e.target.checked : selected.includes(s.key))).map((s) => s.key))}
                    />
                    {status.label}
                    {other && <span className="text-xs">(in {other.name})</span>}
                  </label>
                )
              })}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-primary" checked={checkDomain} onChange={(e) => setCheckDomain(e.target.checked)} disabled={busy} />
            Only for allowed sites (domain check)
            <HelpTip>{DOMAIN_HELP}</HelpTip>
          </label>
          <div className="space-y-1.5">
            <FieldLabel htmlFor="track-keep" help="The number of releases this track keeps. When a release is added, or this number is lowered, the oldest releases beyond it are deleted with their files. The newest stable release and the newest beta release are never deleted. Leave empty to keep every release.">
              Keep the newest releases
            </FieldLabel>
            <Input id="track-keep" type="number" inputMode="numeric" min={1} max={MAX_KEEP_RELEASES} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="All releases" disabled={busy} className="w-40" />
            {!limitValid && <p className="text-xs text-destructive">Enter a whole number from 1 to {MAX_KEEP_RELEASES}, or leave it empty.</p>}
            {doomed.length > 0 && (
              <p className="rounded-md bg-destructive/10 p-2 text-xs text-destructive">
                Saving deletes the {doomed.length} oldest release{doomed.length === 1 ? "" : "s"} and {doomed.length === 1 ? "its file" : "their files"}: {doomed.slice(0, 6).map((f) => f.version).join(", ")}
                {doomed.length > 6 ? `, and ${doomed.length - 6} more` : ""}. This cannot be undone.
              </p>
            )}
          </div>
          {submitted && save.state === "idle" && save.data?.error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{save.data.error}</div>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={doomed.length > 0 ? "destructive" : "default"}
            disabled={busy || !name.trim() || !limitValid}
            onClick={() => {
              setSubmitted(true)
              save.submit(
                { intent: editing ? "update-track" : "create-track", ...(editing ? { trackId: editing.id } : {}), name: name.trim(), statuses: selected.join(","), check_domain: String(checkDomain), keep_releases: limit.trim() },
                { method: "post" }
              )
            }}
          >
            {busy ? "Saving..." : doomed.length > 0 ? `Save and delete ${doomed.length}` : editing ? "Save changes" : "Create track"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Deletes a track; its releases move to another track, chosen here. */
function DeleteTrackDialog({ track, onClose, others, releases }: { track: TrackView; onClose: () => void; others: TrackView[]; releases: number }) {
  const remove = useFetcher<ActionResult>()
  const [moveTo, setMoveTo] = useState(others[0]?.id ?? "")
  const [submitted, setSubmitted] = useState(false)
  useEffect(() => {
    if (submitted && remove.state === "idle" && remove.data?.ok) onClose()
  }, [submitted, remove.state, remove.data, onClose])
  if (releases === 0) {
    return (
      <ConfirmAction
        intent="delete-track"
        fields={{ trackId: track.id }}
        open
        onOpenChange={(open) => !open && onClose()}
        title={`Delete the track ${track.name}?`}
        description="It has no release. Its connected repository, if any, is disconnected."
        confirm="Delete track"
      />
    )
  }
  const busy = remove.state !== "idle"
  return (
    <Dialog open onOpenChange={(next) => !busy && !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete the track {track.name}?</DialogTitle>
          <DialogDescription>
            Its {releases} release{releases === 1 ? "" : "s"} move{releases === 1 ? "s" : ""} to another track and take{releases === 1 ? "s" : ""} that track&apos;s availability. Its connected repository, if
            any, is disconnected.
          </DialogDescription>
        </DialogHeader>
        {others.length === 0 ? (
          <p className="text-sm text-muted-foreground">There is no other track to move the releases to. Create one first, or delete the releases.</p>
        ) : (
          <div className="space-y-1.5">
            <FieldLabel htmlFor="move-to">Move the releases to</FieldLabel>
            <NativeSelect id="move-to" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} disabled={busy}>
              {others.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        )}
        {submitted && remove.state === "idle" && remove.data?.error && <div className="rounded-md bg-destructive/10 p-3 text-sm text-destructive">{remove.data.error}</div>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={busy || others.length === 0 || !moveTo}
            onClick={() => {
              setSubmitted(true)
              remove.submit({ intent: "delete-track", trackId: track.id, move_to: moveTo }, { method: "post" })
            }}
          >
            {busy ? "Deleting..." : "Move and delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
