import { HelpTip } from "#/components/help-tip"
import { cn } from "#/lib/utils"

type Versions = {
  latest_version: string | null
  sites: number
  outdated: number
  up_to_date: number
  no_release: number
  not_reported: number
  data: { version: string | null; sites: number; behind: number; up_to_date: number; no_release: number; outdated: boolean }[]
}

/** The colour of a version's share: up to date in the foreground colour, behind (for some of its sites) amber, nothing to compare with muted. */
function tone(row: Versions["data"][number]) {
  if (row.version === null) return { bar: "bg-muted-foreground/25", dot: "bg-muted-foreground/40" }
  if (row.outdated) return { bar: "bg-amber-500", dot: "bg-amber-500" }
  if (row.no_release === row.sites) return { bar: "bg-muted-foreground/50", dot: "bg-muted-foreground/60" }
  return { bar: "bg-foreground", dot: "bg-foreground" }
}

/** How the sites of an app are spread over versions, from the versions they report with their checks. */
export function VersionAdoption({ versions }: { versions: Versions }) {
  const { data, sites, outdated, up_to_date: upToDate, no_release: noRelease, not_reported: notReported } = versions
  const summary = [
    `${upToDate} of ${sites} site${sites === 1 ? "" : "s"} up to date`,
    `${outdated} behind`,
    ...(noRelease > 0 ? [`${noRelease} with no release for their status`] : []),
    ...(notReported > 0 ? [`${notReported} not reported`] : []),
  ].join(", ")
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-medium">
          Versions in use{" "}
          <HelpTip>
            Built from the version each site sends with its check (?version=). A site is behind when its version is older than the latest release its licence is offered: the track of
            the licence&apos;s status, on the channel the site checks. When that status receives no release there is nothing to compare, so the site is neither up to date nor behind. A
            site that never sent a version counts as not reported.
          </HelpTip>
        </h3>
        <p className="text-sm text-muted-foreground tabular-nums">{summary}</p>
      </div>
      <div className="flex h-2.5 overflow-hidden rounded-full bg-muted" role="img" aria-label={data.map((r) => `${r.version ?? "not reported"}: ${r.sites}`).join(", ")}>
        {data.map((row) => (
          <div key={row.version ?? "none"} className={cn("h-full border-r border-background last:border-r-0", tone(row).bar)} style={{ width: `${(row.sites / sites) * 100}%` }} />
        ))}
      </div>
      <ul className="flex flex-wrap gap-x-5 gap-y-1.5 text-sm">
        {data.map((row) => (
          <li key={row.version ?? "none"} className="flex items-center gap-2">
            <span className={cn("size-2 rounded-full", tone(row).dot)} />
            <span className={cn(row.version ? "font-mono text-xs" : "text-xs text-muted-foreground")}>{row.version ?? "Not reported"}</span>
            <span className="text-muted-foreground tabular-nums">
              {row.sites} site{row.sites === 1 ? "" : "s"}
              {row.behind > 0 && row.behind < row.sites && `, ${row.behind} behind`}
              {row.no_release > 0 && row.no_release < row.sites && `, ${row.no_release} with no release`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
