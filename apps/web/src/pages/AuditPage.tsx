import { Download } from "lucide-react";
import { useState } from "react";
import { ErrorText } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { type AuditEntry, type Page } from "@/lib/types";
import { useDebounced, useFetch } from "@/lib/useFetch";

const LIMIT = 50;

/** One short line for the details an entry carries (only small, non-secret facts are ever stored in them). */
const summary = (meta: Record<string, unknown>) =>
  Object.entries(meta)
    .filter(([, v]) => v !== null && v !== undefined && v !== "")
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
    .join(" · ");

/** Who did what, and when. Read-only. */
export function AuditPage() {
  const [action, setAction] = useState("");
  const [actor, setActor] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [page, setPage] = useState(1);
  // Debounced one by one: an object made on every render would never settle.
  const actionFilter = useDebounced(action);
  const actorFilter = useDebounced(actor);

  const params = new URLSearchParams({ limit: String(LIMIT), page: String(page) });
  if (actionFilter) params.set("action", actionFilter);
  if (actorFilter) params.set("actor", actorFilter);
  if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
  if (to) params.set("to", new Date(`${to}T23:59:59.999`).toISOString());
  const list = useFetch<Page<AuditEntry> & { actions: string[] }>(`/audit?${params}`);

  const exportParams = new URLSearchParams();
  if (from) exportParams.set("from", new Date(`${from}T00:00:00`).toISOString());
  if (to) exportParams.set("to", new Date(`${to}T23:59:59.999`).toISOString());

  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / LIMIT));
  const reset = <T,>(set: (v: T) => void) => (v: T) => {
    set(v);
    setPage(1);
  };

  return (
    <div>
      <PageHeader
        title="Audit log"
        description="Who did what, and when. Entries are only ever added, never changed."
        actions={
          <Button variant="outline" asChild>
            <a href={`/api/stats/export/audit?${exportParams}`} download>
              <Download /> Export CSV
            </a>
          </Button>
        }
      />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="a-action" className="text-sm font-medium">
            Action
          </label>
          <Input id="a-action" list="audit-actions" placeholder="e.g. emergency." value={action} onChange={(e) => reset(setAction)(e.target.value)} />
          <datalist id="audit-actions">
            {list.data?.actions.map((a) => (
              <option key={a} value={a} />
            ))}
          </datalist>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="a-actor" className="text-sm font-medium">
            Person
          </label>
          <Input id="a-actor" placeholder="Name" value={actor} onChange={(e) => reset(setActor)(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="a-from" className="text-sm font-medium">
            From
          </label>
          <Input id="a-from" type="date" value={from} onChange={(e) => reset(setFrom)(e.target.value)} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="a-to" className="text-sm font-medium">
            To
          </label>
          <Input id="a-to" type="date" value={to} onChange={(e) => reset(setTo)(e.target.value)} />
        </div>
      </div>
      <ErrorText>{list.error}</ErrorText>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Who</TableHead>
            <TableHead>Action</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>Details</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.data?.items.map((e) => (
            <TableRow key={e.id}>
              <TableCell className="whitespace-nowrap text-muted-foreground">{new Date(e.at).toLocaleString([], { dateStyle: "short", timeStyle: "medium" })}</TableCell>
              <TableCell>{e.actor}</TableCell>
              <TableCell className="font-mono text-xs">{e.action}</TableCell>
              <TableCell className="max-w-48 truncate font-mono text-xs text-muted-foreground" title={`${e.target.type} ${e.target.id}`}>
                {e.target.type} {e.target.id}
              </TableCell>
              <TableCell className="max-w-md truncate text-muted-foreground" title={summary(e.meta)}>
                {summary(e.meta)}
              </TableCell>
            </TableRow>
          ))}
          {!list.loading && list.data?.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                No entry matches.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          {total} entr{total === 1 ? "y" : "ies"}
        </span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </Button>
          <span className="tabular-nums">
            {page} / {pages}
          </span>
          <Button variant="outline" size="sm" disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </Button>
        </div>
      </div>
    </div>
  );
}
