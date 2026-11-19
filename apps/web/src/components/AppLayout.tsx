import { LogOut, Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router-dom";
import { canEditCampus, useAuth } from "@/auth/AuthContext";
import { IdleWarning } from "@/components/IdleWarning";
import { Logo, Wordmark } from "@/components/Logo";
import { Notifications } from "@/components/Notifications";
import { DeviceStatusProvider, useOptionalDeviceStatus } from "@/lib/DeviceStatus";
import { SECTIONS, sectionFor, type Section } from "@/lib/sections";
import { ROLE_LABEL } from "@/lib/types";
import { cn } from "@/lib/utils";

export function AppLayout() {
  const { user } = useAuth();
  if (!user) return null;
  // The live device channel is only open to admins and operators.
  return canEditCampus(user) ? (
    <DeviceStatusProvider>
      <Shell />
    </DeviceStatusProvider>
  ) : (
    <Shell />
  );
}

const focusRing = "outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

/** Narrow icon rail: one entry per section, like the left rail of UniFi Site Manager. */
function Rail({ sections, current, waiting }: { sections: Section[]; current: Section; waiting: number }) {
  return (
    <nav aria-label="Sections" className="flex w-full flex-1 flex-col items-center gap-1 overflow-x-hidden overflow-y-auto py-3">
      {sections.map((s) => {
        const active = s.id === current.id;
        return (
          <Link
            key={s.id}
            to={s.to}
            aria-label={s.label}
            aria-current={active ? "page" : undefined}
            title={s.label}
            className={cn(
              "relative flex w-[76px] flex-col items-center gap-1 rounded-lg px-1 py-2 text-[10px] leading-none text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground",
              focusRing,
              active && "bg-accent text-foreground",
            )}
          >
            <s.icon className="size-5" aria-hidden />
            <span className="max-w-full truncate">{s.short}</span>
            {s.id === "devices" && waiting > 0 && (
              <span
                className="absolute top-1 right-2 grid min-w-4 place-items-center rounded-full bg-primary px-1 text-[10px] leading-4 font-medium text-primary-foreground"
                aria-label={`${waiting} connection request${waiting === 1 ? "" : "s"} waiting`}
              >
                {waiting}
              </span>
            )}
          </Link>
        );
      })}
    </nav>
  );
}

/** Pages of the current section, shown beside the content (hidden on the overview, which has none). */
function SectionPanel({ section }: { section: Section }) {
  if (section.items.length === 0) return null;
  return (
    <nav aria-label={section.label} className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col self-start border-r bg-background lg:flex">
      <div className="flex h-14 items-center border-b px-5 text-sm font-semibold">{section.label}</div>
      <div className="flex flex-col gap-0.5 p-3">
        <NavLink to={section.to} end className={({ isActive }) => cn(panelLink, focusRing, isActive && panelActive)}>
          Overview
        </NavLink>
        {section.items.map(({ to, label, icon: Icon }) => (
          <NavLink key={to} to={to} className={({ isActive }) => cn(panelLink, focusRing, isActive && panelActive)}>
            <Icon className="size-4" aria-hidden /> {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
const panelLink = "flex items-center gap-3 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground";
const panelActive = "bg-accent text-foreground";

function Shell() {
  const { user, logout } = useAuth();
  const status = useOptionalDeviceStatus();
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // A drawer left open after navigating would cover the page it just opened.
  useEffect(() => setMenuOpen(false), [location.pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setMenuOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  if (!user) return null;
  const manager = canEditCampus(user);
  const sections = SECTIONS.filter((s) => manager || !s.managerOnly);
  const current = sectionFor(location.pathname);
  const waiting = status?.requests.length ?? 0;

  const account = (
    <div className="flex flex-col items-center gap-2 border-t py-3">
      <div className="grid size-8 place-items-center rounded-full bg-accent text-xs font-semibold" aria-hidden title={`${user.name}, ${ROLE_LABEL[user.role]}`}>
        {user.name.slice(0, 1).toUpperCase()}
      </div>
      <button aria-label="Sign out" title="Sign out" onClick={() => void logout()} className={cn("rounded-md p-2 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground", focusRing)}>
        <LogOut className="size-4" />
      </button>
    </div>
  );

  return (
    <div className="min-h-screen">
      <aside className="fixed inset-y-0 left-0 z-30 hidden w-[88px] flex-col items-center border-r bg-sidebar md:flex">
        <Link to="/" aria-label="Smart Campus, overview" className={cn("grid h-14 w-full place-items-center border-b", focusRing)}>
          <Logo className="size-7" />
        </Link>
        <Rail sections={sections} current={current} waiting={waiting} />
        {account}
      </aside>

      <div className="flex min-h-screen md:pl-[88px]">
        <SectionPanel section={current} />
        <div className="min-w-0 flex-1">
          <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b bg-background/90 px-4 backdrop-blur md:px-8">
            <button aria-label="Open menu" className={cn("rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden", focusRing)} onClick={() => setMenuOpen(true)}>
              <Menu className="size-5" />
            </button>
            <Wordmark className="md:hidden" />
            <span className="hidden text-sm text-muted-foreground md:block">
              Smart Campus <span aria-hidden>/</span> <span className="text-foreground">{current.label}</span>
            </span>
            {status && (
              <span className="ml-auto flex items-center gap-2 text-xs text-muted-foreground" title={status.live ? "Receiving live updates from the server" : "Live updates are interrupted, reconnecting"}>
                <span className={cn("size-2 rounded-full", status.live ? "bg-primary" : "bg-muted-foreground")} aria-hidden />
                {status.live ? "Live" : "Reconnecting"}
              </span>
            )}
          </header>
          <main className="mx-auto max-w-7xl px-4 py-8 md:px-8">
            <Outlet />
          </main>
        </div>
      </div>

      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden">
          <button aria-label="Close menu" className="absolute inset-0 bg-black/40" onClick={() => setMenuOpen(false)} />
          <aside className="absolute inset-y-0 left-0 flex w-64 flex-col overflow-y-auto border-r bg-sidebar">
            <div className="flex h-14 shrink-0 items-center justify-between border-b px-5">
              <Wordmark />
              <button aria-label="Close menu" className="rounded-md p-1.5 text-muted-foreground hover:text-foreground" onClick={() => setMenuOpen(false)}>
                <X className="size-4" />
              </button>
            </div>
            <nav aria-label="Main" className="flex flex-1 flex-col gap-4 px-3 py-4">
              {sections.map((s) => (
                <div key={s.id}>
                  <NavLink to={s.to} end className={({ isActive }) => cn(panelLink, "font-medium text-foreground", focusRing, isActive && panelActive)}>
                    <s.icon className="size-4" aria-hidden /> {s.label}
                  </NavLink>
                  {s.items.map(({ to, label, icon: Icon }) => (
                    <NavLink key={to} to={to} className={({ isActive }) => cn(panelLink, "pl-10", focusRing, isActive && panelActive)}>
                      <Icon className="size-4" aria-hidden /> {label}
                    </NavLink>
                  ))}
                </div>
              ))}
            </nav>
            <div className="flex items-center gap-3 border-t px-4 py-3 text-xs">
              <span className="min-w-0 flex-1 truncate">{user.name}</span>
              <button aria-label="Sign out" onClick={() => void logout()} className={cn("rounded-md p-2 text-muted-foreground hover:bg-accent hover:text-foreground", focusRing)}>
                <LogOut className="size-4" />
              </button>
            </div>
          </aside>
        </div>
      )}

      <IdleWarning />
      {manager && <Notifications />}
    </div>
  );
}
