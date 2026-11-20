import { CalendarSync, DoorOpen, Eye, EyeOff, Pencil, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useState, type CSSProperties, type FormEvent } from "react";
import { useAuth } from "@/auth/AuthContext";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { SERVICES, SERVICE_LABEL, timeAgo, type Building, type Page, type Room, type Service } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

interface PluginField {
  key: string;
  label: string;
  type: "url" | "text" | "number" | "boolean";
  secret?: boolean;
  required?: boolean;
  help?: string;
}
interface Plugin {
  id: string;
  label: string;
  description: string;
  fields: PluginField[];
}
interface Summary {
  fetched: number;
  created: number;
  updated: number;
  cancelled: number;
  removed: number;
  reservations: number;
  linkedPeople: number;
  registeredPeople: number;
  createdRooms: number;
  unmatchedLocations: string[];
}
interface Place {
  place: string;
  events: number;
  state: "room" | "ignored" | "none";
  roomId: string | null;
  via: "name" | "alias" | null;
}
interface Integration {
  id: string;
  plugin: string;
  pluginLabel: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretsSet: string[];
  intervalMinutes: number;
  horizonDays: number;
  autoRegister: boolean;
  registerService: Service | null;
  roomAliases: Record<string, string>;
  ignoredPlaces: string[];
  autoCreateRooms: boolean;
  autoCreateBuildingId: string | null;
  autoCreateFloor: number;
  lastSyncAt: string | null;
  nextSyncAt: string | null;
  lastStatus: "never" | "ok" | "error";
  lastError: string | null;
  lastSummary: Summary | null;
}
interface CampusEvent {
  id: string;
  integrationId: string;
  title: string;
  start: string;
  end: string;
  status: "active" | "cancelled";
  locations: string[];
  roomIds: string[];
  people: { name: string; userId: string | null }[];
}

const time = (iso: string) => new Date(iso).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/** The logo of a platform, from `public/integrations/<plugin id>.png`; a plug when there is none. */
function PluginIcon({ id, className = "size-9" }: { id: string; className?: string }) {
  const [missing, setMissing] = useState(false);
  if (missing) return <Plug className={`${className} p-1.5 text-muted-foreground`} aria-hidden />;
  return <img src={`/integrations/${id}.png`} alt="" className={`${className} rounded-lg object-cover`} onError={() => setMissing(true)} />;
}

/**
 * A secret setting (a link that holds a token). It is a plain text field that shows dots until it is revealed, and not a
 * password field: a browser or password manager treats those differently, and a link is something people paste and check.
 */
function SecretInput({ id, value, onChange, required, placeholder }: { id: string; value: string; onChange: (value: string) => void; required?: boolean; placeholder?: string }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="flex gap-2">
      <Input
        id={id}
        type="text"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        data-1p-ignore
        data-lpignore="true"
        required={required}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="font-mono"
        style={shown ? undefined : ({ WebkitTextSecurity: "disc" } as CSSProperties)}
      />
      <Button type="button" variant="outline" size="icon" aria-label={shown ? "Hide the value" : "Show the value"} aria-pressed={shown} onClick={() => setShown((v) => !v)}>
        {shown ? <EyeOff /> : <Eye />}
      </Button>
    </div>
  );
}

/** "Pédagogie 1-8 = B2-104", one per line, as the aliases object the server takes. */
const aliasesToText = (a: Record<string, string>) => Object.entries(a).map(([place, room]) => `${place} = ${room}`).join("\n");
function textToAliases(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.lastIndexOf("=");
    if (at > 0 && line.slice(at + 1).trim()) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

/** Portals the campus reads events from (ENT, student portals, administration systems). Events become reservations and busy statuses. */
export function IntegrationsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const plugins = useFetch<{ items: Plugin[] }>("/integrations/plugins");
  const list = useFetch<{ items: Integration[] }>("/integrations");
  // Fixed for as long as the page is open: a time that moved with every render would change the address, and the list would reload (and flash) again and again.
  const since = useMemo(() => new Date().toISOString(), []);
  const events = useFetch<Page<CampusEvent>>(`/integrations/events?limit=100&status=active&from=${encodeURIComponent(since)}`);
  const [editing, setEditing] = useState<Integration | "new" | null>(null);
  const [placesOf, setPlacesOf] = useState<Integration | null>(null);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reloadAll = () => {
    list.reload();
    events.reload();
  };

  async function syncNow(i: Integration) {
    setSyncing(i.id);
    setError(null);
    try {
      await api(`/integrations/${i.id}/sync`, { method: "POST" });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not read the portal");
    } finally {
      setSyncing(null);
      reloadAll();
    }
  }

  async function remove(i: Integration) {
    if (!confirm(`Remove “${i.name}”? Its events and the reservations they made are removed. Accounts it registered are kept.`)) return;
    setError(null);
    try {
      await api(`/integrations/${i.id}`, { method: "DELETE" });
      reloadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the integration");
    }
  }

  const name = (id: string) => list.data?.items.find((i) => i.id === id)?.name ?? "";

  return (
    <div>
      <PageHeader
        title="Integrations"
        description="Read the events of an ENT, a student portal or an administration system. Events in a room become reservations on the doors and screens, and the people they name show as busy while they are in one."
        actions={
          isAdmin && (
            <Button onClick={() => setEditing("new")} disabled={!plugins.data}>
              <Plus /> Add a portal
            </Button>
          )
        }
      />
      <ErrorText>{list.error ?? plugins.error ?? error}</ErrorText>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Portal</TableHead>
            <TableHead>Last reading</TableHead>
            <TableHead>What it brought</TableHead>
            <TableHead className="w-44" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.data?.items.map((i) => (
            <TableRow key={i.id}>
              <TableCell>
                <div className="flex items-center gap-3">
                  <PluginIcon id={i.plugin} className="size-8" />
                  <div>
                <div className="font-medium">{i.name}</div>
                <div className="text-xs text-muted-foreground">
                  {i.pluginLabel} · every {i.intervalMinutes} min · {i.horizonDays} days ahead {!i.enabled && <Badge variant="muted">Paused</Badge>}
                </div>
                  </div>
                </div>
              </TableCell>
              <TableCell>
                {i.lastStatus === "never" && <span className="text-muted-foreground">Not read yet</span>}
                {i.lastStatus === "ok" && <Badge>Working</Badge>}
                {i.lastStatus === "error" && <Badge variant="muted">Failed</Badge>}
                {i.lastSyncAt && <div className="mt-1 text-xs text-muted-foreground">{timeAgo(i.lastSyncAt)}</div>}
                {i.lastError && (
                  <p role="alert" className="mt-1 max-w-xs text-xs text-destructive">
                    {i.lastError}
                  </p>
                )}
              </TableCell>
              <TableCell className="text-sm">
                {i.lastSummary ? (
                  <>
                    <div>
                      {i.lastSummary.fetched} events · {i.lastSummary.reservations} reservations
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {i.lastSummary.linkedPeople} people linked · {i.lastSummary.registeredPeople} registered{i.lastSummary.createdRooms > 0 && ` · ${i.lastSummary.createdRooms} rooms created`}
                    </div>
                    {i.lastSummary.unmatchedLocations.length > 0 && (
                      <div className="mt-1 max-w-sm text-xs text-muted-foreground">
                        No room for: {i.lastSummary.unmatchedLocations.slice(0, 6).join(", ")}
                        {i.lastSummary.unmatchedLocations.length > 6 && ` and ${i.lastSummary.unmatchedLocations.length - 6} more`}.{" "}
                        <button type="button" className="text-primary underline underline-offset-2" onClick={() => setPlacesOf(i)}>
                          Match them to rooms
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  "—"
                )}
              </TableCell>
              <TableCell>
                {isAdmin && (
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" aria-label={`Read ${i.name} now`} title="Read now" disabled={syncing === i.id} onClick={() => void syncNow(i)}>
                      <RefreshCw className={syncing === i.id ? "animate-spin" : ""} />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Rooms of ${i.name}`} title="Match places to rooms" onClick={() => setPlacesOf(i)}>
                      <DoorOpen />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Edit ${i.name}`} title="Edit" onClick={() => setEditing(i)}>
                      <Pencil />
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Remove ${i.name}`} title="Remove" onClick={() => void remove(i)}>
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </TableCell>
            </TableRow>
          ))}
          {!list.loading && list.data?.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                <Plug className="mx-auto mb-2 size-6" /> No portal connected yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      <h2 className="mt-10 mb-3 flex items-center gap-2 text-lg font-semibold">
        <CalendarSync className="size-5" /> Coming up
      </h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Where</TableHead>
            <TableHead>People</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {events.data?.items.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap">
                {time(e.start)}
                <div className="text-xs text-muted-foreground">until {new Date(e.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</div>
              </TableCell>
              <TableCell>
                <div className="font-medium">{e.title}</div>
                <div className="text-xs text-muted-foreground">{name(e.integrationId)}</div>
              </TableCell>
              <TableCell>
                {e.locations.length === 0 ? "—" : e.locations.join(", ")}
                {e.locations.length > 0 && e.roomIds.length === 0 && <div className="text-xs text-muted-foreground">No matching room</div>}
              </TableCell>
              <TableCell className="text-sm">{e.people.length === 0 ? "—" : e.people.map((p) => p.name).join(", ")}</TableCell>
            </TableRow>
          ))}
          {!events.loading && events.data?.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                No upcoming event.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {placesOf && (
        <PlacesDialog
          integration={placesOf}
          canConfigure={isAdmin}
          onClose={() => {
            setPlacesOf(null);
            reloadAll();
          }}
        />
      )}
      {editing && plugins.data && (
        <EditDialog
          plugins={plugins.data.items}
          existing={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reloadAll();
          }}
        />
      )}
    </div>
  );
}

function EditDialog({ plugins, existing, onClose, onSaved }: { plugins: Plugin[]; existing: Integration | null; onClose: () => void; onSaved: () => void }) {
  const [pluginId, setPluginId] = useState(existing?.plugin ?? plugins[0]!.id);
  const plugin = plugins.find((p) => p.id === pluginId) ?? plugins[0]!;
  const [name, setName] = useState(existing?.name ?? "");
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(existing?.config ?? {}).map(([k, v]) => [k, String(v)])));
  const [enabled, setEnabled] = useState(existing?.enabled ?? true);
  const [interval, setIntervalMinutes] = useState(existing?.intervalMinutes ?? 15);
  const [horizon, setHorizon] = useState(existing?.horizonDays ?? 14);
  const [autoRegister, setAutoRegister] = useState(existing?.autoRegister ?? true);
  const [service, setService] = useState<Service | "">(existing?.registerService ?? "pedagogical");
  const [aliases, setAliases] = useState(aliasesToText(existing?.roomAliases ?? {}));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    // A secret left empty on an existing integration is kept as it is.
    const config = Object.fromEntries(Object.entries(values).filter(([, v]) => v !== ""));
    const body = { name, enabled, intervalMinutes: interval, horizonDays: horizon, autoRegister, registerService: service || null, roomAliases: textToAliases(aliases), config };
    try {
      if (existing) await api(`/integrations/${existing.id}`, { method: "PATCH", body });
      else await api("/integrations", { body: { plugin: pluginId, ...body } });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit “${existing.name}”` : "Add a portal"}</DialogTitle>
          <DialogDescription>{plugin.description}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          {!existing && (
            <fieldset>
              <legend className="mb-2 text-sm leading-none font-medium">Platform</legend>
              <div role="radiogroup" aria-label="Platform" className="grid gap-2 sm:grid-cols-2">
                {plugins.map((p) => (
                  <label key={p.id} className="flex cursor-pointer items-center gap-3 rounded-lg border p-3 text-sm transition-colors hover:bg-accent/40 has-[:checked]:border-primary/60 has-[:checked]:bg-accent/50 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/40">
                    <input type="radio" name="platform" className="sr-only" checked={p.id === pluginId} onChange={() => setPluginId(p.id)} />
                    <PluginIcon id={p.id} />
                    <span className="font-medium">{p.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <Field label="Name" htmlFor="i-name" hint="What it is called here.">
            <Input id="i-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Epitech MY, Marseille" />
          </Field>
          {plugin.fields.map((f) => {
            const isSet = existing?.secretsSet.includes(f.key);
            return (
              <Field key={f.key} label={f.label} htmlFor={`i-${f.key}`} hint={isSet ? "Already set and kept secret. Leave empty to keep it, or paste a new one to replace it." : f.help}>
                {f.secret ? (
                  <SecretInput id={`i-${f.key}`} required={f.required && !isSet} value={values[f.key] ?? ""} onChange={(v) => setValues((all) => ({ ...all, [f.key]: v }))} placeholder={isSet ? "Kept secret: paste a new one to replace it" : undefined} />
                ) : (
                  <Input id={`i-${f.key}`} type={f.type === "number" ? "number" : "text"} autoComplete="off" required={f.required} value={values[f.key] ?? ""} onChange={(e) => setValues((all) => ({ ...all, [f.key]: e.target.value }))} />
                )}
              </Field>
            );
          })}
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Read every" htmlFor="i-interval" hint="Minutes, 5 at least.">
              <Input id="i-interval" type="number" min={5} max={1440} required value={interval} onChange={(e) => setIntervalMinutes(Number(e.target.value))} />
            </Field>
            <Field label="Days ahead" htmlFor="i-horizon" hint="Counted from the start of today.">
              <Input id="i-horizon" type="number" min={1} max={90} required value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} />
            </Field>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Read this portal automatically
          </label>
          <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">People named by an event</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={autoRegister} onChange={(e) => setAutoRegister(e.target.checked)} />
              <span>
                Register someone who has an email and no account yet. They get no way to sign in, and are not registered from an event that names more than 10 people.
              </span>
            </label>
            <Field label="Show them on the Faculty screens under" htmlFor="i-service">
              <Select id="i-service" value={service} onChange={(e) => setService(e.target.value as Service | "")} disabled={!autoRegister}>
                <option value="">Not listed</option>
                {SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_LABEL[s]}
                  </option>
                ))}
              </Select>
            </Field>
          </fieldset>
          <Field label="Room aliases" htmlFor="i-aliases" hint="For a place the portal names differently from a room here, one per line: “Salle 8 = B2-104”. A room whose name or code is the same needs none.">
            <textarea id="i-aliases" rows={4} value={aliases} onChange={(e) => setAliases(e.target.value)} className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/40" />
          </Field>
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : existing ? "Save" : "Add portal"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Which room each place of the portal is. A place that matches no room by name or code is first: choose its room, make a room for
 * it, or say it is not a room at all. A choice applies at once to the events already read. The integration can also make the rooms
 * by itself whenever a reading finds a place with none.
 */
function PlacesDialog({ integration, canConfigure, onClose }: { integration: Integration; canConfigure: boolean; onClose: () => void }) {
  const places = useFetch<{ items: Place[] }>(`/integrations/${integration.id}/places`);
  const rooms = useFetch<Page<Room>>("/rooms?limit=200");
  const buildings = useFetch<{ items: Building[] }>("/buildings");
  const [rows, setRows] = useState<Place[] | null>(null);
  const [auto, setAuto] = useState(integration.autoCreateRooms);
  const [buildingId, setBuildingId] = useState(integration.autoCreateBuildingId ?? "");
  const [floor, setFloor] = useState(integration.autoCreateFloor);
  const [saved, setSaved] = useState(Boolean(integration.autoCreateBuildingId) || !integration.autoCreateRooms);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const shown = rows ?? places.data?.items ?? [];
  const roomList = rooms.data?.items ?? [];
  const buildingOf = (b: Building) => `${b.name}`;

  async function choose(place: string, body: object) {
    setBusy(place);
    setError(null);
    try {
      const r = await api<{ items: Place[] }>(`/integrations/${integration.id}/places`, { method: "PUT", body: { place, ...body } });
      setRows(r.items);
      rooms.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the choice");
    } finally {
      setBusy(null);
    }
  }

  async function saveAuto() {
    setError(null);
    try {
      await api(`/integrations/${integration.id}`, { method: "PATCH", body: { autoCreateRooms: auto, autoCreateBuildingId: buildingId || null, autoCreateFloor: floor } });
      setSaved(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Rooms of “{integration.name}”</DialogTitle>
          <DialogDescription>
            What the portal calls a place is matched to a room by its name or code. Settle the ones that are not: an event in a matched room appears on that room’s door and on the screens.
          </DialogDescription>
        </DialogHeader>

        {canConfigure ? (
          <fieldset className="flex flex-col gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">Missing rooms</legend>
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={auto} onChange={(e) => (setAuto(e.target.checked), setSaved(false))} />
              <span>Create a room automatically for each place that has none, at every reading</span>
            </label>
            <div className="grid gap-3 sm:grid-cols-[1fr_8rem_auto] sm:items-end">
              <Field label="In building" htmlFor="p-building" hint="Needed to create rooms, here or one by one below.">
                <Select id="p-building" value={buildingId} onChange={(e) => (setBuildingId(e.target.value), setSaved(false))}>
                  <option value="">Choose a building</option>
                  {buildings.data?.items.map((b) => (
                    <option key={b.id} value={b.id}>
                      {buildingOf(b)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Floor" htmlFor="p-floor">
                <Input id="p-floor" type="number" min={-10} max={200} value={floor} onChange={(e) => (setFloor(Number(e.target.value)), setSaved(false))} />
              </Field>
              <Button type="button" variant="outline" disabled={saved || (auto && !buildingId)} onClick={() => void saveAuto()}>
                {saved ? "Saved" : "Save"}
              </Button>
            </div>
          </fieldset>
        ) : (
          <p className="text-sm text-muted-foreground">
            {integration.autoCreateRooms ? "Missing rooms are created automatically." : "Missing rooms are not created automatically."} An administrator can change this.
          </p>
        )}
        <ErrorText>{error ?? places.error ?? rooms.error}</ErrorText>

        <div className="max-h-[50vh] overflow-y-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Place in the portal</TableHead>
                <TableHead>Room</TableHead>
                <TableHead className="w-44" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map((p) => (
                <TableRow key={p.place}>
                  <TableCell>
                    <div className="font-medium">{p.place}</div>
                    <div className="text-xs text-muted-foreground">
                      {p.events} event{p.events === 1 ? "" : "s"}
                    </div>
                  </TableCell>
                  <TableCell>
                    {p.state === "ignored" ? (
                      <Badge variant="muted">Not a room</Badge>
                    ) : (
                      <Select
                        aria-label={`Room for ${p.place}`}
                        value={p.roomId ?? ""}
                        disabled={busy === p.place || rooms.loading}
                        onChange={(e) => e.target.value && void choose(p.place, { action: "room", roomId: e.target.value })}
                      >
                        <option value="">{p.state === "none" ? "No room yet" : ""}</option>
                        {buildings.data?.items.map((b) => {
                          const inBuilding = roomList.filter((r) => r.building.id === b.id);
                          return (
                            inBuilding.length > 0 && (
                              <optgroup key={b.id} label={buildingOf(b)}>
                                {inBuilding.map((r) => (
                                  <option key={r.id} value={r.id}>
                                    {r.code}
                                    {r.name && r.name !== r.code ? ` — ${r.name}` : ""}
                                  </option>
                                ))}
                              </optgroup>
                            )
                          );
                        })}
                      </Select>
                    )}
                    {p.state === "room" && <div className="mt-1 text-xs text-muted-foreground">{p.via === "alias" ? "Chosen here" : "Same name or code"}</div>}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      {p.state === "none" && (
                        <Button type="button" variant="outline" size="sm" disabled={busy === p.place || !integration.autoCreateBuildingId && !buildingId} title={buildingId || integration.autoCreateBuildingId ? "Make a room with this name" : "Choose a building above first"} onClick={() => void createHere(p.place)}>
                          Create room
                        </Button>
                      )}
                      {p.state === "none" && (
                        <Button type="button" variant="ghost" size="sm" disabled={busy === p.place} onClick={() => void choose(p.place, { action: "ignore" })}>
                          Not a room
                        </Button>
                      )}
                      {(p.via === "alias" || p.state === "ignored") && (
                        <Button type="button" variant="ghost" size="sm" disabled={busy === p.place} onClick={() => void choose(p.place, { action: "clear" })}>
                          Reset
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {!places.loading && shown.length === 0 && (
                <TableRow>
                  <TableCell colSpan={3} className="py-8 text-center text-muted-foreground">
                    No place yet. Read the portal first.
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  /** Making a room needs the building to be saved on the integration first: it is where the server makes it. */
  async function createHere(place: string) {
    if (!saved || (buildingId && buildingId !== integration.autoCreateBuildingId && canConfigure)) await saveAuto();
    await choose(place, { action: "create" });
  }
}
