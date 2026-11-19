import { Globe, Image as ImageIcon, Pause, Pencil, Play, Plus, Trash2, Type, Upload, Video } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { emptyTargetState, TargetPicker, toTargets, type TargetState } from "@/components/TargetPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { CONTENT_KINDS, CONTENT_KIND_LABEL, formatBytes, toLocalInput, type Asset, type ContentKind, type ContentSlide, type Targets } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

const KIND_ICON = { image: ImageIcon, video: Video, text: Type, web: Globe } as const;
const STATE_LABEL = { live: "Showing", scheduled: "Scheduled", over: "Over", paused: "Paused" } as const;

const toIso = (local: string) => (local ? new Date(local).toISOString() : undefined);

/** Whom a slide is for, in a few words. */
function describeTargets(t: Targets): string {
  if (t.all) return "Every screen";
  const parts = [t.devices?.length && `${t.devices.length} device(s)`, t.groups?.length && `groups ${t.groups.join(", ")}`, t.buildings?.length && `${t.buildings.length} building(s)`, t.floors?.length && `${t.floors.length} floor(s)`].filter(Boolean);
  return parts.join(", ") || "Nobody";
}

/** Slides for the Faculty screens: uploaded images and videos, texts and live web pages, with a schedule and a target. */
export function ContentPage() {
  const slides = useFetch<{ items: ContentSlide[] }>("/content");
  const images = useFetch<{ items: Asset[] }>("/assets?kind=image");
  const videos = useFetch<{ items: Asset[] }>("/assets?kind=video");
  const [editing, setEditing] = useState<ContentSlide | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const files = [...(images.data?.items ?? []), ...(videos.data?.items ?? [])];
  const fileName = (id: string | null) => files.find((f) => f.id === id)?.name ?? "A file";

  async function run(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
      slides.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Action failed");
    }
  }

  const toggle = (s: ContentSlide) =>
    run(() => api(`/content/${s.id}`, { method: "PUT", body: bodyOf(s, { enabled: !s.enabled }) }));

  return (
    <div>
      <PageHeader
        title="Custom content"
        description="Images, videos, texts and web pages for the Faculty screens. A screen shows them according to its mode (Faculty screens page), and applies each slide's dates by itself, even offline."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus /> New slide
          </Button>
        }
      />
      <ErrorText>{slides.error ?? actionError}</ErrorText>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Slide</TableHead>
            <TableHead>For</TableHead>
            <TableHead>Shown for</TableHead>
            <TableHead>Window</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="w-32" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {slides.data?.items.map((s) => {
            const Icon = KIND_ICON[s.kind];
            return (
              <TableRow key={s.id}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                    <div className="min-w-0">
                      <div className="truncate font-medium">{s.title || (s.kind === "text" ? s.text : s.kind === "web" ? s.url : fileName(s.assetId))}</div>
                      <div className="text-xs text-muted-foreground">{CONTENT_KIND_LABEL[s.kind]}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {describeTargets(s.targets)}
                  <div className="text-xs">{s.displayCount} Faculty screen{s.displayCount === 1 ? "" : "s"}</div>
                </TableCell>
                <TableCell className="text-muted-foreground">{s.durationSeconds} s</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {s.startsAt ? `from ${new Date(s.startsAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}` : "from now"}
                  <br />
                  {s.endsAt ? `until ${new Date(s.endsAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}` : "no end"}
                </TableCell>
                <TableCell>
                  <Badge variant={s.state === "live" ? "default" : "muted"}>{STATE_LABEL[s.state]}</Badge>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-1">
                    <Button variant="ghost" size="icon" aria-label={s.enabled ? `Pause ${s.title || "slide"}` : `Resume ${s.title || "slide"}`} onClick={() => void toggle(s)}>
                      {s.enabled ? <Pause /> : <Play />}
                    </Button>
                    <Button variant="ghost" size="icon" aria-label={`Edit ${s.title || "slide"}`} onClick={() => setEditing(s)}>
                      <Pencil />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${s.title || "slide"}`}
                      onClick={() => confirm("Remove this slide from the screens?") && void run(() => api(`/content/${s.id}`, { method: "DELETE" }))}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
          {!slides.loading && slides.data?.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                <ImageIcon className="mx-auto mb-2 size-6" /> No custom content yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {editing && (
        <SlideDialog
          slide={editing === "new" ? null : editing}
          images={images.data?.items ?? []}
          videos={videos.data?.items ?? []}
          onUploaded={() => {
            images.reload();
            videos.reload();
          }}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            slides.reload();
          }}
        />
      )}
    </div>
  );
}

/** The API body of a slide, with some fields changed. */
function bodyOf(s: ContentSlide, patch: Record<string, unknown> = {}) {
  return {
    kind: s.kind,
    title: s.title,
    ...(s.text && { text: s.text }),
    ...(s.url && { url: s.url }),
    ...(s.refreshSeconds && { refreshSeconds: s.refreshSeconds }),
    ...(s.assetId && { assetId: s.assetId }),
    durationSeconds: s.durationSeconds,
    fit: s.fit,
    ...(s.startsAt && { startsAt: s.startsAt }),
    ...(s.endsAt && { endsAt: s.endsAt }),
    targets: { ...(s.targets.all && { all: true }), ...(s.targets.devices?.length && { devices: s.targets.devices }), ...(s.targets.groups?.length && { groups: s.targets.groups }), ...(s.targets.buildings?.length && { buildings: s.targets.buildings }), ...(s.targets.floors?.length && { floors: s.targets.floors }) },
    enabled: s.enabled,
    ...patch,
  };
}

function SlideDialog({
  slide,
  images,
  videos,
  onUploaded,
  onClose,
  onSaved,
}: {
  slide: ContentSlide | null;
  images: Asset[];
  videos: Asset[];
  onUploaded: () => void;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [kind, setKind] = useState<ContentKind>(slide?.kind ?? "image");
  const [form, setForm] = useState({
    title: slide?.title ?? "",
    assetId: slide?.assetId ?? "",
    text: slide?.text ?? "",
    url: slide?.url ?? "https://",
    refreshSeconds: slide?.refreshSeconds ? String(slide.refreshSeconds) : "300",
    durationSeconds: String(slide?.durationSeconds ?? 15),
    fit: slide?.fit ?? ("contain" as "contain" | "cover"),
    startsAt: slide?.startsAt ? toLocalInput(new Date(slide.startsAt)) : "",
    endsAt: slide?.endsAt ? toLocalInput(new Date(slide.endsAt)) : "",
    enabled: slide?.enabled ?? true,
  });
  // Editing keeps the targets as they are: rebuilding them from the form would silently narrow them.
  const [targets, setTargets] = useState<TargetState>(emptyTargetState());
  const [retarget, setRetarget] = useState(!slide);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const upload = useRef<HTMLInputElement>(null);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const library = kind === "image" ? images : videos;
  const media = kind === "image" || kind === "video";

  async function onFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      const asset = await api<Asset>(`/assets/media?name=${encodeURIComponent(file.name.replace(/\.[^.]+$/, "").slice(0, 100))}`, { file });
      onUploaded();
      setKind(asset.kind === "video" ? "video" : "image");
      set("assetId", asset.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Upload failed");
    } finally {
      setBusy(false);
      if (upload.current) upload.current.value = "";
    }
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const chosen = retarget ? toTargets(targets) : slide!.targets;
    if (!chosen) return setError("Choose which screens it is for");
    setBusy(true);
    setError(null);
    try {
      await api(slide ? `/content/${slide.id}` : "/content", {
        method: slide ? "PUT" : "POST",
        body: {
          kind,
          title: form.title,
          ...(media && { assetId: form.assetId }),
          ...(kind === "text" && { text: form.text }),
          ...(kind === "web" && { url: form.url, refreshSeconds: Number(form.refreshSeconds) }),
          durationSeconds: Number(form.durationSeconds),
          fit: form.fit,
          startsAt: toIso(form.startsAt),
          endsAt: toIso(form.endsAt),
          targets: retarget ? chosen : bodyOf(slide!).targets,
          enabled: form.enabled,
        },
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{slide ? "Edit slide" : "New slide"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Type" htmlFor="c-kind">
            <Select id="c-kind" value={kind} onChange={(e) => (setKind(e.target.value as ContentKind), set("assetId", ""))}>
              {CONTENT_KINDS.map((k) => (
                <option key={k} value={k}>
                  {CONTENT_KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>

          {media && (
            <div className="flex flex-col gap-2">
              <Field label="File" htmlFor="c-asset" hint="PNG, JPEG, WebP, GIF, MP4 or WebM. SVG is refused: it can carry scripts.">
                <div className="flex gap-2">
                  <Select id="c-asset" required value={form.assetId} onChange={(e) => set("assetId", e.target.value)}>
                    <option value="">Choose from the library…</option>
                    {library.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({formatBytes(a.size)})
                      </option>
                    ))}
                  </Select>
                  <Button type="button" variant="outline" disabled={busy} onClick={() => upload.current?.click()}>
                    <Upload /> Upload
                  </Button>
                  <input ref={upload} type="file" accept="image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm" className="sr-only" aria-label="File to upload" onChange={(e) => e.target.files?.[0] && void onFile(e.target.files[0])} />
                </div>
              </Field>
            </div>
          )}

          {kind === "text" && (
            <Field label="Text" htmlFor="c-text" hint={`${form.text.length} / 400. It is read from a distance: keep it short.`}>
              <textarea
                id="c-text"
                required
                rows={3}
                maxLength={400}
                value={form.text}
                onChange={(e) => set("text", e.target.value)}
                className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </Field>
          )}

          {kind === "web" && (
            <div className="grid gap-4 sm:grid-cols-[1fr_9rem]">
              <Field label="Address" htmlFor="c-url" hint="http or https. The page is shown in a frame and cannot reach the screen itself.">
                <Input id="c-url" type="url" required maxLength={300} value={form.url} onChange={(e) => set("url", e.target.value)} />
              </Field>
              <Field label="Reload (s)" htmlFor="c-refresh">
                <Input id="c-refresh" type="number" min={10} max={86400} value={form.refreshSeconds} onChange={(e) => set("refreshSeconds", e.target.value)} />
              </Field>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label={media ? "Caption (optional)" : "Title (optional)"} htmlFor="c-title">
              <Input id="c-title" maxLength={80} value={form.title} onChange={(e) => set("title", e.target.value)} />
            </Field>
            <Field label="Shown for (s)" htmlFor="c-duration" hint="3 to 600">
              <Input id="c-duration" type="number" min={3} max={600} required value={form.durationSeconds} onChange={(e) => set("durationSeconds", e.target.value)} />
            </Field>
            {media && (
              <Field label="Fit" htmlFor="c-fit">
                <Select id="c-fit" value={form.fit} onChange={(e) => set("fit", e.target.value as "contain" | "cover")}>
                  <option value="contain">Whole picture</option>
                  <option value="cover">Fill the screen</option>
                </Select>
              </Field>
            )}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="From (optional)" htmlFor="c-from" hint="Empty: right away.">
              <Input id="c-from" type="datetime-local" value={form.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
            </Field>
            <Field label="Until (optional)" htmlFor="c-until" hint="Empty: until you remove it.">
              <Input id="c-until" type="datetime-local" value={form.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
            </Field>
          </div>

          {slide && !retarget ? (
            <p className="text-sm text-muted-foreground">
              For: {describeTargets(slide.targets)}.{" "}
              <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => setRetarget(true)}>
                Change
              </button>
            </p>
          ) : (
            <TargetPicker value={targets} onChange={setTargets} />
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="accent-primary" checked={form.enabled} onChange={(e) => set("enabled", e.target.checked)} />
            Show it (untick to keep it in the library without showing it)
          </label>

          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
