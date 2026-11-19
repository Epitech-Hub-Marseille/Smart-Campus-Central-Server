import { Building2, CalendarDays, DoorOpen, Megaphone, Radio, Siren, Users } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { canEditCampus, useAuth } from "@/auth/AuthContext";
import { ConnectionBadge } from "@/components/DeviceBadges";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDeviceStatus } from "@/lib/DeviceStatus";
import { SECTIONS, itemsFor } from "@/lib/sections";
import { useFetch } from "@/lib/useFetch";
import { DEVICE_TYPE_LABEL, PRIORITY_LABEL, timeAgo, type Announcement, type Building, type Device, type Emergency, type Page, type Reservation, type StaffMember } from "@/lib/types";

function Stat({ to, icon, label, value, hint }: { to: string; icon: ReactNode; label: string; value: number | string; hint?: string }) {
  return (
    <Link to={to} className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
      <Card className="h-full gap-3 transition-colors hover:border-primary/40">
        <CardContent className="flex items-center justify-between">
          <div>
            <div className="text-sm text-muted-foreground">{label}</div>
            <div className="mt-1 text-3xl font-semibold tabular-nums">{value}</div>
            {hint && <div className="mt-1 text-xs text-muted-foreground">{hint}</div>}
          </div>
          <div className="grid size-10 place-items-center rounded-lg bg-accent text-primary [&_svg]:size-5">{icon}</div>
        </CardContent>
      </Card>
    </Link>
  );
}

/** A dashboard box: title, optional link to the full page, and a body that scrolls on its own if long. */
function Box({ title, to, linkLabel = "Open", className, children }: { title: string; to?: string; linkLabel?: string; className?: string; children: ReactNode }) {
  return (
    <Card className={className}>
      <CardHeader className="flex-row items-center justify-between">
        <CardTitle>{title}</CardTitle>
        {to && (
          <Link to={to} className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
            {linkLabel}
          </Link>
        )}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

const Empty = ({ children }: { children: ReactNode }) => <p className="text-sm text-muted-foreground">{children}</p>;

export function DashboardPage() {
  const { user } = useAuth();
  const manager = canEditCampus(user);
  const { online } = useDeviceStatus();
  const buildings = useFetch<{ items: Building[] }>("/buildings");
  const staff = useFetch<Page<StaffMember>>(manager ? "/users?limit=1" : null);
  const devices = useFetch<{ items: Device[] }>(manager ? "/devices" : null);
  const announcements = useFetch<Page<Announcement>>(manager ? "/announcements?kind=text&limit=50" : null);
  const emergencies = useFetch<Page<Emergency>>(manager ? "/emergencies?status=active&limit=10" : null);
  // Rounded to the minute so the request key stays stable between renders.
  const from = useMemo(() => new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(), []);
  const reservations = useFetch<Page<Reservation>>(`/reservations?limit=6&from=${encodeURIComponent(from)}`);

  const activeDevices = devices.data?.items.filter((d) => d.status === "active");
  const onlineCount = activeDevices?.filter((d) => (online ? online.has(d.id) : d.online)).length;
  const rooms = buildings.data?.items.reduce((n, b) => n + (b.roomCount ?? 0), 0);
  const activeAnnouncements = announcements.data?.items.filter((a) => a.state === "active");
  const alerts = emergencies.data?.items ?? [];

  return (
    <div className="space-y-6">
      <PageHeader title="Overview" description={`Welcome back, ${user?.name}.`} />

      {alerts.length > 0 && (
        <Link to="/emergency" className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
          <Card className="border-destructive/60 py-4" role="alert">
            <CardContent className="flex items-center gap-3 text-sm">
              <Siren className="size-5 text-destructive" aria-hidden />
              <span className="font-medium">{alerts.length === 1 ? alerts[0]?.title : `${alerts.length} emergency alerts are active`}</span>
              {alerts.some((a) => a.testMode) && <Badge variant="muted">Test</Badge>}
              <span className="ml-auto text-muted-foreground">Manage</span>
            </CardContent>
          </Card>
        </Link>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <Stat to="/buildings" icon={<Building2 />} label="Buildings" value={buildings.data?.items.length ?? "–"} />
        <Stat to="/rooms" icon={<DoorOpen />} label="Rooms" value={rooms ?? "–"} />
        {manager && <Stat to="/devices" icon={<Radio />} label="Devices online" value={activeDevices ? `${onlineCount}/${activeDevices.length}` : "–"} />}
        {manager && <Stat to="/section/communication" icon={<Megaphone />} label="Active announcements" value={activeAnnouncements?.length ?? "–"} />}
        {manager && <Stat to="/staff" icon={<Users />} label="People" value={staff.data?.total ?? "–"} />}
        {!manager && <Stat to="/reservations" icon={<CalendarDays />} label="Upcoming bookings" value={reservations.data?.total ?? "–"} />}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {manager && (
          <Box title="Devices" to="/devices" linkLabel="Manage" className="lg:col-span-2">
            {!activeDevices ? (
              <Empty>Loading…</Empty>
            ) : activeDevices.length === 0 ? (
              <Empty>No device enrolled yet. New devices ask to connect from the Devices page.</Empty>
            ) : (
              <ul className="divide-y">
                {activeDevices.slice(0, 8).map((d) => (
                  <li key={d.id}>
                    <Link to={`/devices/${d.id}`} className="flex items-center gap-4 py-3 text-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
                      <span className="min-w-0 flex-1 truncate font-medium">{d.name || d.id}</span>
                      <span className="hidden text-muted-foreground sm:block">{DEVICE_TYPE_LABEL[d.type]}</span>
                      <span className="hidden text-xs text-muted-foreground md:block">{d.online ? "" : timeAgo(d.lastSeenAt)}</span>
                      <ConnectionBadge status={d.status} online={online ? online.has(d.id) : d.online} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </Box>
        )}

        <Box title="Next reservations" to="/reservations" className={manager ? undefined : "lg:col-span-3"}>
          {!reservations.data ? (
            <Empty>Loading…</Empty>
          ) : reservations.data.items.length === 0 ? (
            <Empty>Nothing booked.</Empty>
          ) : (
            <ul className="divide-y">
              {reservations.data.items.map((r) => (
                <li key={r.id} className="py-2.5 text-sm">
                  <div className="truncate font-medium">{r.title}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.room?.code ?? "Room"} · {new Date(r.start).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Box>

        {manager && (
          <Box title="Announcements" to="/announcements" className="lg:col-span-3">
            {!activeAnnouncements ? (
              <Empty>Loading…</Empty>
            ) : activeAnnouncements.length === 0 ? (
              <Empty>No announcement is showing.</Empty>
            ) : (
              <ul className="grid gap-x-8 sm:grid-cols-2">
                {activeAnnouncements.slice(0, 6).map((a) => (
                  <li key={a.id} className="flex items-center gap-3 border-b py-2.5 text-sm">
                    <span className="min-w-0 flex-1 truncate">{a.title || a.text}</span>
                    <Badge variant="muted">{PRIORITY_LABEL[a.priority]}</Badge>
                    <span className="text-xs text-muted-foreground">{a.deviceCount} screens</span>
                  </li>
                ))}
              </ul>
            )}
          </Box>
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {SECTIONS.filter((s) => s.items.length > 0 && (manager || !s.managerOnly)).map((s) => (
          <Link key={s.id} to={s.to} className="rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            <Card className="h-full gap-2 transition-colors hover:border-primary/40">
              <CardContent className="flex items-start gap-3">
                <s.icon className="mt-0.5 size-5 shrink-0 text-primary" aria-hidden />
                <div>
                  <div className="text-[15px] font-semibold">{s.label}</div>
                  <p className="mt-1 text-sm text-muted-foreground">{s.summary}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{itemsFor(s, user?.role).map((i) => i.label).join(" · ")}</p>
                </div>
              </CardContent>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}
