import { Check, Copy, KeyRound, Plus, ScrollText, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/lib/api";
import { timeAgo, type Page } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  expiresAt: string;
  state: "active" | "expired" | "revoked";
  createdBy: string;
  createdAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  useCount: number;
}

interface Scope {
  id: string;
  label: string;
  description: string;
  group: string;
  access: "read" | "write";
}

interface Usage {
  at: string;
  method: string;
  path: string;
  status: number;
  ip: string | null;
}

const STATE_LABEL = { active: "Active", expired: "Expired", revoked: "Revoked" } as const;

/** Keys for other applications to use the official API: each with only the scopes it needs, and an end date. */
export function ApiKeysPage() {
  const keys = useFetch<{ items: ApiKey[] }>("/api-keys");
  const scopes = useFetch<{ items: Scope[]; maxLifetimeDays: number; defaultLifetimeDays: number }>("/api-keys/scopes");
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ name: string; key: string } | null>(null);
  const [usageOf, setUsageOf] = useState<ApiKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function revoke(k: ApiKey) {
    if (!confirm(`Revoke “${k.name}”? Applications using it stop working immediately. This cannot be undone.`)) return;
    setError(null);
    try {
      await api(`/api-keys/${k.id}`, { method: "DELETE" });
      keys.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not revoke the key");
    }
  }

  return (
    <div>
      <PageHeader
        title="API keys"
        description="Let other applications use the Smart Campus API, each with only what it needs. A key is shown once, when it is created."
        actions={
          <Button onClick={() => setCreating(true)} disabled={!scopes.data}>
            <Plus /> New key
          </Button>
        }
      />
      <ErrorText>{keys.error ?? scopes.error ?? error}</ErrorText>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Key</TableHead>
            <TableHead>Scopes</TableHead>
            <TableHead>Expires</TableHead>
            <TableHead>Last used</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {keys.data?.items.map((k) => (
            <TableRow key={k.id}>
              <TableCell>
                <div className="font-medium">{k.name}</div>
                <div className="text-xs text-muted-foreground">by {k.createdBy}</div>
              </TableCell>
              <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
              <TableCell>
                <div className="flex max-w-xs flex-wrap gap-1">
                  {k.scopes.map((s) => (
                    <Badge key={s} variant={s.endsWith(":read") ? "muted" : "default"}>
                      {s}
                    </Badge>
                  ))}
                </div>
              </TableCell>
              <TableCell>
                <Badge variant={k.state === "active" ? "default" : "muted"}>{STATE_LABEL[k.state]}</Badge>
                <div className="mt-1 text-xs text-muted-foreground">{new Date(k.expiresAt).toLocaleDateString()}</div>
              </TableCell>
              <TableCell className="text-muted-foreground">
                {k.lastUsedAt ? timeAgo(k.lastUsedAt) : "Never"}
                <div className="text-xs">{k.useCount} call{k.useCount === 1 ? "" : "s"}</div>
              </TableCell>
              <TableCell>
                <div className="flex justify-end gap-1">
                  <Button variant="ghost" size="icon" aria-label={`Usage of ${k.name}`} title="Usage" onClick={() => setUsageOf(k)}>
                    <ScrollText />
                  </Button>
                  {k.state === "active" && (
                    <Button variant="ghost" size="icon" aria-label={`Revoke ${k.name}`} title="Revoke" onClick={() => void revoke(k)}>
                      <Trash2 />
                    </Button>
                  )}
                </div>
              </TableCell>
            </TableRow>
          ))}
          {!keys.loading && keys.data?.items.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="py-10 text-center text-muted-foreground">
                <KeyRound className="mx-auto mb-2 size-6" /> No API key yet.
              </TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>

      {creating && scopes.data && (
        <CreateDialog
          scopes={scopes.data.items}
          maxDays={scopes.data.maxLifetimeDays}
          defaultDays={scopes.data.defaultLifetimeDays}
          onClose={() => setCreating(false)}
          onCreated={(name, key) => {
            setCreating(false);
            setCreated({ name, key });
            keys.reload();
          }}
        />
      )}
      {created && <KeyShown {...created} onClose={() => setCreated(null)} />}
      {usageOf && <UsageDialog apiKey={usageOf} onClose={() => setUsageOf(null)} />}
    </div>
  );
}

const LIFETIMES = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 180, label: "6 months" },
  { days: 365, label: "1 year" },
];

function CreateDialog({ scopes, defaultDays, onClose, onCreated }: { scopes: Scope[]; maxDays: number; defaultDays: number; onClose: () => void; onCreated: (name: string, key: string) => void }) {
  const [name, setName] = useState("");
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [days, setDays] = useState(defaultDays);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const groups = [...new Set(scopes.map((s) => s.group))];

  const toggle = (id: string) =>
    setChosen((c) => {
      const next = new Set(c);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ key: string }>("/api-keys", { body: { name, scopes: [...chosen], expiresInDays: days, twoFactorCode: code } });
      onCreated(name, r.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create the key");
      setCode("");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>New API key</DialogTitle>
          <DialogDescription>Give it only the scopes the application needs. Keys cannot start emergency alerts, manage accounts or manage keys.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
            <Field label="Name" htmlFor="k-name" hint="What it is used by, so you recognise it later.">
              <Input id="k-name" required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="Timetable website" />
            </Field>
            <Field label="Expires after" htmlFor="k-days">
              <Select id="k-days" value={days} onChange={(e) => setDays(Number(e.target.value))}>
                {LIFETIMES.map((l) => (
                  <option key={l.days} value={l.days}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="flex flex-col gap-4">
            {groups.map((group) => (
              <fieldset key={group}>
                <legend className="mb-2 text-sm leading-none font-medium">{group}</legend>
                <div className="grid gap-2 sm:grid-cols-2">
                  {scopes
                    .filter((s) => s.group === group)
                    .map((s) => (
                      <label key={s.id} className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm has-[:checked]:border-primary/50 has-[:checked]:bg-accent/40">
                        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--primary)]" checked={chosen.has(s.id)} onChange={() => toggle(s.id)} />
                        <span>
                          <span className="flex items-center gap-2 font-medium">
                            {s.label} {s.access === "write" && <Badge>can change things</Badge>}
                          </span>
                          <span className="block text-muted-foreground">{s.description}</span>
                          <span className="block font-mono text-xs text-muted-foreground">{s.id}</span>
                        </span>
                      </label>
                    ))}
                </div>
              </fieldset>
            ))}
          </div>

          <Field label="Authenticator code" htmlFor="k-code" hint="Creating a key needs a fresh code from your authenticator app.">
            <Input id="k-code" required inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="max-w-40 font-mono tracking-widest" />
          </Field>
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || chosen.size === 0 || !name.trim() || code.replace(/\s/g, "").length !== 6}>
              {busy ? "Creating…" : "Create key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** The one time the key is visible: the server keeps only a hash, so closing this dialog cannot be undone. */
function KeyShown({ name, key: token, onClose }: { name: string; key: string; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  return (
    <Dialog open onOpenChange={(open) => open || (saved && onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Copy your key now</DialogTitle>
          <DialogDescription>“{name}” is created. This is the only time the key is shown: it cannot be recovered, only replaced.</DialogDescription>
        </DialogHeader>
        <div className="rounded-lg border bg-secondary/40 p-3 font-mono text-sm break-all">{token}</div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void navigator.clipboard.writeText(token).then(() => setCopied(true))}>
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
          </Button>
          <span className="text-xs text-muted-foreground">Send it as <code className="font-mono">Authorization: Bearer …</code></span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I have copied the key somewhere safe
        </label>
        <DialogFooter>
          <Button disabled={!saved} onClick={onClose}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function UsageDialog({ apiKey, onClose }: { apiKey: ApiKey; onClose: () => void }) {
  const usage = useFetch<Page<Usage>>(`/api-keys/${apiKey.id}/usage?limit=50`);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Usage of “{apiKey.name}”</DialogTitle>
          <DialogDescription>The latest calls, refused ones included. Lines are kept for 90 days.</DialogDescription>
        </DialogHeader>
        <ErrorText>{usage.error}</ErrorText>
        {usage.data?.items.length === 0 && <p className="text-sm text-muted-foreground">Not used yet.</p>}
        <ul className="max-h-96 divide-y overflow-y-auto text-sm">
          {usage.data?.items.map((u, i) => (
            <li key={i} className="flex items-center gap-3 py-2">
              <span className="w-36 shrink-0 text-xs text-muted-foreground">{new Date(u.at).toLocaleString()}</span>
              <span className="w-14 shrink-0 font-mono text-xs">{u.method}</span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs">{u.path}</span>
              <Badge variant={u.status < 400 ? "default" : "destructive"}>{u.status}</Badge>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
