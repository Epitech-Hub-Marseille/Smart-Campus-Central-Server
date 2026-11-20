import { Check, CheckCheck, Mail, MailOpen, Plus } from "lucide-react";
import { useState, type FormEvent } from "react";
import { canEditCampus, useAuth } from "@/auth/AuthContext";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { ANNOUNCE_PRIORITIES, PRIORITY_LABEL, ROLE_LABEL, type AnnouncePriority, type InboxMessage, type Page, type Role, type SentMessage } from "@/lib/types";
import { useUnread } from "@/lib/unread";
import { useFetch } from "@/lib/useFetch";
import { cn } from "@/lib/utils";

const PriorityTag = ({ priority }: { priority: AnnouncePriority }) =>
  priority === "info" ? null : <Badge variant={priority === "urgent" ? "destructive" : "default"}>{PRIORITY_LABEL[priority]}</Badge>;

const when = (iso: string) => new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });

/** Messages from the administration. Everyone reads theirs; administrators and operators also write and see who has read. */
export function MessagesPage() {
  const { user } = useAuth();
  const manager = canEditCampus(user);
  const [tab, setTab] = useState<"inbox" | "sent">("inbox");
  const [composing, setComposing] = useState(false);
  const { refresh } = useUnread();

  return (
    <div>
      <PageHeader
        title="Messages"
        description={manager ? "Notices to the staff, with a read receipt for each person. Alerts about the campus also arrive here." : "Notices from the administration."}
        actions={
          manager && (
            <Button onClick={() => setComposing(true)}>
              <Plus /> New message
            </Button>
          )
        }
      />
      {manager && (
        <div role="tablist" aria-label="Messages" className="mb-4 inline-flex rounded-lg border bg-card p-0.5 text-sm">
          {(["inbox", "sent"] as const).map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn("rounded-md px-3 py-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring/60", tab === t ? "bg-accent font-medium" : "text-muted-foreground hover:text-foreground")}
            >
              {t === "inbox" ? "Received" : "Sent"}
            </button>
          ))}
        </div>
      )}
      {tab === "inbox" || !manager ? <Inbox /> : <Sent />}
      {composing && (
        <Compose
          onClose={() => setComposing(false)}
          onSent={() => {
            setComposing(false);
            setTab("sent");
            refresh();
          }}
        />
      )}
    </div>
  );
}

function Inbox() {
  const list = useFetch<Page<InboxMessage> & { unread: number }>("/messages/inbox?limit=50");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { refresh } = useUnread();

  async function read(m: InboxMessage) {
    setOpen(open === m.id ? null : m.id);
    if (m.readAt) return;
    try {
      await api(`/messages/${m.id}/read`, { method: "POST" });
      list.reload();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark the message as read");
    }
  }

  async function readAll() {
    setError(null);
    try {
      await api("/messages/read-all", { method: "POST" });
      list.reload();
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not mark the messages as read");
    }
  }

  const items = list.data?.items ?? [];
  return (
    <div className="space-y-3">
      <ErrorText>{list.error ?? error}</ErrorText>
      {(list.data?.unread ?? 0) > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>{list.data!.unread} unread</span>
          <Button variant="ghost" size="sm" onClick={() => void readAll()}>
            <CheckCheck /> Mark all as read
          </Button>
        </div>
      )}
      <ul className="divide-y rounded-xl border bg-card">
        {items.map((m) => {
          const expanded = open === m.id;
          return (
            <li key={m.id}>
              <button
                aria-expanded={expanded}
                onClick={() => void read(m)}
                className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
              >
                {m.readAt ? <MailOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden /> : <Mail className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className={cn("truncate text-sm", !m.readAt && "font-semibold")}>{m.subject}</span>
                    <PriorityTag priority={m.priority} />
                    {!m.readAt && <span className="sr-only">Unread</span>}
                  </div>
                  {expanded ? (
                    <p className="mt-2 text-sm whitespace-pre-wrap">{m.body}</p>
                  ) : (
                    <p className="mt-0.5 truncate text-sm text-muted-foreground">{m.body}</p>
                  )}
                </div>
                <div className="shrink-0 text-right text-xs text-muted-foreground">
                  <div>{m.sender}</div>
                  <div>{when(m.sentAt)}</div>
                </div>
              </button>
            </li>
          );
        })}
        {!list.loading && items.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted-foreground">No message yet.</li>}
      </ul>
    </div>
  );
}

function Sent() {
  const list = useFetch<Page<SentMessage>>("/messages/sent?limit=50");
  const [detail, setDetail] = useState<string | null>(null);
  const items = list.data?.items ?? [];
  return (
    <div className="space-y-3">
      <ErrorText>{list.error}</ErrorText>
      <ul className="divide-y rounded-xl border bg-card">
        {items.map((m) => (
          <li key={m.id}>
            <button
              onClick={() => setDetail(m.id)}
              className="flex w-full items-start gap-3 px-4 py-3 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-inset"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{m.subject}</span>
                  <PriorityTag priority={m.priority} />
                </div>
                <p className="mt-0.5 truncate text-sm text-muted-foreground">{m.body}</p>
              </div>
              <div className="shrink-0 text-right text-xs text-muted-foreground">
                <div className="tabular-nums">
                  {m.readCount}/{m.recipientCount} read
                </div>
                <div>{when(m.sentAt)}</div>
              </div>
            </button>
          </li>
        ))}
        {!list.loading && items.length === 0 && <li className="px-4 py-10 text-center text-sm text-muted-foreground">You have not sent a message yet.</li>}
      </ul>
      {detail && <Receipts id={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

/** Who got a message and who has opened it. */
function Receipts({ id, onClose }: { id: string; onClose: () => void }) {
  const detail = useFetch<SentMessage>(`/messages/sent/${id}`);
  const m = detail.data;
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{m?.subject ?? "Message"}</DialogTitle>
        </DialogHeader>
        <ErrorText>{detail.error}</ErrorText>
        {m && (
          <div className="space-y-4">
            <p className="text-sm whitespace-pre-wrap">{m.body}</p>
            <div>
              <div className="mb-2 text-sm font-medium">
                Read by {m.readCount} of {m.recipientCount}
              </div>
              <ul className="max-h-64 divide-y overflow-y-auto rounded-lg border text-sm">
                {m.recipients?.map((r) => (
                  <li key={r.userId} className="flex items-center gap-2 px-3 py-2">
                    <span className="min-w-0 flex-1 truncate">{r.name}</span>
                    {r.readAt ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Check className="size-3.5 text-primary" aria-hidden /> Read {when(r.readAt)}
                      </span>
                    ) : (
                      <span className="text-xs text-muted-foreground">Not read yet</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const AUDIENCE_ROLES: Role[] = ["admin", "operator", "staff"];

function Compose({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<AnnouncePriority>("info");
  const [everyone, setEveryone] = useState(true);
  const [roles, setRoles] = useState<Role[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!everyone && roles.length === 0) return setError("Choose who receives this message.");
    setBusy(true);
    setError(null);
    try {
      await api("/messages", { method: "POST", body: { subject, body, priority, audience: everyone ? { kind: "everyone" } : { kind: "roles", roles } } });
      onSent();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the message");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <Field label="Subject" htmlFor="m-subject">
            <Input id="m-subject" required maxLength={160} value={subject} onChange={(e) => setSubject(e.target.value)} />
          </Field>
          <Field label="Message" htmlFor="m-body">
            <textarea
              id="m-body"
              required
              rows={5}
              maxLength={4000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </Field>
          <Field label="Priority" htmlFor="m-priority">
            <Select id="m-priority" value={priority} onChange={(e) => setPriority(e.target.value as AnnouncePriority)}>
              {ANNOUNCE_PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="flex flex-col gap-2 text-sm">
            <legend className="mb-1 font-medium">Send to</legend>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> Everyone with an account
            </label>
            {!everyone &&
              AUDIENCE_ROLES.map((r) => (
                <label key={r} className="flex items-center gap-2 pl-6">
                  <input type="checkbox" checked={roles.includes(r)} onChange={(e) => setRoles((cur) => (e.target.checked ? [...cur, r] : cur.filter((x) => x !== r)))} />
                  {r === "staff" ? "Staff" : `${ROLE_LABEL[r]}s`}
                </label>
              ))}
          </fieldset>
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Send
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
