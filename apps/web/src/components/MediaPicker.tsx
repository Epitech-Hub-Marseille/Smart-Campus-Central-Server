import { ImageOff, Library, X } from "lucide-react";
import { useState } from "react";
import { MediaBrowser, MediaThumb } from "@/components/MediaBrowser";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { type Asset } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

/** The library in a dialog: pick one file and it closes. */
export function MediaPickerDialog({ accept, selectedId, onPick, onClose }: { accept?: "image" | "video"; selectedId?: string | null; onPick: (a: Asset) => void; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle>Choose {accept === "image" ? "an image" : accept === "video" ? "a video" : "a file"}</DialogTitle>
          <DialogDescription>From the media library. You can upload new files here too.</DialogDescription>
        </DialogHeader>
        <MediaBrowser mode="pick" accept={accept} selectedId={selectedId} onPick={(a) => (onPick(a), onClose())} />
      </DialogContent>
    </Dialog>
  );
}

/**
 * A form field that holds a library file: a thumbnail, "Choose from the library" and "Remove". Only the file's id is
 * kept, so the server decides its hash and size.
 */
export function MediaField({
  label,
  id,
  value,
  accept,
  onChange,
  clearable = true,
  inherited,
  hideLabel = false,
}: {
  label: string;
  id: string;
  value: string | null | undefined;
  accept?: "image" | "video";
  onChange: (assetId: string | null) => void;
  clearable?: boolean;
  /** Shown instead of the empty state when the value comes from a level above. */
  inherited?: string | null;
  /** The surrounding row already shows the label. */
  hideLabel?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const shownId = value ?? inherited ?? null;
  // The library list is small and cached by the browser; it gives the name and hash of the id we hold.
  const library = useFetch<{ items: Asset[] }>(shownId ? "/assets?kind=media" : null);
  const asset = shownId ? library.data?.items.find((a) => a.id === shownId) : undefined;

  return (
    <div className="flex flex-col gap-2">
      <span id={`${id}-label`} className={hideLabel ? "sr-only" : "text-sm leading-none font-medium"}>
        {label}
      </span>
      <div className="flex items-center gap-3">
        <div className="grid h-14 w-24 shrink-0 place-items-center overflow-hidden rounded-lg border bg-secondary text-muted-foreground">
          {asset ? <MediaThumb asset={asset} /> : <ImageOff className="size-5" aria-label="Nothing chosen" />}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <div className="truncate">{asset?.name ?? (shownId ? "Unavailable file" : "Nothing chosen")}</div>
          {value === undefined || value === null ? inherited && <div className="text-xs text-muted-foreground">Inherited</div> : null}
        </div>
        <Button id={id} type="button" variant="outline" size="sm" aria-labelledby={`${id}-label ${id}`} onClick={() => setOpen(true)}>
          <Library /> Choose
        </Button>
        {clearable && value && (
          <Button type="button" variant="ghost" size="icon" aria-label={`Remove ${label.toLowerCase()}`} onClick={() => onChange(null)}>
            <X />
          </Button>
        )}
      </div>
      {open && <MediaPickerDialog accept={accept} selectedId={value} onPick={(a) => onChange(a.id)} onClose={() => setOpen(false)} />}
    </div>
  );
}
