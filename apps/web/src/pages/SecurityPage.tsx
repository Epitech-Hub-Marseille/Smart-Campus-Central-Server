import { Check, Copy, Download, ShieldCheck } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useState, type FormEvent } from "react";
import { useAuth } from "@/auth/AuthContext";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useFetch } from "@/lib/useFetch";

interface Status {
  enabled: boolean;
  required: boolean;
  enabledAt: string | null;
  recoveryCodesLeft: number;
}

/** The person's own security: two-factor authentication and its recovery codes. */
export function SecurityPage() {
  const { user, refreshUser } = useAuth();
  const status = useFetch<Status>("/auth/2fa");
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");

  const s = status.data;
  const forced = Boolean(user?.twoFactor.required && !user.twoFactor.enabled);

  async function run(job: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await job();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  const start = () => run(async () => setSetup(await api<{ secret: string; uri: string }>("/auth/2fa/setup", { method: "POST" })));
  const enable = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await api<{ recoveryCodes: string[] }>("/auth/2fa/enable", { body: { code } });
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode("");
      status.reload();
      await refreshUser();
    });
  };
  const disable = () =>
    run(async () => {
      await api("/auth/2fa/disable", { body: { code } });
      setCode("");
      status.reload();
      await refreshUser();
    });
  const regenerate = () =>
    run(async () => {
      const r = await api<{ recoveryCodes: string[] }>("/auth/2fa/recovery-codes", { body: { code } });
      setCodes(r.recoveryCodes);
      setCode("");
      status.reload();
    });

  return (
    <div className="max-w-3xl">
      <PageHeader title="Security" description="Protect your account with a second step at sign-in." />
      {forced && (
        <p role="alert" className="mb-4 rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
          Administrators must use two-factor authentication. Set it up to continue to the console.
        </p>
      )}
      <ErrorText>{status.error ?? error}</ErrorText>

      <Card>
        <CardHeader className="flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <CardTitle>Two-factor authentication</CardTitle>
            <CardDescription>A code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) after your password. It is also asked every time you start an emergency alert, tests included.</CardDescription>
          </div>
          {s && (s.enabled ? <Badge>On</Badge> : <Badge variant="muted">Off</Badge>)}
        </CardHeader>
        <CardContent className="flex flex-col gap-5">
          {s && !s.enabled && !setup && (
            <div>
              <Button onClick={() => void start()} disabled={busy}>
                <ShieldCheck /> Set up two-factor authentication
              </Button>
            </div>
          )}

          {setup && <SetupPanel setup={setup} code={code} setCode={setCode} onSubmit={enable} onCancel={() => (setSetup(null), setCode(""))} busy={busy} />}

          {s?.enabled && (
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">
                On since {s.enabledAt ? new Date(s.enabledAt).toLocaleDateString() : "–"}. {s.recoveryCodesLeft} recovery code{s.recoveryCodesLeft === 1 ? "" : "s"} left.
              </p>
              <Field label="Code from your authenticator app" htmlFor="sec-code" hint="Needed to change anything here.">
                <Input id="sec-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="max-w-40 font-mono tracking-widest" />
              </Field>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" disabled={busy || code.replace(/\s/g, "").length !== 6} onClick={() => void regenerate()}>
                  New recovery codes
                </Button>
                {!s.required && (
                  <Button variant="destructive" disabled={busy || code.replace(/\s/g, "").length !== 6} onClick={() => void disable()}>
                    Turn off
                  </Button>
                )}
              </div>
              {s.required && <p className="text-xs text-muted-foreground">Administrators cannot turn it off. If you lose your phone, use a recovery code, or ask another administrator to reset it.</p>}
            </div>
          )}
        </CardContent>
      </Card>

      {codes && <RecoveryCodes codes={codes} onClose={() => setCodes(null)} />}
    </div>
  );
}

function SetupPanel({ setup, code, setCode, onSubmit, onCancel, busy }: { setup: { secret: string; uri: string }; code: string; setCode: (v: string) => void; onSubmit: (e: FormEvent) => void; onCancel: () => void; busy: boolean }) {
  const [qr, setQr] = useState<string | null>(null);
  useEffect(() => {
    void QRCode.toDataURL(setup.uri, { margin: 1, width: 224 }).then(setQr);
  }, [setup.uri]);
  return (
    <form onSubmit={onSubmit} className="grid gap-6 sm:grid-cols-[14rem_1fr]">
      <div className="grid aspect-square w-56 place-items-center rounded-lg border bg-white">{qr ? <img src={qr} alt="QR code to add this account to your authenticator app" className="size-56" /> : null}</div>
      <div className="flex flex-col gap-4">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-muted-foreground">
          <li>Scan the code with your authenticator app.</li>
          <li>Or enter this key by hand: <code className="font-mono text-foreground">{setup.secret.match(/.{1,4}/g)?.join(" ")}</code></li>
          <li>Type the 6-digit code it shows.</li>
        </ol>
        <Field label="Code" htmlFor="setup-code">
          <Input id="setup-code" required autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="max-w-40 font-mono tracking-widest" />
        </Field>
        <div className="flex gap-2">
          <Button type="submit" disabled={busy || code.replace(/\s/g, "").length !== 6}>
            Turn on
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </div>
    </form>
  );
}

/** Shown once: the server keeps only hashes, so a closed dialog cannot be reopened. */
function RecoveryCodes({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const text = codes.join("\n");
  return (
    <Dialog open onOpenChange={(open) => open || (saved && onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Your recovery codes</DialogTitle>
          <DialogDescription>Keep them somewhere safe. Each works once, if you lose your phone. They are shown only now.</DialogDescription>
        </DialogHeader>
        <ul className="grid grid-cols-2 gap-2 rounded-lg border bg-secondary/40 p-4 font-mono text-sm">
          {codes.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true))}
          >
            {copied ? <Check /> : <Copy />} {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" asChild>
            <a href={`data:text/plain;charset=utf-8,${encodeURIComponent(text + "\n")}`} download="smart-campus-recovery-codes.txt">
              <Download /> Download
            </a>
          </Button>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          I have saved these codes
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
