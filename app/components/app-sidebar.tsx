import { Boxes, ChartColumn, Plug, ShieldBan, KeyRound, Braces, LayoutDashboard, LogOut, Monitor, Moon, MoreHorizontal, Search, ShieldCheck, Sun } from "lucide-react"
import { VERSION } from "#/lib/version"
import { Kbd } from "#/components/command-menu"
import { NavLink, useFetcher, useLocation, useNavigation } from "react-router"
import { useTheme } from "next-themes"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "#/components/ui/sidebar"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu"

const NAV = [
  { title: "Overview", to: "/overview", icon: LayoutDashboard },
  { title: "Apps", to: "/apps", icon: Boxes },
  { title: "Licences", to: "/licenses", icon: KeyRound },
  { title: "Licence templates", to: "/license-templates", icon: Boxes },
  { title: "Analytics", to: "/analytics", icon: ChartColumn },
  { title: "Protection", to: "/protection", icon: ShieldBan },
  { title: "Integrations", to: "/integrations", icon: Plug },
  { title: "API keys", to: "/api-keys", icon: Braces },
]

function NavGroup({ label, items }: { label: string; items: typeof NAV }) {
  // While a page loads, its item is already shown as current: the click is acknowledged at once.
  const navigation = useNavigation()
  const location = useLocation()
  const pathname = (navigation.location ?? location).pathname
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu>
          {items.map((item) => (
            <SidebarMenuItem key={item.to}>
              <SidebarMenuButton asChild isActive={pathname === item.to || pathname.startsWith(`${item.to}/`)} tooltip={item.title}>
                <NavLink to={item.to} prefetch="intent">
                  <item.icon />
                  <span>{item.title}</span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}

export function AppSidebar({ username, onSearch, ...props }: { username: string; onSearch: () => void } & React.ComponentProps<typeof Sidebar>) {
  const fetcher = useFetcher()
  const { setTheme } = useTheme()

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton size="lg" asChild>
              <NavLink to="/overview">
                <img src="/favicon.svg" alt="" className="size-8 rounded-lg" />
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Warden</span>
                  <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
                    <ShieldCheck className="size-3" /> Licence manager
                  </span>
                </div>
              </NavLink>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton onClick={onSearch} tooltip="Search (Ctrl+K)" className="border bg-background text-muted-foreground shadow-xs hover:text-foreground">
                <Search />
                <span>Search</span>
                <span className="ml-auto group-data-[collapsible=icon]:hidden">
                  <Kbd>⌘K</Kbd>
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>
        <NavGroup label="Manage" items={NAV} />
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg">
                  <div className="bg-sidebar-primary text-sidebar-primary-foreground flex aspect-square size-8 items-center justify-center rounded-lg font-semibold">
                    {username.charAt(0).toUpperCase()}
                  </div>
                  <div className="grid flex-1 text-left text-sm leading-tight">
                    <span className="truncate font-semibold">{username}</span>
                    <span className="truncate text-xs text-muted-foreground">Administrator</span>
                  </div>
                  <MoreHorizontal className="ml-auto size-4" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-[--radix-dropdown-menu-trigger-width] min-w-56 rounded-lg" side="bottom" align="end" sideOffset={4}>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <Sun />
                    Theme
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent>
                    <DropdownMenuItem onClick={() => setTheme("light")}>
                      <Sun /> Light
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setTheme("dark")}>
                      <Moon /> Dark
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setTheme("system")}>
                      <Monitor /> System
                    </DropdownMenuItem>
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => fetcher.submit(null, { method: "post", action: "/logout" })}>
                  <LogOut />
                  Log out
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">Warden {VERSION}</DropdownMenuLabel>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
