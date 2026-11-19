import { useState, type FormEvent } from "react";
import { ErrorText, Field } from "@/components/Field";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import type { ScreenGroup, ScreensOverview } from "@/lib/types";

/** Create a group or change its name and screens. A screen is in one group at most, so picking one moves it. */
export function GroupDialog({ group, overview, onClose, onSaved }: { group: ScreenGroup | null; overview: ScreensOverview; onClose: () => void; onSaved: (id: string) => void }) {
  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [members, setMembers] = useState<Set<string>>(new Set(group?.members ?? []));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groupName = (id: string | null) => overview.groups.find((g) => g.id === id)?.name;
  const toggle = (id: string) =>
    setMembers((m) => {
      const next = new Set(m);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name, description, members: [...members] };
      const saved = group ? await api<{ id: string }>(`/faculty/groups/${group.id}`, { method: "PUT", body }) : await api<{ id: string }>("/faculty/groups", { body });
      onSaved(saved.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{group ? "Edit group" : "New group"}</DialogTitle>
          <DialogDescription>Screens in a group share its settings and playlist, unless a screen sets its own.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field label="Name" htmlFor="g-name">
            <Input id="g-name" required maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Building A lobbies" />
          </Field>
          <Field label="Description (optional)" htmlFor="g-desc">
            <Input id="g-desc" maxLength={200} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
          <fieldset>
            <legend className="mb-2 text-sm leading-none font-medium">Screens</legend>
            {overview.displays.length === 0 ? (
              <p className="text-sm text-muted-foreground">No Faculty screen is enrolled yet.</p>
            ) : (
              <ul className="max-h-56 divide-y overflow-y-auto rounded-lg border">
                {overview.displays.map((d) => {
                  const other = d.groupId && d.groupId !== group?.id ? groupName(d.groupId) : null;
                  return (
                    <li key={d.id}>
                      <label className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50">
                        <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={members.has(d.id)} onChange={() => toggle(d.id)} />
                        <span className="min-w-0 flex-1 truncate">{d.name}</span>
                        {other && members.has(d.id) ? <span className="text-xs text-muted-foreground">moves from {other}</span> : other ? <span className="text-xs text-muted-foreground">in {other}</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            )}
          </fieldset>
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
