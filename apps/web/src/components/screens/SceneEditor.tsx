import { TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorText, Field } from "@/components/Field";
import { SceneLayout } from "@/components/screens/SceneLayout";
import { KindSelect, TileForm } from "@/components/screens/TileForm";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isHeard, missingFields, newId, newTile } from "@/lib/screens";
import { toLocalInput, type Scene, type TileKinds } from "@/lib/types";
import { cn } from "@/lib/utils";

const toMs = (local: string) => (local ? new Date(local).getTime() : undefined);

/** One scene: its layout, one tile per slot, its duration and when it applies. */
export function SceneEditor({ scene, registry, onSave, onClose }: { scene: Scene; registry: TileKinds; onSave: (scene: Scene) => void; onClose: () => void }) {
  const [draft, setDraft] = useState<Scene>(scene);
  const [slot, setSlot] = useState(0);
  const layout = registry.layouts[draft.layout];
  const [error, setError] = useState<string | null>(null);
  if (!layout) return null;

  const tile = draft.tiles[slot] ?? draft.tiles[0]!;
  const heard = draft.tiles.filter((t) => isHeard(registry.kinds.find((k) => k.kind === t.kind), t)).length;
  const incomplete = draft.tiles.some((t) => missingFields(registry.kinds.find((k) => k.kind === t.kind), t).length > 0);

  /** Changing the layout keeps the tiles that still have a slot and fills new slots with the first kind. */
  function setLayout(id: string) {
    const next = registry.layouts[id]!;
    const first = registry.kinds[0]!;
    const tiles = next.tiles.map((_, i) => draft.tiles[i] ?? newTile(first));
    setDraft({ ...draft, layout: id, tiles });
    setSlot(Math.min(slot, tiles.length - 1));
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (heard > 1) return setError("Only one tile of a scene can play sound. Mute the others.");
    if (draft.startsAt && draft.endsAt && draft.endsAt <= draft.startsAt) return setError("The end must be after the start.");
    onSave(draft);
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{scene.name || "Scene"}</DialogTitle>
          <DialogDescription>Choose a layout, then pick what each tile shows.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-[1fr_8rem]">
            <Field label="Name" htmlFor="scene-name">
              <Input id="scene-name" maxLength={60} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Welcome" />
            </Field>
            <Field label="Seconds" htmlFor="scene-duration">
              <Input id="scene-duration" type="number" min={3} max={600} required value={draft.durationSeconds} onChange={(e) => setDraft({ ...draft, durationSeconds: Number(e.target.value) })} />
            </Field>
          </div>

          <fieldset>
            <legend className="mb-2 text-sm leading-none font-medium">Layout</legend>
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              {Object.entries(registry.layouts).map(([id, l]) => (
                <button
                  key={id}
                  type="button"
                  aria-pressed={draft.layout === id}
                  onClick={() => setLayout(id)}
                  className={cn("flex flex-col gap-1.5 rounded-lg border p-1.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring/60", draft.layout === id ? "border-primary bg-accent" : "hover:border-primary/40")}
                >
                  <SceneLayout layout={l} compact className="p-0.5" />
                  <span className="truncate text-center text-muted-foreground">{l.label}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <div className="grid gap-4 md:grid-cols-[minmax(0,16rem)_1fr]">
            <div>
              <div className="mb-2 text-sm leading-none font-medium">Tiles</div>
              <SceneLayout layout={layout} tiles={draft.tiles} kinds={registry.kinds} selected={slot} onSelect={setSlot} />
              <p className="mt-2 text-xs text-muted-foreground">Select a tile to set what it shows.</p>
            </div>
            <div className="flex flex-col gap-4 rounded-xl border p-4">
              <Field label={`Tile ${slot + 1} shows`} htmlFor="tile-kind">
                <KindSelect id="tile-kind" kinds={registry.kinds} value={tile.kind} onChange={(t) => setDraft({ ...draft, tiles: draft.tiles.map((x, i) => (i === slot ? t : x)) })} />
              </Field>
              <TileForm
                idPrefix={`tile-${slot}-${tile.id}`}
                def={registry.kinds.find((k) => k.kind === tile.kind)}
                tile={tile}
                onChange={(t) => setDraft({ ...draft, tiles: draft.tiles.map((x, i) => (i === slot ? t : x)) })}
              />
            </div>
          </div>
          {heard > 1 && (
            <p role="alert" className="flex items-center gap-2 text-sm text-destructive">
              <TriangleAlert className="size-4" aria-hidden /> {heard} tiles would play sound at once. Mute all but one.
            </p>
          )}

          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-2 text-sm leading-none font-medium">Show only between (optional)</legend>
            <Field label="From" htmlFor="scene-from">
              <Input id="scene-from" type="datetime-local" value={draft.startsAt ? toLocalInput(new Date(draft.startsAt)) : ""} onChange={(e) => setDraft({ ...draft, startsAt: toMs(e.target.value) })} />
            </Field>
            <Field label="Until" htmlFor="scene-until">
              <Input id="scene-until" type="datetime-local" value={draft.endsAt ? toLocalInput(new Date(draft.endsAt)) : ""} onChange={(e) => setDraft({ ...draft, endsAt: toMs(e.target.value) })} />
            </Field>
          </fieldset>

          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={incomplete}>
              Done
            </Button>
          </DialogFooter>
          {incomplete && <p className="text-xs text-muted-foreground">Some tile still lacks a required setting.</p>}
        </form>
      </DialogContent>
    </Dialog>
  );
}

export const blankScene = (registry: TileKinds): Scene => {
  const first = registry.kinds[0]!;
  return { id: newId(), name: "", layout: "full", durationSeconds: 15, enabled: true, tiles: [newTile(first)] };
};
