import { CalendarDays, Plus, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { canEditCampus, useAuth } from "@/auth/AuthContext";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { toLocalInput, type Page, type Reservation, type Room } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const dayLabel = (iso: string) => new Date(iso).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
const roomLabel = (r: Reservation["room"]) => (r ? [r.building, r.name || r.code].filter(Boolean).join(" · ") : "Unknown room");

/** Book a room and see what is booked. Bookings show on the door screen of the room and on the Faculty screens. */
export function ReservationsPage() {
  const { user } = useAuth();
  const manager = user ? canEditCampus(user) : false;
  const [room, setRoom] = useState("");
  const [mine, setMine] = useState(false);
  // Reservations that have not ended yet. Rounded to the minute so the request key stays stable between renders.
  const from = useMemo(() => new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString(), []);
  const params = new URLSearchParams({ limit: "200", from });
  if (room) params.set("room", room);
  if (mine) params.set("mine", "true");

  const rooms = useFetch<Page<Room>>("/rooms?limit=200");
  const list = useFetch<Page<Reservation>>(`/reservations?${params}`);
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function cancel(r: Reservation) {
    if (!confirm(`Cancel "${r.title}" on ${dayLabel(r.start)}, ${time(r.start)}?`)) return;
    setActionError(null);
    try {
      await api(`/reservations/${r.id}`, { method: "DELETE" });
      list.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Cancel failed");
    }
  }

  const days = useMemo(() => {
    const groups = new Map<string, Reservation[]>();
    for (const r of list.data?.items ?? []) {
      const key = dayLabel(r.start);
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    return [...groups];
  }, [list.data]);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Reservations"
        description="Book a room for a class or a meeting. The door screen shows the next booking, and Faculty screens list the day."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> Book a room
          </Button>
        }
      />

      <div className="flex flex-wrap items-center gap-4">
        <Select aria-label="Filter by room" value={room} onChange={(e) => setRoom(e.target.value)} className="w-64">
          <option value="">Every room</option>
          {rooms.data?.items.map((r) => (
            <option key={r.id} value={r.id}>
              {r.building.code} {r.code}
              {r.name ? ` – ${r.name}` : ""}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="accent-primary" checked={mine} onChange={(e) => setMine(e.target.checked)} />
          Only mine
        </label>
      </div>

      <ErrorText>{list.error ?? actionError}</ErrorText>

      {days.map(([day, items]) => (
        <section key={day} className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted-foreground capitalize">{day}</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">Time</TableHead>
                <TableHead>Room</TableHead>
                <TableHead>Booking</TableHead>
                <TableHead>Booked by</TableHead>
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-mono text-sm">
                    {time(r.start)} – {time(r.end)}
                  </TableCell>
                  <TableCell>{roomLabel(r.room)}</TableCell>
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell className="text-muted-foreground">{r.organizer}</TableCell>
                  <TableCell>
                    {(manager || r.organizerId === user?.id) && (
                      <Button variant="ghost" size="icon" aria-label={`Cancel ${r.title}`} onClick={() => void cancel(r)}>
                        <X />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ))}
      {!list.loading && days.length === 0 && (
        <div className="rounded-xl border py-12 text-center text-muted-foreground">
          <CalendarDays className="mx-auto mb-2 size-6" /> Nothing is booked.
        </div>
      )}

      {creating && (
        <BookingDialog
          rooms={rooms.data?.items ?? []}
          initialRoom={room}
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

function BookingDialog({ rooms, initialRoom, onClose, onSaved }: { rooms: Room[]; initialRoom: string; onClose: () => void; onSaved: () => void }) {
  // Next full hour, for one hour: the most common booking, and a valid one.
  const start = useMemo(() => {
    const d = new Date();
    d.setMinutes(0, 0, 0);
    d.setHours(d.getHours() + 1);
    return d;
  }, []);
  const [form, setForm] = useState({ roomId: initialRoom, title: "", start: toLocalInput(start), end: toLocalInput(new Date(start.getTime() + 3_600_000)) });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/reservations", { body: { roomId: form.roomId, title: form.title, start: new Date(form.start).toISOString(), end: new Date(form.end).toISOString() } });
      onSaved();
    } catch (err) {
      // A conflict names what is in the way ("already booked: "Exam" 10:00-12:00"), so it is shown as is.
      setError(err instanceof Error ? err.message : "Could not book the room");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Book a room</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Room" htmlFor="r-room">
            <Select id="r-room" required value={form.roomId} onChange={(e) => setForm({ ...form, roomId: e.target.value })}>
              <option value="">Choose a room…</option>
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.building.code} {r.code}
                  {r.name ? ` – ${r.name}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Title" htmlFor="r-title" hint="What the door screen shows, for example the course or the meeting.">
            <Input id="r-title" required maxLength={100} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From" htmlFor="r-start">
              <Input id="r-start" type="datetime-local" required value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} />
            </Field>
            <Field label="To" htmlFor="r-end">
              <Input id="r-end" type="datetime-local" required value={form.end} min={form.start} onChange={(e) => setForm({ ...form, end: e.target.value })} />
            </Field>
          </div>
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Booking…" : "Book"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
