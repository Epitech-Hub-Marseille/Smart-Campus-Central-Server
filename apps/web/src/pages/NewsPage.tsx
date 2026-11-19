import { Newspaper, Plus, Trash2 } from "lucide-react";
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
import { ANNOUNCE_PRIORITIES, PRIORITY_LABEL, type AnnouncePriority, type NewsItem } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

/** The news feed of the Faculty screens. The screens that show it, and how, are set up on the Screens page. */
export function NewsPage() {
  const news = useFetch<{ items: NewsItem[]; screenLimit: number }>("/faculty/news");
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
        title="News"
        description="Campus news and important notices, shown on the Faculty screens."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New news item
          </Button>
        }
      />

      <section className="flex flex-col gap-3">
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
