import { CalendarClock, Pause, Play, Plus, Trash2, Zap } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { TemplatePicker } from "@/components/TemplatePicker";
import { emptyTargetState, TargetPicker, toTargets, type TargetState } from "@/components/TargetPicker";
import { VoicePicker } from "@/components/VoiceAnnouncement";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import {
  ANNOUNCE_PRIORITIES,
  PRIORITY_LABEL,
  WEEKDAYS,
  describeTrigger,
  timeAgo,
  toLocalInput,
  type AnnouncePriority,
  type Page,
  type Room,
  type RoomStatusDef,
  type Schedule,
  type VoiceCatalogue,
} from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

/** Announcements that send themselves: at a date, every day or week, or when a room changes status. */
export function SchedulesPage() {
  const list = useFetch<{ items: Schedule[] }>("/schedules");
  const statuses = useFetch<{ items: RoomStatusDef[] }>("/room-statuses");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const statusLabel = (key: string) => statuses.data?.items.find((s) => s.key === key)?.label ?? key;

  async function run(fn: () => Promise<unknown>, done?: string) {
    setActionError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    }
    list.reload();
  }

  return (
    <div>
      <PageHeader
        title="Schedules"
        description="Announcements that send themselves. Times follow the campus time zone. A run that the server missed by more than ten minutes is skipped, not sent late."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New schedule
          </Button>
        }
      />
      <ErrorText>{list.error ?? actionError}</ErrorText>
      {notice && <p role="status" className="mb-3 text-sm text-primary">{notice}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Schedule</TableHead>
            <TableHead>When</TableHead>
            <TableHead>Next run</TableHead>
            <TableHead>Last run</TableHead>
            <TableHead className="w-36" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.data?.items.map((s) => (
            <TableRow key={s.id}>
              <TableCell>
                <div className="font-medium">{s.name}</div>
                <div className="max-w-xs truncate text-xs text-muted-foreground">
                  {s.content.kind === "voice" ? "Voice: " : ""}
                  {s.content.text}
                </div>
              </TableCell>
              <TableCell className="text-muted-foreground">{describeTrigger(s.trigger, statusLabel)}</TableCell>
              <TableCell>
                {!s.enabled ? (
                  <Badge variant="muted">Paused</Badge>
                ) : s.nextRunAt ? (
                  new Date(s.nextRunAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
                ) : s.trigger.type === "status" ? (
                  <span className="text-muted-foreground">On status change</span>
                ) : (
                  <Badge variant="muted">Done</Badge>
                )}
              </TableCell>
              <TableCell>
                {s.lastRunAt ? <span className="text-muted-foreground">{timeAgo(s.lastRunAt)}, {s.runCount} run{s.runCount === 1 ? "" : "s"}</span> : <span className="text-muted-foreground">Never</span>}
                {s.lastError && <div className="max-w-xs text-xs text-destructive">{s.lastError}</div>}
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  {s.targets && (
                    <Button variant="ghost" size="icon" aria-label={`Run ${s.name} now`} title="Run now" onClick={() => void run(() => api(`/schedules/${s.id}/run`, { method: "POST", body: {} }), "Sent.")}>
                      <Zap />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={s.enabled ? `Pause ${s.name}` : `Resume ${s.name}`}
                    title={s.enabled ? "Pause" : "Resume"}
                    onClick={() => void run(() => api(`/schedules/${s.id}`, { method: "PATCH", body: { enabled: !s.enabled } }))}
                  >
                    {s.enabled ? <Pause /> : <Play />}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${s.name}`}
                    onClick={() => confirm(`Delete the schedule "${s.name}"?`) && void run(() => api(`/schedules/${s.id}`, { method: "DELETE" }))}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {!list.loading && list.data?.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                <CalendarClock className="mx-auto mb-2 size-6" /> No schedule yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {creating && (
        <ScheduleDialog
          statuses={statuses.data?.items ?? []}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

type TriggerKind = "once" | "daily" | "weekly" | "status";

function ScheduleDialog({ statuses, onClose, onSaved }: { statuses: RoomStatusDef[]; onClose: () => void; onSaved: () => void }) {
  const voices = useFetch<VoiceCatalogue>("/intercom/voices");
  const rooms = useFetch<Page<Room>>("/rooms?limit=200");

  const [name, setName] = useState("");
  const [kind, setKind] = useState<"text" | "voice">("text");
  const [content, setContent] = useState({ title: "", text: "", priority: "info" as AnnouncePriority, expires: "" });
  const [choice, setChoice] = useState({ language: "", voice: "" });
  const [trigger, setTrigger] = useState<TriggerKind>("daily");
  const [when, setWhen] = useState({ at: toLocalInput(new Date(Date.now() + 3_600_000)), time: "08:00", days: [1, 2, 3, 4, 5], status: "closed", roomId: "" });
  const [roomScreens, setRoomScreens] = useState(true);
  const [targets, setTargets] = useState<TargetState>(emptyTargetState());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const catalogue = voices.data?.enabled ? voices.data : null;
  const picked = choice.voice || catalogue?.voices[0]?.id || "";
  const pickedLanguage = choice.language || catalogue?.voices[0]?.language || "";
  const status = trigger === "status";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const chosen = status && roomScreens ? undefined : toTargets(targets);
    if (!chosen && !(status && roomScreens)) return setError("Choose where to send it");
    if (trigger === "weekly" && when.days.length === 0) return setError("Choose at least one day");

    const triggerBody =
      trigger === "once"
        ? { type: "once", at: new Date(when.at).toISOString() }
        : trigger === "daily"
          ? { type: "daily", time: when.time }
          : trigger === "weekly"
            ? { type: "weekly", time: when.time, days: when.days }
            : { type: "status", status: when.status, ...(when.roomId && { roomId: when.roomId }) };

    setBusy(true);
    setError(null);
    try {
      await api("/schedules", {
        body: {
          name,
          content:
            kind === "voice"
              ? { kind, text: content.text, voice: picked }
              : { kind, title: content.title, text: content.text, priority: content.priority, ...(content.expires && { expiresAfterMinutes: Number(content.expires) }) },
          trigger: triggerBody,
          ...(chosen && { targets: chosen }),
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the schedule");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New schedule</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Name" htmlFor="sc-name">
            <Input id="sc-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>

          <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">What to announce</legend>
            <Field label="Type" htmlFor="sc-kind">
              <Select id="sc-kind" value={kind} onChange={(e) => setKind(e.target.value as "text" | "voice")}>
                <option value="text">A message on the screens</option>
                {catalogue && <option value="voice">A voice on the speakers</option>}
              </Select>
            </Field>
            <TemplatePicker
              id="sc-template"
              kind={kind}
              onPick={(t) => {
                setContent((c) => ({ ...c, title: t.title, text: t.text, priority: t.priority }));
                const known = catalogue?.voices.find((v) => v.id === t.voice);
                if (known) setChoice({ language: known.language, voice: known.id });
              }}
            />
            {kind === "text" && (
              <Field label="Title (optional)" htmlFor="sc-title">
                <Input id="sc-title" maxLength={200} value={content.title} onChange={(e) => setContent({ ...content, title: e.target.value })} />
              </Field>
            )}
            <Field label="Message" htmlFor="sc-text">
              <textarea
                id="sc-text"
                required
                rows={3}
                maxLength={kind === "voice" ? 1000 : 2000}
                value={content.text}
                onChange={(e) => setContent({ ...content, text: e.target.value })}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </Field>
            {kind === "text" ? (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Priority" htmlFor="sc-priority">
                  <Select id="sc-priority" value={content.priority} onChange={(e) => setContent({ ...content, priority: e.target.value as AnnouncePriority })}>
                    {ANNOUNCE_PRIORITIES.map((p) => (
                      <option key={p} value={p}>
                        {PRIORITY_LABEL[p]}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Stays for (minutes, optional)" htmlFor="sc-expires" hint="Empty: until cancelled.">
                  <Input id="sc-expires" type="number" min={1} max={10080} value={content.expires} onChange={(e) => setContent({ ...content, expires: e.target.value })} />
                </Field>
              </div>
            ) : (
              catalogue && <VoicePicker idPrefix="sc" catalogue={catalogue} language={pickedLanguage} voice={picked} onChange={setChoice} />
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">When</legend>
            <Field label="Trigger" htmlFor="sc-trigger">
              <Select id="sc-trigger" value={trigger} onChange={(e) => setTrigger(e.target.value as TriggerKind)}>
                <option value="once">Once, at a date and time</option>
                <option value="daily">Every day</option>
                <option value="weekly">Every week, on chosen days</option>
                <option value="status">When a room changes status</option>
              </Select>
            </Field>
            {trigger === "once" && (
              <Field label="Date and time" htmlFor="sc-at">
                <Input id="sc-at" type="datetime-local" required value={when.at} onChange={(e) => setWhen({ ...when, at: e.target.value })} />
              </Field>
            )}
            {(trigger === "daily" || trigger === "weekly") && (
              <Field label="Time" htmlFor="sc-time">
                <Input id="sc-time" type="time" required value={when.time} onChange={(e) => setWhen({ ...when, time: e.target.value })} className="max-w-40" />
              </Field>
            )}
            {trigger === "weekly" && (
              <fieldset className="flex flex-wrap gap-x-4 gap-y-2">
                <legend className="mb-1 text-sm font-medium">Days</legend>
                {WEEKDAYS.map((day, i) => (
                  <label key={day} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="accent-primary"
                      checked={when.days.includes(i)}
                      onChange={(e) => setWhen({ ...when, days: e.target.checked ? [...when.days, i] : when.days.filter((d) => d !== i) })}
                    />
                    {day}
                  </label>
                ))}
              </fieldset>
            )}
            {status && (
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Status" htmlFor="sc-status">
                  <Select id="sc-status" value={when.status} onChange={(e) => setWhen({ ...when, status: e.target.value })}>
                    {statuses.map((s) => (
                      <option key={s.key} value={s.key}>
                        {s.label}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label="Room" htmlFor="sc-room">
                  <Select id="sc-room" value={when.roomId} onChange={(e) => setWhen({ ...when, roomId: e.target.value })}>
                    <option value="">Any room</option>
                    {rooms.data?.items.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.building.code} {r.code}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
            )}
          </fieldset>

          <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Where</legend>
            {status && (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary" checked={roomScreens} onChange={(e) => setRoomScreens(e.target.checked)} />
                Only the screens of the room that changed
              </label>
            )}
            {!(status && roomScreens) && <TargetPicker value={targets} onChange={setTargets} />}
          </fieldset>

          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Create schedule"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
