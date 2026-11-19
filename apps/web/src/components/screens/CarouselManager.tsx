import { ArrowDown, ArrowUp, CopyPlus, Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorText } from "@/components/Field";
import { SceneEditor, blankScene } from "@/components/screens/SceneEditor";
import { SceneLayout } from "@/components/screens/SceneLayout";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { api } from "@/lib/api";
import { cloneScenes } from "@/lib/screens";
import type { PlaylistSource, Scene, ScopeView, TileKinds } from "@/lib/types";

const SOURCE_LABEL: Record<PlaylistSource, string> = { device: "this screen", group: "its group", default: "the default for all screens", builtin: "the built-in board" };

/**
 * The carousel of a level: the scenes it rotates through, in order. A level either has its own playlist, or
 * follows the one above, and the manager says which. Editing starts from a copy, so nothing changes until it is saved.
 */
export function CarouselManager({ view, registry, onSaved }: { view: ScopeView; registry: TileKinds; onSaved: () => void }) {
  const own = view.scenes;
  const shown = own ?? view.inherited.scenes.items;
  const [draft, setDraft] = useState<Scene[]>(shown);
  const [dirty, setDirty] = useState(false);
  const [editing, setEditing] = useState<Scene | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  // A different level, or a fresh copy from the server: start again from what it says.
  useEffect(() => {
    setDraft(own ?? view.inherited.scenes.items);
    setDirty(false);
    setError(null);
  }, [view.scope, view.key, own, view.inherited.scenes.items]);

  const tiles = draft.reduce((n, s) => n + s.tiles.length, 0);
  const seconds = draft.filter((s) => s.enabled).reduce((n, s) => n + s.durationSeconds, 0);
  const following = own === null;

  const change = (next: Scene[]) => {
    setDraft(next);
    setDirty(true);
    setSaved(false);
  };
  const move = (i: number, by: -1 | 1) => {
    const next = [...draft];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    change(next);
  };

  async function run(job: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await job();
      setSaved(true);
      setDirty(false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  const base = `/faculty/scopes/${view.scope}/${view.key}/playlist`;
  const save = () => run(() => api(base, { method: "PUT", body: { scenes: draft } }));
  const useInherited = () => run(() => api(base, { method: "DELETE" }));

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardContent className="flex flex-col gap-3 text-sm sm:flex-row sm:items-center">
          {following ? (
            <>
              <Badge variant="muted">Inherited</Badge>
              <span className="min-w-0 flex-1">
                {view.scope === "default" ? "No playlist is set for all screens, so they show the built-in board." : `Following ${SOURCE_LABEL[view.inherited.scenes.from]}.`} Customise it to give {view.scope === "device" ? "this screen" : view.scope === "group" ? "this group" : "all screens"} its own.
              </span>
              <Button type="button" onClick={() => change(cloneScenes(shown))} disabled={busy}>
                <CopyPlus /> Customise
              </Button>
            </>
          ) : (
            <>
              <Badge>{view.scope === "device" ? "Own playlist" : view.scope === "group" ? "Group playlist" : "Default playlist"}</Badge>
              <span className="min-w-0 flex-1 text-muted-foreground">
                {view.scope === "default" ? "Shown by every screen without its own or its group's playlist." : "Replaces the playlist above, whole."}
              </span>
              <Button type="button" variant="outline" onClick={() => void useInherited()} disabled={busy}>
                <Undo2 /> {view.scope === "default" ? "Back to the built-in board" : "Use the inherited playlist"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      {/* While following, the list is a read-only preview; "Customise" fills the draft and unlocks it. */}
      {(() => {
        const editable = !following || dirty;
        return (
          <>
            <ol className="flex flex-col gap-3" aria-label="Scenes">
              {draft.map((scene, i) => {
                const layout = registry.layouts[scene.layout];
                return (
                  <li key={scene.id} className={`flex flex-wrap items-center gap-4 rounded-xl border bg-card p-3 ${scene.enabled ? "" : "opacity-60"}`}>
                    <div className="w-36 shrink-0">{layout ? <SceneLayout layout={layout} tiles={scene.tiles} kinds={registry.kinds} compact /> : null}</div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{scene.name || `Scene ${i + 1}`}</span>
                        {!scene.enabled && <Badge variant="muted">Paused</Badge>}
                        {(scene.startsAt || scene.endsAt) && <Badge variant="muted">Scheduled</Badge>}
                      </div>
                      <div className="text-sm text-muted-foreground">
                        {scene.durationSeconds}s · {scene.tiles.map((t) => registry.kinds.find((k) => k.kind === t.kind)?.label ?? t.kind).join(", ")}
                      </div>
                    </div>
                    {editable && (
                      <div className="flex items-center gap-1">
                        <label className="mr-2 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={scene.enabled} onChange={(e) => change(draft.map((s) => (s.id === scene.id ? { ...s, enabled: e.target.checked } : s)))} />
                          On
                        </label>
                        <Button type="button" variant="ghost" size="icon" aria-label={`Move ${scene.name || `scene ${i + 1}`} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                          <ArrowUp />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" aria-label={`Move ${scene.name || `scene ${i + 1}`} down`} disabled={i === draft.length - 1} onClick={() => move(i, 1)}>
                          <ArrowDown />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" aria-label={`Edit ${scene.name || `scene ${i + 1}`}`} onClick={() => setEditing(scene)}>
                          <Pencil />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" aria-label={`Delete ${scene.name || `scene ${i + 1}`}`} onClick={() => change(draft.filter((s) => s.id !== scene.id))}>
                          <Trash2 />
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {draft.length === 0 && <p className="rounded-xl border border-dashed py-8 text-center text-sm text-muted-foreground">No scene. A screen with an empty playlist stays on its idle screen.</p>}
            {editable && (
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  type="button"
                  variant="outline"
                  disabled={draft.length >= registry.limits.scenes}
                  onClick={() => setEditing(blankScene(registry))}
                >
                  <Plus /> Add a scene
                </Button>
                <span className="text-xs text-muted-foreground">
                  {draft.length} / {registry.limits.scenes} scenes, {tiles} / {registry.limits.tiles} tiles, one loop lasts {Math.floor(seconds / 60)} min {seconds % 60}s
                </span>
                <div className="ml-auto flex items-center gap-2">
                  {saved && !dirty && <span role="status" className="text-sm text-primary">Saved.</span>}
                  {dirty && (
                    <Button type="button" variant="ghost" disabled={busy} onClick={() => (setDraft(own ?? view.inherited.scenes.items), setDirty(false))}>
                      Discard changes
                    </Button>
                  )}
                  <Button type="button" onClick={() => void save()} disabled={busy || !dirty || tiles > registry.limits.tiles}>
                    {busy ? "Saving…" : "Save playlist"}
                  </Button>
                </div>
              </div>
            )}
          </>
        );
      })()}
      <ErrorText>{error}</ErrorText>

      {editing && (
        <SceneEditor
          scene={editing}
          registry={registry}
          onClose={() => setEditing(null)}
          onSave={(scene) => {
            change(draft.some((s) => s.id === scene.id) ? draft.map((s) => (s.id === scene.id ? scene : s)) : [...draft, scene]);
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}
