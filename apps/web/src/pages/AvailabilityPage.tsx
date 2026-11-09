import { UserCheck } from "lucide-react";
import { useState, type FormEvent } from "react";
import { canEditCampus, useAuth } from "@/auth/AuthContext";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import {
  AVAILABILITIES,
  AVAILABILITY_COLOR,
  AVAILABILITY_LABEL,
  SERVICES,
  SERVICE_LABEL,
  toLocalInput,
  type Availability,
  type Service,
  type StaffAvailability,
} from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

/** A coloured dot and the word: colour alone would not tell anything to someone who cannot see it. */
export function AvailabilityBadge({ value }: { value: Availability }) {
  const color = AVAILABILITY_COLOR[value];
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
      style={{ color, borderColor: `${color}66`, backgroundColor: `${color}1a` }}
    >
      <span className="size-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {AVAILABILITY_LABEL[value]}
    </span>
  );
}

/** Who is reachable right now, as the Faculty screens show it. Everyone updates their own line. */
export function AvailabilityPage() {
  const { user } = useAuth();
  const manager = user ? canEditCampus(user) : false;
  const [service, setService] = useState<"" | Service>("");
  const me = useFetch<{ listed: boolean } & Partial<StaffAvailability>>("/faculty/availability/me");
  const list = useFetch<{ items: StaffAvailability[]; screenLimit: number }>(`/faculty/staff${service ? `?service=${service}` : ""}`);
  const [editing, setEditing] = useState<StaffAvailability | null>(null);

  const reload = () => {
    me.reload();
    list.reload();
  };

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title="Availability" description="Let colleagues and visitors know whether you can be reached. It shows live on the Faculty screens." />

      <Card>
        <CardHeader>
          <CardTitle>My availability</CardTitle>
          <CardDescription>
            {me.data && !me.data.listed
              ? "You are not listed on the Faculty screens. Ask an administrator to assign you a service."
              : "Choose your status. A note and an end time are optional: when the end time passes you show as available again."}
          </CardDescription>
        </CardHeader>
        {me.data?.listed && (
          <CardContent>
            <AvailabilityForm
              key={`${me.data.availability}-${me.data.note}-${me.data.until}`}
              endpoint="/faculty/availability/me"
              initial={me.data as StaffAvailability}
              onSaved={reload}
            />
          </CardContent>
        )}
      </Card>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold">Staff</h2>
          <Select aria-label="Filter by service" value={service} onChange={(e) => setService(e.target.value as "" | Service)} className="w-52">
            <option value="">Every service</option>
            {SERVICES.map((s) => (
              <option key={s} value={s}>
                {SERVICE_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
        <ErrorText>{list.error}</ErrorText>
        {list.data && list.data.items.length > list.data.screenLimit && (
          <p className="text-sm text-muted-foreground">Screens show the first {list.data.screenLimit} by name. Dedicate a screen to one service to list more people.</p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Service</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Note</TableHead>
              {manager && <TableHead className="w-20" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {list.data?.items.map((p) => (
              <TableRow key={p.id}>
                <TableCell>
                  <div className="font-medium">{p.name}</div>
                  {p.jobTitle && <div className="text-xs text-muted-foreground">{p.jobTitle}</div>}
                </TableCell>
                <TableCell>{p.service && <Badge variant="muted">{SERVICE_LABEL[p.service]}</Badge>}</TableCell>
                <TableCell>
                  <AvailabilityBadge value={p.availability} />
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {p.note}
                  {p.until && <span> until {new Date(p.until).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>}
                </TableCell>
                {manager && (
                  <TableCell>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(p)}>
                      Set
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {!list.loading && list.data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={manager ? 5 : 4} className="py-10 text-center text-muted-foreground">
                  <UserCheck className="mx-auto mb-2 size-6" /> Nobody is listed yet. Assign a service to people in the staff directory.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>

      {editing && (
        <Dialog open onOpenChange={(open) => !open && setEditing(null)}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Availability of {editing.name}</DialogTitle>
            </DialogHeader>
            <AvailabilityForm
              endpoint={`/faculty/availability/${editing.id}`}
              initial={editing}
              onSaved={() => {
                setEditing(null);
                reload();
              }}
            />
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

function AvailabilityForm({ endpoint, initial, onSaved }: { endpoint: string; initial: StaffAvailability; onSaved: () => void }) {
  const [status, setStatus] = useState<Availability>(initial.availability);
  const [note, setNote] = useState(initial.note);
  const [until, setUntil] = useState(initial.until ? toLocalInput(new Date(initial.until)) : "");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const available = status === "available";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api(endpoint, { method: "PUT", body: { status, note: available ? "" : note, until: !available && until ? new Date(until).toISOString() : null } });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div role="radiogroup" aria-label="Status" className="flex flex-wrap gap-2">
        {AVAILABILITIES.map((a) => (
          <button
            key={a}
            type="button"
            role="radio"
            aria-checked={a === status}
            onClick={() => setStatus(a)}
            className="flex items-center gap-2 rounded-lg border px-3 py-2 text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 aria-checked:bg-accent aria-checked:font-medium"
            style={a === status ? { borderColor: AVAILABILITY_COLOR[a] } : undefined}
          >
            <span className="size-2.5 rounded-full" style={{ backgroundColor: AVAILABILITY_COLOR[a] }} aria-hidden />
            {AVAILABILITY_LABEL[a]}
          </button>
        ))}
      </div>
      {!available && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Note (optional)" htmlFor="av-note" hint="Shown next to your name, for example “Back after lunch”.">
            <Input id="av-note" maxLength={60} value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
          <Field label="Until (optional)" htmlFor="av-until" hint="Empty: stays until you change it.">
            <Input id="av-until" type="datetime-local" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
        </div>
      )}
      <ErrorText>{error}</ErrorText>
      {saved && <p role="status" className="text-sm text-primary">Saved.</p>}
      <div>
        <Button type="submit" disabled={busy}>
          {busy ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
