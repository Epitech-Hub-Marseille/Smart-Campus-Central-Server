import { ShieldAlert, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/auth/AuthContext";
import { EmergencyPreview } from "@/components/EmergencyPreview";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { emptyTargetState, TargetPicker, toTargets, type TargetState } from "@/components/TargetPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api, ApiError } from "@/lib/api";
import { useDeviceStatus } from "@/lib/DeviceStatus";
import { timeAgo, type Emergency, type EmergencyConfirmation, type EmergencyInfo, type EmergencyKind, type Page, type VoiceCatalogue } from "@/lib/types";
import { useFetch, useOnChange } from "@/lib/useFetch";

export function EmergencyPage() {
  const catalogue = useFetch<{ items: EmergencyInfo[] }>("/emergencies/catalogue");
  const active = useFetch<Page<Emergency>>("/emergencies?status=active&limit=50");
  const history = useFetch<Page<Emergency>>("/emergencies?limit=20");
  const { version } = useDeviceStatus();

  const reloadAll = () => {
    active.reload();
    history.reload();
  };
  // Another console may trigger or clear an alert, and a screen starts reporting it: stay current.
  useOnChange(version, reloadAll);
  const infoOf = (kind: EmergencyKind) => catalogue.data?.items.find((i) => i.kind === kind);

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Emergency alerts"
        description="Takes over the door screens and sounds an alarm until you end it. A test uses the same screens with a quiet alarm."
      />
      <ErrorText>{catalogue.error ?? active.error}</ErrorText>

      {active.data && active.data.items.length > 0 && <ActiveAlerts alerts={active.data.items} onChanged={reloadAll} />}

      {catalogue.data && <Trigger catalogue={catalogue.data.items} onTriggered={reloadAll} />}

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-semibold">History</h2>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Alert</TableHead>
              <TableHead>Screens</TableHead>
              <TableHead>Started</TableHead>
              <TableHead>Ended</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.data?.items.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <span className="mr-2 inline-block size-2 rounded-full align-middle" style={{ background: infoOf(e.kind)?.color }} aria-hidden />
                  <span className="font-medium">{e.title}</span>
                  {e.testMode && <Badge variant="muted" className="ml-2">Test</Badge>}
                </TableCell>
                <TableCell>{e.deviceCount}</TableCell>
                <TableCell className="text-muted-foreground">
                  {e.startedBy}, {timeAgo(e.startedAt)}
                </TableCell>
                <TableCell className="text-muted-foreground">{e.clearedAt ? `${e.clearedBy}, ${timeAgo(e.clearedAt)}` : "–"}</TableCell>
                <TableCell>
                  <Badge variant={e.status === "active" ? "destructive" : "muted"}>{e.status === "active" ? "Sounding" : "Ended"}</Badge>
                </TableCell>
              </TableRow>
            ))}
            {!history.loading && history.data?.items.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="py-10 text-center text-muted-foreground">
                  <ShieldAlert className="mx-auto mb-2 size-6" /> No alert has been triggered yet.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </section>
    </div>
  );
}

function ActiveAlerts({ alerts, onChanged }: { alerts: Emergency[]; onChanged: () => void }) {
  const [ending, setEnding] = useState<Emergency | null>(null);

  return (
    <section aria-label="Active alerts" className="flex flex-col gap-3 rounded-xl border border-destructive/50 bg-destructive/5 p-4">
      <h2 className="text-base font-semibold text-destructive">{alerts.length === 1 ? "An alert is active" : `${alerts.length} alerts are active`}</h2>
      {alerts.map((alert) => (
        <ActiveAlert key={alert.id} alert={alert} onEnd={() => setEnding(alert)} />
      ))}
      {ending && (
        <EndDialog
          alert={ending}
          onClose={() => setEnding(null)}
          onEnded={() => {
            setEnding(null);
            onChanged();
          }}
        />
      )}
    </section>
  );
}

const DEFAULT_END_MESSAGE = "The alert is over. You may return to the building. Follow staff instructions.";

/** Ends an alert with a message the screens show afterwards, optionally read out loud. */
function EndDialog({ alert, onClose, onEnded }: { alert: Emergency; onClose: () => void; onEnded: () => void }) {
  const voices = useFetch<VoiceCatalogue>("/intercom/voices");
  const [message, setMessage] = useState(DEFAULT_END_MESSAGE);
  const [speak, setSpeak] = useState(false);
  const limits = useFetch<{ min: number; max: number; default: number }>("/emergencies/end-notice");
  // Empty means "the default", so the field never shows a number the person did not choose.
  const [seconds, setSeconds] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function end() {
    setBusy(true);
    setError(null);
    try {
      await api(`/emergencies/${alert.id}/clear`, { body: { ...(message.trim() && { message: message.trim() }), ...(message.trim() && seconds && { noticeSeconds: Number(seconds) }), speak: speak && Boolean(message.trim()) } });
      onEnded();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not end the alert");
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>End "{alert.title}"</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field label="End-of-alert message" htmlFor="end-message" hint="Shown on the screens for a while after the alarm stops. Empty: the alarm just stops.">
            <textarea
              id="end-message"
              rows={3}
              maxLength={400}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </Field>
          {limits.data && (
            <Field
              label="Show the message for (seconds)"
              htmlFor="end-seconds"
              hint={`Between ${limits.data.min} and ${limits.data.max}. Empty: ${limits.data.default} seconds, then the door screen comes back.`}
            >
              <Input
                id="end-seconds"
                type="number"
                inputMode="numeric"
                min={limits.data.min}
                max={limits.data.max}
                step={1}
                placeholder={String(limits.data.default)}
                value={seconds}
                disabled={!message.trim()}
                onChange={(e) => setSeconds(e.target.value)}
                className="max-w-40"
              />
            </Field>
          )}
          {voices.data?.enabled && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-primary" checked={speak} disabled={!message.trim()} onChange={(e) => setSpeak(e.target.checked)} />
              Also read it out loud on the speakers
            </label>
          )}
          <ErrorText>{error}</ErrorText>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>
              Keep the alert
            </Button>
            <Button variant="destructive" disabled={busy} onClick={() => void end()}>
              <X /> {busy ? "Ending…" : "End alert"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ActiveAlert({ alert, onEnd }: { alert: Emergency; onEnd: () => void }) {
  const { version } = useDeviceStatus();
  const detail = useFetch<{ delivery: { deviceId: string; name: string; showing: boolean }[] }>(`/emergencies/${alert.id}`);
  useOnChange(version, detail.reload);

  const showing = detail.data?.delivery.filter((d) => d.showing).length ?? 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <div className="font-medium">
          {alert.title}
          {alert.testMode && <Badge variant="muted" className="ml-2">Test</Badge>}
        </div>
        <div className="text-sm text-muted-foreground">
          Started by {alert.startedBy}, {timeAgo(alert.startedAt)}. Showing on {showing} of {alert.deviceCount} screen{alert.deviceCount === 1 ? "" : "s"}.
        </div>
        {(alert.voice.status === "failed" || alert.voice.status === "unavailable") && (
          <div role="alert" className="text-sm text-destructive">
            The voice message could not be played{alert.voice.error ? `: ${alert.voice.error}` : " because no voice engine is configured"}. The alarm and the screens are not affected.
          </div>
        )}
      </div>
      <Button variant="destructive" onClick={onEnd}>
        <X /> End alert
      </Button>
    </div>
  );
}

function Trigger({ catalogue, onTriggered }: { catalogue: EmergencyInfo[]; onTriggered: () => void }) {
  const [kind, setKind] = useState<EmergencyKind>("fire");
  const [testMode, setTestMode] = useState(true);
  const [testVolume, setTestVolume] = useState(20);
  const [targets, setTargets] = useState<TargetState>(emptyTargetState());
  const [speak, setSpeak] = useState(false);
  // Every alert, test or real, needs a code from the authenticator app: a session alone cannot sound an alarm.
  const [code, setCode] = useState("");
  const { user } = useAuth();
  // Step one of a real alert: the server describes what is about to happen and hands out a token.
  const [pending, setPending] = useState<EmergencyConfirmation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const voices = useFetch<VoiceCatalogue>("/intercom/voices");
  const info = catalogue.find((i) => i.kind === kind)!;
  const secondsLeft = useCountdown(pending?.expiresAt ?? null);
  const emergencyVoice = voices.data?.voices.find((v) => v.id === voices.data?.emergencyVoice);
  const emergencyVoiceLabel = emergencyVoice?.label.replace(/\s*\(.*\)$/, "");

  // The confirmation is only valid for the alert it was asked for: any change starts over.
  const cancelPending = () => setPending(null);
  useEffect(() => {
    if (pending && secondsLeft === 0) {
      setPending(null);
      setError("The confirmation expired. Start again.");
    }
  }, [pending, secondsLeft]);

  const body = () => {
    const chosen = toTargets(targets);
    return chosen ? { kind, targets: chosen, testMode, testVolume, speak } : null;
  };
  const needsSetup = !user?.twoFactor.enabled;

  async function onClick() {
    const alert = body();
    if (!alert) return setError("Choose which screens to alert");
    // The code is only asked for when the alert is actually sent; the first step of a real alert sends nothing.
    const sending = testMode || Boolean(pending);
    if (sending && !/^\d{6}$/.test(code.replace(/\s/g, ""))) return setError("Enter the 6-digit code from your authenticator app");
    setBusy(true);
    setError(null);
    try {
      if (testMode) {
        await api("/emergencies", { body: { ...alert, twoFactorCode: code } });
        setCode("");
        onTriggered();
      } else if (!pending) {
        // A real alert needs two steps, enforced by the server: it sounds a full-volume alarm in the building.
        setPending(await api<EmergencyConfirmation>("/emergencies/confirmations", { body: alert }));
      } else {
        await api("/emergencies", { body: { ...alert, confirmation: pending.confirmation, twoFactorCode: code } });
        setPending(null);
        setCode("");
        onTriggered();
      }
    } catch (e) {
      // A wrong code keeps the confirmation: the alert is the same, only the code has to be typed again.
      if (!(e instanceof ApiError && e.code === "two_factor_invalid")) setPending(null);
      setCode("");
      setError(e instanceof Error ? e.message : "Could not trigger the alert");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Trigger an alert</CardTitle>
        <CardDescription>Choose the emergency, whether it is a test, and where to send it.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]">
        <div className="flex flex-col gap-5">
          <div role="group" aria-label="Kind of emergency" className="grid grid-cols-2 gap-2">
            {catalogue.map((i) => (
              <button
                key={i.kind}
                type="button"
                aria-pressed={i.kind === kind}
                onClick={() => {
                  setKind(i.kind);
                  cancelPending();
                }}
                className="flex items-center gap-2 rounded-lg border px-3 py-2.5 text-left text-sm outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring/40 aria-pressed:bg-accent aria-pressed:font-medium"
                style={i.kind === kind ? { borderColor: i.color } : undefined}
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: i.color }} aria-hidden />
                {i.title}
              </button>
            ))}
          </div>

          <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 accent-primary"
              checked={testMode}
              onChange={(e) => {
                setTestMode(e.target.checked);
                cancelPending();
              }}
            />
            <span>
              <span className="font-medium">Test mode</span>
              <span className="block text-muted-foreground">The screen says it is a test and the alarm plays quietly. Quiet hours still apply.</span>
            </span>
          </label>

          {testMode ? (
            <Field label={`Test volume: ${testVolume}%`} htmlFor="e-volume">
              <input id="e-volume" type="range" min={0} max={100} step={5} value={testVolume} onChange={(e) => setTestVolume(Number(e.target.value))} className="w-full accent-primary" />
            </Field>
          ) : (
            <p className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              {info.loud ? "Real alert: the alarm plays at full volume and ignores each screen's volume and quiet hours." : "Real alert: a soft chime plays. It ignores quiet hours."}
            </p>
          )}

          <TargetPicker value={targets} onChange={(t) => (setTargets(t), cancelPending())} />

          {voices.data?.enabled && (
            <label className="flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 accent-primary"
                checked={speak}
                onChange={(e) => {
                  setSpeak(e.target.checked);
                  cancelPending();
                }}
              />
              <span>
                <span className="font-medium">Also read the instructions aloud</span>
                <span className="block text-muted-foreground">{emergencyVoiceLabel ? `${emergencyVoiceLabel} reads` : "A voice reads"} them on the speakers after the alarm starts. If it fails, the alarm and the screens are not affected.</span>
              </span>
            </label>
          )}
          {pending && (
            <p role="status" className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              This will sound “{pending.title}” on {pending.deviceCount} screen{pending.deviceCount === 1 ? "" : "s"}. Confirm within {secondsLeft} s.
            </p>
          )}
          {needsSetup ? (
            <p role="alert" className="rounded-lg border border-destructive/50 bg-destructive/5 p-3 text-sm">
              Alerts need two-factor authentication. <Link to="/security" className="text-primary underline-offset-4 hover:underline">Set it up</Link> first.
            </p>
          ) : (testMode || pending) && (
            <Field label="Authenticator code" htmlFor="e-code" hint="Required for every alert, including tests.">
              <Input id="e-code" inputMode="numeric" autoComplete="one-time-code" maxLength={7} value={code} onChange={(e) => setCode(e.target.value)} className="max-w-40 font-mono tracking-widest" />
            </Field>
          )}
          <ErrorText>{error}</ErrorText>

          <div className="flex gap-2">
            <Button variant={testMode ? "default" : "destructive"} disabled={busy || needsSetup} onClick={() => void onClick()}>
              {busy ? "Sending…" : testMode ? "Start test" : pending ? "Confirm: sound the alarm" : "Trigger alert"}
            </Button>
            {pending && (
              <Button variant="ghost" onClick={cancelPending}>
                Cancel
              </Button>
            )}
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium text-muted-foreground">What the door screens will show</h3>
          <EmergencyPreview kind={kind} title={info.title} instructions={info.instructions} testMode={testMode} />
        </div>
      </CardContent>
    </Card>
  );
}

/** Whole seconds until `iso`, ticking every second. Null while there is nothing to count down to. */
function useCountdown(iso: string | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!iso) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [iso]);
  return iso ? Math.max(0, Math.ceil((new Date(iso).getTime() - now) / 1000)) : null;
}
