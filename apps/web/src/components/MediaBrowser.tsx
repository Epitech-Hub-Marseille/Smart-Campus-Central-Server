import { Check, Film, FolderClosed, FolderInput, Image as ImageIcon, Pencil, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { ErrorText, Field } from "@/components/Field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { assetUrl, formatBytes, type Asset, type AssetUse } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";
import { cn } from "@/lib/utils";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif,video/mp4,video/webm";

type Filter = "all" | "image" | "video";

interface Props {
  /** "manage" shows the file actions; "pick" lets the user choose a file for something else. */
  mode: "manage" | "pick";
  /** In pick mode, only files of this kind can be chosen. */
  accept?: "image" | "video";
  selectedId?: string | null;
  onPick?: (asset: Asset) => void;
}

/** A thumbnail of a library file: the image itself, or a still of the video. */
export function MediaThumb({ asset, className }: { asset: Pick<Asset, "id" | "sha256" | "kind" | "name">; className?: string }) {
  return asset.kind === "video" ? (
    <video src={`${assetUrl(asset)}#t=0.1`} preload="metadata" muted aria-label={asset.name} className={cn("size-full object-cover", className)} />
  ) : (
    <img src={assetUrl(asset)} alt={asset.name} loading="lazy" className={cn("size-full object-cover", className)} />
  );
}

/**
 * The file browser of the media library: folders on the left, files on the right. Used on its own to manage
 * files, and inside a dialog to pick one for a logo, a tile or anything else that shows media.
 */
export function MediaBrowser({ mode, accept, selectedId, onPick }: Props) {
  const list = useFetch<{ items: Asset[]; folders: string[] }>("/assets?kind=media");
  const [folder, setFolder] = useState<string | null>(null); // null = all files
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<Filter>(accept ?? "all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [deleting, setDeleting] = useState<Asset | null>(null);
  const upload = useRef<HTMLInputElement>(null);

  const items = list.data?.items ?? [];
  const folders = list.data?.folders ?? [];
  const shown = useMemo(
    () =>
      items.filter(
        (a) =>
          (folder === null || a.folder === folder) &&
          (kind === "all" || a.kind === kind) &&
          (!query || a.name.toLowerCase().includes(query.toLowerCase())),
      ),
    [items, folder, kind, query],
  );

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    // One by one: each file is checked by the server from its first bytes, and a refusal names the file.
    for (const file of Array.from(files)) {
      try {
        await api(`/assets/media?name=${encodeURIComponent(file.name.replace(/\.[^.]+$/, ""))}&folder=${encodeURIComponent(folder ?? "")}`, { file });
      } catch (e) {
        failures.push(`${file.name}: ${e instanceof Error ? e.message : "upload failed"}`);
      }
    }
    if (upload.current) upload.current.value = "";
    setBusy(false);
    if (failures.length) setError(failures.join(" · "));
    list.reload();
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <Input aria-label="Search files" placeholder="Search files" value={query} onChange={(e) => setQuery(e.target.value)} className="pl-9" />
        </div>
        {!accept && (
          <div role="group" aria-label="Type" className="flex rounded-lg border border-input p-0.5">
            {(["all", "image", "video"] as const).map((k) => (
              <button
                key={k}
                type="button"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
                className={cn("rounded-md px-3 py-1 text-sm capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring/60", kind === k ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}
              >
                {k === "all" ? "All" : `${k}s`}
              </button>
            ))}
          </div>
        )}
        <Button type="button" disabled={busy} onClick={() => upload.current?.click()}>
          <Upload /> {busy ? "Uploading…" : folder ? `Upload to ${folder}` : "Upload"}
        </Button>
        <input ref={upload} type="file" multiple accept={ACCEPT} className="sr-only" aria-label="Files to upload" onChange={(e) => void onFiles(e.target.files)} />
      </div>
      <ErrorText>{error ?? list.error}</ErrorText>

      <div className="grid gap-4 md:grid-cols-[12rem_1fr]">
        <nav aria-label="Folders" className="flex gap-1 overflow-x-auto md:flex-col md:overflow-visible">
          <FolderButton active={folder === null} onClick={() => setFolder(null)} label="All files" count={items.length} />
          <FolderButton active={folder === ""} onClick={() => setFolder("")} label="No folder" count={items.filter((a) => !a.folder).length} />
          {folders.map((f) => (
            <FolderButton key={f} active={folder === f} onClick={() => setFolder(f)} label={f} count={items.filter((a) => a.folder === f).length} />
          ))}
        </nav>

        <div>
          {list.loading && items.length === 0 ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : shown.length === 0 ? (
            <div className="grid place-items-center gap-2 rounded-xl border border-dashed py-12 text-center text-sm text-muted-foreground">
              <ImageIcon className="size-6" aria-hidden />
              {items.length === 0 ? "The library is empty. Upload images or videos to use them on the screens." : "No file matches."}
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
              {shown.map((a) => {
                const pickable = mode === "pick" && (!accept || a.kind === accept);
                const selected = selectedId === a.id;
                return (
                  <li key={a.id} className={cn("group overflow-hidden rounded-xl border bg-card", selected && "border-primary ring-2 ring-primary/30")}>
                    <button
                      type="button"
                      disabled={mode === "pick" && !pickable}
                      onClick={() => (pickable ? onPick?.(a) : mode === "manage" && setEditing(a))}
                      aria-label={mode === "pick" ? `Choose ${a.name}` : `Open ${a.name}`}
                      className="relative block aspect-video w-full overflow-hidden bg-secondary outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:opacity-40"
                    >
                      <MediaThumb asset={a} />
                      {a.kind === "video" && <Film className="absolute top-2 left-2 size-4 rounded bg-black/60 p-0.5 text-white" aria-hidden />}
                      {selected && <Check className="absolute top-2 right-2 size-5 rounded-full bg-primary p-1 text-primary-foreground" aria-label="Selected" />}
                    </button>
                    <div className="flex items-center gap-2 px-3 py-2">
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium" title={a.name}>
                          {a.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {formatBytes(a.size)}
                          {a.folder && ` · ${a.folder}`}
                        </div>
                      </div>
                      {mode === "manage" && (
                        <>
                          <Button type="button" variant="ghost" size="icon" aria-label={`Edit ${a.name}`} onClick={() => setEditing(a)}>
                            <Pencil />
                          </Button>
                          <Button type="button" variant="ghost" size="icon" aria-label={`Delete ${a.name}`} onClick={() => setDeleting(a)}>
                            <Trash2 />
                          </Button>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {editing && (
        <EditDialog
          asset={editing}
          folders={folders}
          onClose={() => setEditing(null)}
          onChanged={(a) => {
            setEditing(a);
            list.reload();
          }}
        />
      )}
      {deleting && (
        <DeleteDialog
          asset={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function FolderButton({ active, onClick, label, count }: { active: boolean; onClick: () => void; label: string; count: number }) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        active ? "bg-accent text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      <FolderClosed className="size-4 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-xs">{count}</span>
    </button>
  );
}

/** Rename, move, replace the content, and see where a file is used. */
function EditDialog({ asset, folders, onClose, onChanged }: { asset: Asset; folders: string[]; onClose: () => void; onChanged: (a: Asset) => void }) {
  const [name, setName] = useState(asset.name);
  const [folder, setFolder] = useState(asset.folder);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const replace = useRef<HTMLInputElement>(null);
  const usage = useFetch<{ items: AssetUse[] }>(`/assets/${asset.id}/usage`);

  async function run(job: () => Promise<Asset>, done = false) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const updated = await job();
      onChanged(updated);
      setSaved(true);
      usage.reload();
      if (done) onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const dirty = name.trim() !== asset.name || folder.trim() !== asset.folder;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{asset.name}</DialogTitle>
          <DialogDescription>
            <Badge variant="muted">{asset.kind}</Badge> <span className="ml-1">{asset.mime}, {formatBytes(asset.size)}</span>
          </DialogDescription>
        </DialogHeader>
        <div className="aspect-video overflow-hidden rounded-lg bg-secondary">
          {asset.kind === "video" ? <video src={assetUrl(asset)} controls className="size-full" aria-label={`Preview of ${asset.name}`} /> : <img src={assetUrl(asset)} alt={asset.name} className="size-full object-contain" />}
        </div>
        <form
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => api<Asset>(`/assets/${asset.id}`, { method: "PATCH", body: { name: name.trim(), folder: folder.trim() } }));
          }}
        >
          <Field label="Name" htmlFor="asset-name">
            <Input id="asset-name" required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Folder" htmlFor="asset-folder" hint="Leave empty for no folder. Type a new name to create one.">
            <Input id="asset-folder" list="asset-folders" maxLength={40} value={folder} onChange={(e) => setFolder(e.target.value)} />
            <datalist id="asset-folders">
              {folders.map((f) => (
                <option key={f} value={f} />
              ))}
            </datalist>
          </Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <Button type="submit" disabled={busy || !dirty}>
              <FolderInput /> Save
            </Button>
            <Button type="button" variant="outline" disabled={busy} onClick={() => replace.current?.click()}>
              <RefreshCw /> Replace the file
            </Button>
            <input
              ref={replace}
              type="file"
              accept={asset.kind === "video" ? "video/mp4,video/webm" : "image/png,image/jpeg,image/webp,image/gif"}
              className="sr-only"
              aria-label="New version of the file"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void run(() => api<Asset>(`/assets/${asset.id}/file`, { method: "PUT", file }));
                e.target.value = "";
              }}
            />
            {saved && <span role="status" className="text-sm text-primary">Saved.</span>}
          </div>
        </form>
        <p className="text-xs text-muted-foreground">Replacing keeps the same place on every screen that shows this file: they pick up the new version by themselves.</p>
        <div>
          <h3 className="mb-1 text-sm font-medium">Used by</h3>
          {usage.data?.items.length ? (
            <ul className="text-sm text-muted-foreground">
              {usage.data.items.map((u) => (
                <li key={`${u.scope}:${u.key}:${u.as}`}>
                  {u.name} <span className="text-xs">({u.as === "logo" ? "logo" : "carousel"})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">Not used yet.</p>
          )}
        </div>
        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteDialog({ asset, onClose, onDeleted }: { asset: Asset; onClose: () => void; onDeleted: () => void }) {
  const usage = useFetch<{ items: AssetUse[] }>(`/assets/${asset.id}/usage`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inUse = (usage.data?.items.length ?? 0) > 0;

  async function remove() {
    setBusy(true);
    setError(null);
    try {
      await api(`/assets/${asset.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete “{asset.name}”?</DialogTitle>
          <DialogDescription>The file is removed from the library for good.</DialogDescription>
        </DialogHeader>
        {inUse && (
          <p role="alert" className="text-sm text-destructive">
            It is still used by {[...new Set(usage.data!.items.map((u) => u.name))].join(", ")}. Remove it there first, or replace the file instead.
          </p>
        )}
        <ErrorText>{error}</ErrorText>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" disabled={busy || inUse || usage.loading} onClick={() => void remove()}>
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
