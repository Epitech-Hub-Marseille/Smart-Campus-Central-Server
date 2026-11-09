import { Newspaper, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { PriorityBadge } from "@/pages/AnnouncementsPage";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import {
  ANNOUNCE_PRIORITIES,
  FACULTY_MODES,
  FACULTY_SLIDES,
  MODE_LABEL,
  PRIORITY_LABEL,
  SERVICES,
  SERVICE_LABEL,
  SLIDE_LABEL,
  type Asset,
  type AnnouncePriority,
  type FacultyConfig,
  type FacultyDisplay,
  type NewsItem,
} from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

/** What Faculty screens show: the news feed, and how each screen rotates through its content. */
export function FacultyPage() {
  const news = useFetch<{ items: NewsItem[]; screenLimit: number }>("/faculty/news");
  const displays = useFetch<{ items: FacultyDisplay[] }>("/faculty/displays");
  const images = useFetch<{ items: Asset[] }>("/assets?kind=image");
  const [creating, setCreating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  async function remove(n: NewsItem) {
    if (!confirm(`Remove "${n.title}" from the Faculty screens?`)) return;
    setActionError(null);
    try {
      await api(`/faculty/news/${n.id}`, { method: "DELETE" });
      news.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Faculty screens"
        description="Campus news, staff availability and room reservations, rotating on the information screens."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New news item
          </Button>
        }
      />

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">News</h2>
        <p className="text-sm text-muted-foreground">
          Screens show the {news.data?.screenLimit ?? 8} most recent, important ones first. Expired items leave the screens by themselves.
        </p>
        <ErrorText>{news.error ?? actionError}</ErrorText>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>News</TableHead>
              <TableHead>Priority</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Expires</TableHead>
              <TableHead className="w-12" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {news.data?.items.map((n) => (
              <TableRow key={n.id}>
                <TableCell>
                  <div className="font-medium">{n.title}</div>
                  {n.text && <div className="max-w-md truncate text-xs text-muted-foreground">{n.text}</div>}
                </TableCell>
                <TableCell>
                  <PriorityBadge priority={n.priority} />
                </TableCell>
                <TableCell className="text-muted-foreground">{new Date(n.publishedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</TableCell>
                <TableCell>
                  {n.expired ? <Badge variant="muted">Expired</Badge> : n.expiresAt ? new Date(n.expiresAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : <span className="text-muted-foreground">Never</span>}
                </TableCell>
                <TableCell>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${n.title}`} onClick={() => void remove(n)}>
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {!news.loading && news.data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  <Newspaper className="mx-auto mb-2 size-6" /> No news yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">Screens</h2>
        <p className="text-sm text-muted-foreground">
          Staff appear once a service is set in the <Link to="/staff" className="text-primary underline-offset-4 hover:underline">staff directory</Link>; people update their own status from{" "}
          <Link to="/availability" className="text-primary underline-offset-4 hover:underline">Availability</Link>.
        </p>
        <ErrorText>{displays.error}</ErrorText>
        {displays.data?.items.length === 0 && <p className="text-sm text-muted-foreground">No Faculty display is enrolled yet. Approve one from the Devices page.</p>}
        {displays.data?.items.map((d) => (
          <DisplayCard key={d.id} display={d} images={images.data?.items ?? []} />
        ))}
      </section>

      {creating && (
        <NewsDialog
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            news.reload();
          }}
        />
      )}
    </div>
  );
}

function DisplayCard({ display, images }: { display: FacultyDisplay; images: Asset[] }) {
  const [draft, setDraft] = useState<FacultyConfig>(display.config);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setDraft(display.config), [display.config]);

  const dirty = JSON.stringify(draft) !== JSON.stringify(display.config);
  const setSite = (patch: Partial<FacultyConfig["site"]>) => setDraft((d) => ({ ...d, site: { ...d.site, ...patch } }));
  const slides = draft.carousel.slides;
  const toggleSlide = (slide: (typeof FACULTY_SLIDES)[number], on: boolean) =>
    setDraft({ ...draft, carousel: { ...draft.carousel, slides: FACULTY_SLIDES.filter((s) => (s === slide ? on : slides.includes(s))) } });

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (slides.length === 0) return setError("Keep at least one slide");
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await api(`/faculty/displays/${display.id}/config`, { method: "PUT", body: draft });
      setNotice(display.online ? "Sent to the screen." : "Saved. The screen is offline and will apply it when it reconnects.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  const weather = draft.weather ?? { label: "", latitude: 0, longitude: 0 };
  const id = (name: string) => `fd-${display.id}-${name}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {display.name}
          <Badge variant={display.online ? "default" : "muted"}>{display.online ? "Online" : "Offline"}</Badge>
        </CardTitle>
        <CardDescription>Which content rotates, how fast, and which widgets frame it.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="What the screen shows" htmlFor={id("mode")} hint="Custom content is managed on the Custom content page. With no slide to show, the screen shows the information board rather than stay blank.">
            <Select id={id("mode")} value={draft.mode} onChange={(e) => setDraft({ ...draft, mode: e.target.value as FacultyConfig["mode"] })}>
              {FACULTY_MODES.map((m) => (
                <option key={m} value={m}>
                  {MODE_LABEL[m]}
                </option>
              ))}
            </Select>
          </Field>

          <fieldset className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
            <legend className="px-1 text-sm font-medium">Site</legend>
            <Field label="Name" htmlFor={id("site-name")} hint="Shown in the header, for example “Faculty of Engineering”.">
              <Input id={id("site-name")} maxLength={80} value={draft.site.name} onChange={(e) => setSite({ name: e.target.value })} />
            </Field>
            <Field label="Subtitle" htmlFor={id("site-sub")} hint="For example the information desk and its phone number.">
              <Input id={id("site-sub")} maxLength={120} value={draft.site.subtitle} onChange={(e) => setSite({ subtitle: e.target.value })} />
            </Field>
            <Field label="Logo" htmlFor={id("site-logo")} hint="An image of the library (upload it on the Custom content page).">
              <Select
                id={id("site-logo")}
                value={draft.site.logo?.assetId ?? ""}
                onChange={(e) => {
                  const image = images.find((a) => a.id === e.target.value);
                  setSite({ logo: image ? { assetId: image.id, sha256: image.sha256, size: image.size, mime: image.mime } : null });
                }}
              >
                <option value="">No logo</option>
                {images.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Building or zone" htmlFor={id("site-zone")} hint="Shown on the emergency screen.">
              <Input id={id("site-zone")} maxLength={60} value={draft.site.zone} onChange={(e) => setSite({ zone: e.target.value })} />
            </Field>
            <Field label="Assembly point" htmlFor={id("site-assembly")} hint="Where people go when the building is evacuated.">
              <Input id={id("site-assembly")} maxLength={80} value={draft.site.assemblyPoint} onChange={(e) => setSite({ assemblyPoint: e.target.value })} />
            </Field>
            <Field label="Emergency services number" htmlFor={id("site-number")} hint="Shown on the emergency screen.">
              <Input id={id("site-number")} maxLength={30} inputMode="tel" value={draft.site.emergencyNumber} onChange={(e) => setSite({ emergencyNumber: e.target.value })} />
            </Field>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Staff shown" htmlFor={id("service")} hint="A screen at the teaching office can show only the pedagogical staff.">
              <Select id={id("service")} value={draft.service} onChange={(e) => setDraft({ ...draft, service: e.target.value as FacultyConfig["service"] })}>
                <option value="all">Every service</option>
                {SERVICES.map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_LABEL[s]} only
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Seconds per slide" htmlFor={id("interval")}>
              <Input
                id={id("interval")}
                type="number"
                min={5}
                max={120}
                value={draft.carousel.intervalSeconds}
                disabled={!draft.carousel.enabled}
                onChange={(e) => setDraft({ ...draft, carousel: { ...draft.carousel, intervalSeconds: Number(e.target.value) } })}
              />
            </Field>
          </div>

          <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
            <legend className="mb-1 text-sm font-medium">Carousel</legend>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary" checked={draft.carousel.enabled} onChange={(e) => setDraft({ ...draft, carousel: { ...draft.carousel, enabled: e.target.checked } })} />
              Rotate automatically
            </label>
            {FACULTY_SLIDES.map((slide) => (
              <label key={slide} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="accent-primary" checked={slides.includes(slide)} onChange={(e) => toggleSlide(slide, e.target.checked)} />
                {SLIDE_LABEL[slide]}
              </label>
            ))}
          </fieldset>

          <fieldset className="flex flex-wrap gap-x-5 gap-y-2">
            <legend className="mb-1 text-sm font-medium">Widgets</legend>
            {(["clock", "date", "weather"] as const).map((w) => (
              <label key={w} className="flex items-center gap-2 text-sm capitalize">
                <input
                  type="checkbox"
                  className="accent-primary"
                  checked={draft.widgets[w]}
                  onChange={(e) => setDraft({ ...draft, widgets: { ...draft.widgets, [w]: e.target.checked }, ...(w === "weather" && e.target.checked && !draft.weather && { weather: weather }) })}
                />
                {w}
              </label>
            ))}
          </fieldset>

          {draft.widgets.weather && (
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Place name" htmlFor={id("wlabel")}>
                <Input id={id("wlabel")} maxLength={60} value={weather.label} onChange={(e) => setDraft({ ...draft, weather: { ...weather, label: e.target.value } })} />
              </Field>
              <Field label="Latitude" htmlFor={id("wlat")}>
                <Input id={id("wlat")} type="number" step="any" min={-90} max={90} required value={weather.latitude} onChange={(e) => setDraft({ ...draft, weather: { ...weather, latitude: Number(e.target.value) } })} />
              </Field>
              <Field label="Longitude" htmlFor={id("wlon")}>
                <Input id={id("wlon")} type="number" step="any" min={-180} max={180} required value={weather.longitude} onChange={(e) => setDraft({ ...draft, weather: { ...weather, longitude: Number(e.target.value) } })} />
              </Field>
            </div>
          )}

          <ErrorText>{error}</ErrorText>
          {notice && <p role="status" className="text-sm text-primary">{notice}</p>}
          <div>
            <Button type="submit" disabled={busy || !dirty}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);

function NewsDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [form, setForm] = useState({ title: "", text: "", priority: "info" as AnnouncePriority, expires: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/faculty/news", { body: { title: form.title, text: form.text, priority: form.priority, expiresAt: toIso(form.expires) } });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not publish");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New news item</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Title" htmlFor="n-title">
            <Input id="n-title" required maxLength={120} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Text (optional)" htmlFor="n-text" hint={`${form.text.length} / 400. Screens are read from a distance: keep it short.`}>
            <textarea
              id="n-text"
              rows={3}
              maxLength={400}
              value={form.text}
              onChange={(e) => setForm({ ...form, text: e.target.value })}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Priority" htmlFor="n-priority" hint="Important and urgent items come first.">
              <Select id="n-priority" value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as AnnouncePriority })}>
                {ANNOUNCE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Expires (optional)" htmlFor="n-expires">
              <Input id="n-expires" type="datetime-local" value={form.expires} onChange={(e) => setForm({ ...form, expires: e.target.value })} />
            </Field>
          </div>
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Publishing…" : "Publish"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
