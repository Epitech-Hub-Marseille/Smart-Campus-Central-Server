import { FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { PriorityBadge } from "@/pages/AnnouncementsPage";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { ANNOUNCE_PRIORITIES, PRIORITY_LABEL, languageName, type AnnouncePriority, type AnnouncementTemplate, type VoiceCatalogue } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

/** The library of reusable announcements. Using one copies it into the announcement, schedule or voice form. */
export function TemplatesPage() {
  const list = useFetch<{ items: AnnouncementTemplate[] }>("/announcement-templates");
  const [editing, setEditing] = useState<AnnouncementTemplate | "new" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  async function remove(t: AnnouncementTemplate) {
    if (!confirm(`Delete the template "${t.name}"? Schedules already made from it keep their own copy.`)) return;
    setActionError(null);
    try {
      await api(`/announcement-templates/${t.id}`, { method: "DELETE" });
      list.reload();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div>
      <PageHeader
        title="Templates"
        description="Announcements you send often. Pick one when writing an announcement, a voice message or a schedule."
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus /> New template
          </Button>
        }
      />
      <ErrorText>{list.error ?? actionError}</ErrorText>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Message</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.data?.items.map((t) => (
            <TableRow key={t.id}>
              <TableCell className="font-medium">{t.name}</TableCell>
              <TableCell>
                <Badge variant="muted">{t.kind === "voice" ? "Voice" : "Screen"}</Badge>
              </TableCell>
              <TableCell className="max-w-md truncate text-muted-foreground">{t.text}</TableCell>
              <TableCell>{t.kind === "text" ? <PriorityBadge priority={t.priority} /> : "–"}</TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="icon" aria-label={`Edit ${t.name}`} onClick={() => setEditing(t)}>
                    <Pencil />
                  </Button>
                  <Button variant="ghost" size="icon" aria-label={`Delete ${t.name}`} onClick={() => void remove(t)}>
                    <Trash2 />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
          {!list.loading && list.data?.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                <FileText className="mx-auto mb-2 size-6" /> No template yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      {editing && (
        <TemplateDialog
          template={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}

function TemplateDialog({ template, onClose, onSaved }: { template: AnnouncementTemplate | null; onClose: () => void; onSaved: () => void }) {
  const voices = useFetch<VoiceCatalogue>("/intercom/voices");
  const [form, setForm] = useState({
    name: template?.name ?? "",
    kind: template?.kind ?? ("text" as "text" | "voice"),
    title: template?.title ?? "",
    text: template?.text ?? "",
    priority: template?.priority ?? ("info" as AnnouncePriority),
    voice: template?.voice ?? "",
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => setForm((f) => ({ ...f, [key]: value }));
  const voice = form.kind === "voice";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(template ? `/announcement-templates/${template.id}` : "/announcement-templates", { method: template ? "PUT" : "POST", body: form });
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
          <DialogTitle>{template ? "Edit template" : "New template"}</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="t-name">
              <Input id="t-name" required maxLength={80} value={form.name} onChange={(e) => set("name", e.target.value)} />
            </Field>
            <Field label="Type" htmlFor="t-kind">
              <Select id="t-kind" value={form.kind} onChange={(e) => set("kind", e.target.value as "text" | "voice")}>
                <option value="text">Shown on screens</option>
                <option value="voice">Read by a voice</option>
              </Select>
            </Field>
          </div>
          {!voice && (
            <Field label="Title (optional)" htmlFor="t-title">
              <Input id="t-title" maxLength={200} value={form.title} onChange={(e) => set("title", e.target.value)} />
            </Field>
          )}
          <Field label="Message" htmlFor="t-text" hint={voice ? "At most 1000 characters, read aloud as written." : undefined}>
            <textarea
              id="t-text"
              required
              rows={3}
              maxLength={voice ? 1000 : 2000}
              value={form.text}
              onChange={(e) => set("text", e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </Field>
          {voice ? (
            voices.data?.enabled && (
              <Field label="Voice" htmlFor="t-voice">
                <Select id="t-voice" value={form.voice} onChange={(e) => set("voice", e.target.value)}>
                  <option value="">First available voice</option>
                  {voices.data.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.label} ({languageName(v.language)})
                    </option>
                  ))}
                </Select>
              </Field>
            )
          ) : (
            <Field label="Priority" htmlFor="t-priority">
              <Select id="t-priority" value={form.priority} onChange={(e) => set("priority", e.target.value as AnnouncePriority)}>
                {ANNOUNCE_PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {PRIORITY_LABEL[p]}
                  </option>
                ))}
              </Select>
            </Field>
          )}
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
