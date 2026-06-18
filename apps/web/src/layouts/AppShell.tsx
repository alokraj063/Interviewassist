import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useState } from "react";
import {
  LayoutDashboard, MessagesSquare, ClipboardCheck, GraduationCap, Users, Headphones,
  Bot, ListChecks, BookOpen, BarChart3, Settings, ChevronsLeft, ChevronsRight,
  Search, Bell, HelpCircle, ChevronDown, LogOut, UserCircle, Building2, Command, Radio,
  GitBranch, Briefcase, UserSearch, Database, ClipboardList, Video, ShieldCheck,
  Building, FolderSync, Library,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { Avatar } from "@/components/ui-kit";
import { HandoffToastBridge } from "@/components/triage/HandoffToastBridge";
import { useAuth, useCan } from "@/auth/AuthContext";
import { NOTIFICATIONS, formatRelative } from "@/data/store";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { GlobalSearch } from "@/components/GlobalSearch";

interface NavItem {
  to: string;
  label: string;
  icon: typeof LayoutDashboard;
  end?: boolean;
  perm?: string;
  role?: string;
}

interface NavSection {
  title: string;
  items: NavItem[];
}

// NOTE: The product is temporarily focused on the Live Assist feature only.
// Every other section is commented out (not deleted) so the sidebar surfaces
// just Live Assist. The backend routes + pages all still exist and remain
// reachable by direct URL — restore the entries below to bring the full IA
// back. See the "focus on Live Assist" change.
const NAV_SECTIONS: NavSection[] = [
  {
    title: "Live Assist",
    items: [
      { to: "/live-assist", label: "Live Assist", icon: Headphones, perm: "live_assist.read", end: true },
      { to: "/live-assist/settings", label: "Settings", icon: Settings },
    ],
  },
  // {
  //   title: "Pipeline",
  //   items: [
  //     { to: "/", label: "Home", icon: LayoutDashboard, end: true },
  //     { to: "/demands", label: "Demands", icon: Briefcase, perm: "demands.read" },
  //     { to: "/candidates", label: "Candidates", icon: UserSearch, perm: "candidates.read" },
  //   ],
  // },
  // {
  //   title: "Live Work",
  //   items: [
  //     { to: "/calls", label: "Calls", icon: MessagesSquare, perm: "calls.read" },
  //     { to: "/qa-review", label: "QA Review", icon: ClipboardCheck, perm: "qa.read" },
  //     { to: "/coaching", label: "Coaching", icon: GraduationCap },
  //     { to: "/triage", label: "Triage", icon: GitBranch, perm: "triage.read" },
  //   ],
  // },
  // {
  //   title: "Sourcing & Assessment",
  //   items: [
  //     { to: "/sourcing", label: "Sourcing", icon: Database, perm: "candidates.read" },
  //     { to: "/assessments", label: "Assessments", icon: ClipboardList },
  //     { to: "/async-video", label: "Async Video", icon: Video },
  //     { to: "/proctor", label: "Proctor Cockpit", icon: ShieldCheck },
  //   ],
  // },
  // {
  //   title: "People & Clients",
  //   items: [
  //     { to: "/recruiters", label: "Recruiters", icon: Users, perm: "users.read" },
  //     { to: "/team-monitor", label: "Team Monitor", icon: Radio, perm: "calls.read" },
  //     { to: "/voice-agents", label: "Voice Screeners", icon: Bot, perm: "voice_agents.read" },
  //     { to: "/client-portal", label: "Client Portal", icon: Building },
  //   ],
  // },
  // {
  //   title: "Config",
  //   items: [
  //     { to: "/rubrics", label: "Rubrics", icon: ListChecks, perm: "rubrics.read" },
  //     { to: "/question-banks", label: "Question Banks", icon: Library },
  //     { to: "/knowledge", label: "Knowledge Base", icon: BookOpen, perm: "knowledge.read" },
  //     { to: "/analytics", label: "Analytics", icon: BarChart3, perm: "analytics.read" },
  //     { to: "/settings", label: "Settings", icon: Settings },
  //   ],
  // },
  // {
  //   title: "Admin",
  //   items: [
  //     { to: "/admin/offer-letter-sync", label: "Offer Letter Sync", icon: FolderSync, role: "admin" },
  //   ],
  // },
];

export default function AppShell() {
  const [collapsed, setCollapsed] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const { signOut, workspace, user, can } = useAuth();
  const userRole = user?.role ?? "";
  const visibleSections = NAV_SECTIONS
    .map((section) => ({
      ...section,
      items: section.items.filter((i) => {
        if (i.perm && !can(i.perm)) return false;
        if (i.role && userRole !== i.role) return false;
        return true;
      }),
    }))
    .filter((section) => section.items.length > 0);
  const nav = useNavigate();
  const unread = NOTIFICATIONS.filter(n => !n.read).length;

  const displayName = user?.name ?? user?.email ?? "User";
  const displayEmail = user?.email ?? "";
  const displayRole = (user?.role ?? "")
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const initials = displayName
    .split(/[@\s.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      {/* Global triage handoff toast — listens on /ws/agent. */}
      <HandoffToastBridge />
      {/* Sidebar */}
      <aside className={cn("border-r border-sidebar-border bg-sidebar flex flex-col shrink-0 transition-[width] duration-150", collapsed ? "w-[60px]" : "w-[224px]")}>
        <div className={cn("h-14 flex items-center border-b border-sidebar-border px-3", collapsed ? "justify-center" : "justify-between")}>
          {collapsed ? <Logo withText={false} size={26} /> : <Logo />}
          {!collapsed && (
            <button onClick={() => setCollapsed(true)} className="p-1 rounded hover:bg-sidebar-accent text-muted-foreground" title="Collapse sidebar">
              <ChevronsLeft className="w-4 h-4" />
            </button>
          )}
        </div>
        {collapsed && (
          <button onClick={() => setCollapsed(false)} className="mx-2 mt-2 p-1 rounded hover:bg-sidebar-accent text-muted-foreground self-center" title="Expand sidebar">
            <ChevronsRight className="w-4 h-4" />
          </button>
        )}
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {visibleSections.map((section, idx) => (
            <div key={section.title}>
              {idx > 0 && <div className="my-2 mx-2 border-t border-sidebar-border" />}
              {!collapsed && (
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide font-semibold text-muted-foreground">
                  {section.title}
                </div>
              )}
              <SidebarSection items={section.items} collapsed={collapsed} />
            </div>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-2">
          {!collapsed ? (
            <div className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-sidebar-accent cursor-pointer" onClick={() => nav("/settings/profile")}>
              <Avatar initials={initials} size={26} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate text-white">{displayName}</div>
                <div className="text-[11px] text-muted-foreground truncate">{displayRole}</div>
              </div>
            </div>
          ) : (
            <div className="flex justify-center"><Avatar initials={initials} size={26} /></div>
          )}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-14 border-b border-border bg-background flex items-center px-4 gap-3 shrink-0">
          {/* Workspace switcher */}
          <DropdownMenu>
            <DropdownMenuTrigger className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-muted text-sm">
              <Building2 className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium">{workspace}</span>
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-64">
              <DropdownMenuLabel className="text-[11px] uppercase text-muted-foreground">Workspaces</DropdownMenuLabel>
              <DropdownMenuItem>
                <Building2 className="w-4 h-4 mr-2" />
                {workspace}
                <span className="ml-auto text-[10px] bg-primary text-primary-foreground rounded px-1.5">Active</span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Search */}
          <button onClick={() => setSearchOpen(true)} className="ml-2 flex-1 max-w-[520px] h-9 px-3 inline-flex items-center gap-2 border border-border rounded-md text-sm text-muted-foreground bg-muted/40 hover:bg-muted transition-colors">
            <Search className="w-4 h-4" />
            <span>Search conversations, agents, scorecards…</span>
            <span className="ml-auto kbd"><Command className="w-3 h-3 mr-0.5 inline" />K</span>
          </button>

          <div className="flex items-center gap-1 ml-auto">
            {/* Notifications */}
            <Popover>
              <PopoverTrigger className="relative h-9 w-9 inline-flex items-center justify-center rounded hover:bg-muted">
                <Bell className="w-4 h-4" />
                {unread > 0 && <span className="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 inline-flex items-center justify-center rounded-full bg-destructive text-[10px] font-semibold text-white">{unread}</span>}
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[360px] p-0">
                <div className="px-4 py-3 border-b border-border flex items-center justify-between">
                  <span className="text-sm font-semibold">Notifications</span>
                  <button className="text-xs text-primary hover:underline">Mark all as read</button>
                </div>
                <div className="max-h-[420px] overflow-y-auto">
                  {NOTIFICATIONS.map(n => (
                    <div key={n.id} className={cn("px-4 py-3 border-b border-border/60 hover:bg-muted/50 cursor-pointer", !n.read && "bg-primary-muted/40")}>
                      <div className="flex items-start gap-2">
                        <span className={cn("w-1.5 h-1.5 rounded-full mt-1.5", n.type === "alert" ? "bg-destructive" : n.type === "success" ? "bg-success" : "bg-info")} />
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium">{n.title}</div>
                          <div className="text-xs text-muted-foreground">{n.body}</div>
                          <div className="text-[11px] text-muted-foreground mt-0.5">{formatRelative(n.ts)}</div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </PopoverContent>
            </Popover>

            {/* Help */}
            <DropdownMenu>
              <DropdownMenuTrigger className="h-9 w-9 inline-flex items-center justify-center rounded hover:bg-muted">
                <HelpCircle className="w-4 h-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem>Documentation</DropdownMenuItem>
                <DropdownMenuItem>API reference</DropdownMenuItem>
                <DropdownMenuItem>Keyboard shortcuts</DropdownMenuItem>
                <DropdownMenuItem>Contact support</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem>What's new</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>

            {/* User menu */}
            <DropdownMenu>
              <DropdownMenuTrigger className="ml-1 h-9 px-1.5 inline-flex items-center gap-2 rounded hover:bg-muted">
                <Avatar initials={initials} size={26} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="font-normal">
                  <div className="text-sm font-medium">{displayName}</div>
                  <div className="text-xs text-muted-foreground">{displayEmail}</div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => nav("/settings/profile")}><UserCircle className="w-4 h-4 mr-2" />Profile</DropdownMenuItem>
                <DropdownMenuItem onClick={() => nav("/settings")}>Account settings</DropdownMenuItem>
                <DropdownMenuItem>Switch workspace</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => { signOut(); nav("/sign-in"); }}><LogOut className="w-4 h-4 mr-2" />Sign out</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto bg-muted/20">
          <Outlet />
        </main>
      </div>

      <GlobalSearch open={searchOpen} onOpenChange={setSearchOpen} />
    </div>
  );
}

function SidebarSection({ items, collapsed }: { items: NavItem[]; collapsed: boolean }) {
  return (
    <div className="space-y-0.5">
      {items.map(item => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => cn(
            "flex items-center gap-2.5 px-2.5 py-1.5 rounded-md text-[13px] font-medium transition-colors",
            isActive ? "bg-primary text-primary-foreground" : "text-sidebar-foreground hover:bg-sidebar-accent",
            collapsed && "justify-center px-0"
          )}
          title={collapsed ? item.label : undefined}
        >
          <item.icon className="w-4 h-4 shrink-0" />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </NavLink>
      ))}
    </div>
  );
}
