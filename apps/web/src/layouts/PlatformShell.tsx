// Layout for /platform/* — the super-admin surface. Distinct from AppShell
// because platform admins have no org context: there's no workspace switcher,
// no per-org permission RBAC, and the sidebar shows only platform routes.
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Building2, Boxes, LogOut, ShieldCheck } from "lucide-react";
import { Logo } from "@/components/Logo";
import { Avatar } from "@/components/ui-kit";
import { useAuth } from "@/auth/AuthContext";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/platform/tenants", label: "Tenants", icon: Boxes },
] as const;

export default function PlatformShell() {
  const { user, signOut } = useAuth();
  const nav = useNavigate();

  const displayName = user?.name ?? user?.email ?? "Platform admin";
  const displayEmail = user?.email ?? "";
  const initials = displayName
    .split(/[@\s.]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");

  return (
    <div className="h-screen flex bg-background text-foreground overflow-hidden">
      <aside className="border-r border-sidebar-border bg-sidebar flex flex-col shrink-0 w-[224px]">
        <div className="h-14 flex items-center border-b border-sidebar-border px-3">
          <Logo />
        </div>
        <div className="px-4 py-3 border-b border-sidebar-border flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
          <ShieldCheck className="w-4 h-4 text-primary" />
          Platform admin
        </div>
        <nav className="flex-1 overflow-y-auto py-3 px-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 px-2 py-1.5 rounded text-sm",
                  isActive
                    ? "bg-sidebar-accent text-white"
                    : "text-muted-foreground hover:bg-sidebar-accent hover:text-white",
                )
              }
            >
              <item.icon className="w-4 h-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-sidebar-border p-2">
          <DropdownMenu>
            <DropdownMenuTrigger className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-sidebar-accent text-left">
              <Avatar initials={initials} size={26} />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate text-white">{displayName}</div>
                <div className="text-[11px] text-muted-foreground truncate">{displayEmail}</div>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-56">
              <DropdownMenuLabel>{displayName}</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onClick={async () => {
                  await signOut();
                  nav("/sign-in", { replace: true });
                }}
              >
                <LogOut className="w-4 h-4 mr-2" />
                Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>

      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 border-b border-border bg-background flex items-center px-4 gap-3 shrink-0">
          <Building2 className="w-4 h-4 text-muted-foreground" />
          <h1 className="text-sm font-medium">Platform administration</h1>
        </header>
        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
