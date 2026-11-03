import type { AttachmentFacts } from "#/lib/entitlements"
import { useEffect, useMemo, useRef, useState } from "react"
import { useFetcher, useNavigate } from "react-router"
import { Boxes, Braces, CornerDownLeft, KeyRound, LayoutDashboard, Plus, Search } from "lucide-react"
import type { loader as searchLoader } from "#/routes/search"
import { LicenseStatusBadge } from "#/components/status-badge"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "#/components/ui/dialog"
import { cn } from "#/lib/utils"

type Item = { id: string; group: string; label: string; hint?: string; icon: React.ComponentType<{ className?: string }>; to: string; license?: { apps?: AttachmentFacts[]; id: string; status: string; expires_at: number | null; app_id: string | null } }

const PAGES: Item[] = [
  { id: "p-overview", group: "Go to", label: "Overview", icon: LayoutDashboard, to: "/overview" },
  { id: "p-licences", group: "Go to", label: "Licences", icon: KeyRound, to: "/licenses" },
  { id: "p-apps", group: "Go to", label: "Apps", icon: Boxes, to: "/apps" },
  { id: "p-templates", group: "Go to", label: "Licence templates", icon: Boxes, to: "/license-templates" },
  { id: "p-api", group: "Go to", label: "API keys", icon: Braces, to: "/api-keys" },
  { id: "a-licence", group: "Create", label: "New licence", icon: Plus, to: "/licenses/new" },
  { id: "a-app", group: "Create", label: "New app", icon: Plus, to: "/apps/new" },
]

/** Opens with Cmd+K / Ctrl+K (or "/" outside a text field). Finds licences by name, customer, key or site, and apps. */
export function CommandMenu({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate()
  const search = useFetcher<typeof searchLoader>()
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)

  // Ask the server once typing pauses.
  useEffect(() => {
    const q = query.trim()
    if (!q) return
    const timer = setTimeout(() => search.load(`/search?q=${encodeURIComponent(q)}`), 150)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query])

  useEffect(() => {
    if (!open) {
      setQuery("")
      setActive(0)
    }
  }, [open])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    const pages = PAGES.filter((p) => !q || p.label.toLowerCase().includes(q))
    if (!q || search.data?.q.toLowerCase() !== q) return pages
    const licences: Item[] = search.data.licenses.map((l) => ({
      id: l.id,
      group: "Licences",
      label: l.name,
      hint: l.matched_site ? `Site ${l.matched_site}` : [l.customer_name, l.app_name ?? "Standalone"].filter(Boolean).join(", "),
      icon: KeyRound,
      to: `/licenses/${l.id}`,
      license: l,
    }))
    const apps: Item[] = search.data.apps.map((a) => ({ id: a.id, group: "Apps", label: a.name, hint: `${a.licenses} licence${a.licenses === 1 ? "" : "s"}`, icon: Boxes, to: `/apps/${a.id}` }))
    return [...licences, ...apps, ...pages]
  }, [query, search.data])

  useEffect(() => setActive(0), [items.length])
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])

  const go = (item: Item | undefined) => {
    if (!item) return
    onOpenChange(false)
    navigate(item.to)
  }

  const loading = search.state === "loading" && query.trim() !== ""
  let lastGroup = ""

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false} className="top-[15%] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Find a licence by name, customer, key or site domain, or an app, and go to it.</DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault()
                setActive((i) => Math.min(i + 1, items.length - 1))
              } else if (e.key === "ArrowUp") {
                e.preventDefault()
                setActive((i) => Math.max(i - 1, 0))
              } else if (e.key === "Enter") {
                e.preventDefault()
                go(items[active])
              }
            }}
            placeholder="Licence, customer, key, site domain or app"
            aria-label="Search"
            aria-controls="command-results"
            aria-activedescendant={items[active] ? `command-${items[active].id}` : undefined}
            className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
          {loading && <span className="text-xs text-muted-foreground">Searching</span>}
        </div>
        <div ref={listRef} id="command-results" role="listbox" className="max-h-[min(60vh,26rem)] overflow-y-auto p-1.5">
          {items.length === 0 && <p className="px-3 py-8 text-center text-sm text-muted-foreground">{loading ? "Searching..." : `Nothing matches "${query.trim()}".`}</p>}
          {items.map((item, index) => {
            const header = item.group !== lastGroup ? item.group : null
            lastGroup = item.group
            return (
              <div key={item.id}>
                {header && <div className="px-2.5 pt-2.5 pb-1 text-xs font-medium text-muted-foreground">{header}</div>}
                <div
                  id={`command-${item.id}`}
                  role="option"
                  aria-selected={index === active}
                  data-index={index}
                  onMouseMove={() => setActive(index)}
                  onClick={() => go(item)}
                  className={cn("flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2 text-sm", index === active && "bg-accent")}
                >
                  <item.icon className="size-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{item.label}</div>
                    {item.hint && <div className="truncate text-xs text-muted-foreground">{item.hint}</div>}
                  </div>
                  {item.license && (item.license.apps?.length ? <span className="text-xs text-muted-foreground">{item.license.apps.filter((e) => e.valid).length}/{item.license.apps.length} apps valid</span> : <LicenseStatusBadge license={item.license} />)}
                  {index === active && <CornerDownLeft className="size-3.5 shrink-0 text-muted-foreground" />}
                </div>
              </div>
            )
          })}
        </div>
        <div className="flex items-center gap-4 border-t px-3 py-2 text-xs text-muted-foreground">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> to move
          </span>
          <span>
            <Kbd>Enter</Kbd> to open
          </span>
          <span>
            <Kbd>Esc</Kbd> to close
          </span>
        </div>
      </DialogContent>
    </Dialog>
  )
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return <kbd className="rounded border bg-muted px-1.5 py-px font-sans text-[0.7rem] text-muted-foreground">{children}</kbd>
}

/** Opens the search with Cmd+K / Ctrl+K anywhere, or with "/" when no text field has the focus. */
export function useCommandShortcut(setOpen: (open: boolean | ((open: boolean) => boolean)) => void) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const typing = target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        setOpen((o) => !o)
      } else if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault()
        setOpen(true)
      }
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [setOpen])
}
