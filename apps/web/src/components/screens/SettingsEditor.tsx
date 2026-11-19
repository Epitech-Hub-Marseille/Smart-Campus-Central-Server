import { RotateCcw } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { ErrorText, Field } from "@/components/Field";
import { MediaField } from "@/components/MediaPicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import { getPath, hasPath, setPath, unsetPath } from "@/lib/screens";
import { SERVICES, SERVICE_LABEL, type FacultyConfigPatch, type ScopeView, type TileKinds } from "@/lib/types";

type Path = readonly string[];

/** Label, source badge and reset button around any control. Defined here, not inside the editor, so typing keeps its focus. */
function FieldRow({ own, inherited, levelName, onReset, label, htmlFor, inline, children }: { own: boolean; inherited: boolean; levelName: string; onReset: () => void; label?: string; htmlFor?: string; inline?: boolean; children: ReactNode }) {
  const badge = (
    <span className="ml-auto flex shrink-0 items-center gap-2">
      {own ? <Badge>Set for {levelName}</Badge> : <Badge variant="muted">{inherited ? "Inherited" : "Default"}</Badge>}
      {own && (
        <Button type="button" variant="ghost" size="sm" onClick={onReset} aria-label={`Reset ${label ?? "this setting"}`}>
          <RotateCcw /> Reset
        </Button>
      )}
    </span>
  );
  // A checkbox has its own label: the badge sits on its row instead of on a line of its own.
  if (inline)
    return (
      <div className="flex items-center justify-between gap-2">
        {children}
        {badge}
      </div>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {label && (htmlFor ? <label htmlFor={htmlFor} className="text-sm leading-none font-medium">{label}</label> : <span className="text-sm leading-none font-medium">{label}</span>)}
        {badge}
      </div>
      {children}
    </div>
  );
}

/**
 * The look of a level. Every field is either set here or inherited from the level above; the badge says which,
 * and "Reset" removes the value set here so the field follows the level above again.
 */
export function SettingsEditor({ view, registry, onSaved }: { view: ScopeView; registry: TileKinds; onSaved: () => void }) {
  const [patch, setPatch] = useState<FacultyConfigPatch>(view.config);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setPatch(view.config);
    setError(null);
  }, [view.scope, view.key, view.config]);

  const dirty = JSON.stringify(patch) !== JSON.stringify(view.config);
  const levelName = view.scope === "device" ? "this screen" : view.scope === "group" ? "this group" : "all screens";
  const hasAbove = view.scope !== "default";

  /** Value to show: set here, else inherited, else the plain default. */
  function value<T>(path: Path): T {
    if (hasPath(patch, path)) return getPath(patch, path) as T;
    if (hasPath(view.inherited.config, path)) return getPath(view.inherited.config, path) as T;
    return getPath(registry.defaults, path) as T;
  }
  const edit = (path: Path, v: unknown) => {
    setPatch((p) => setPath(p, path, v));
    setSaved(false);
  };
  const reset = (path: Path) => {
    setPatch((p) => unsetPath(p, path));
    setSaved(false);
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api(`/faculty/scopes/${view.scope}/${view.key}/config`, { method: "PUT", body: patch });
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  /** What a row needs to say where its value comes from. */
  const rp = (path: Path) => ({
    own: hasPath(patch, path),
    inherited: hasAbove && hasPath(view.inherited.config, path),
    levelName,
    onReset: () => reset(path),
  });

  const text = (path: Path, label: string, id: string, max: number, hint?: string) => (
    <FieldRow {...rp(path)} label={label} htmlFor={id}>
      <Input id={id} maxLength={max} value={value<string>(path)} onChange={(e) => edit(path, e.target.value)} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </FieldRow>
  );
  const check = (path: Path, label: string, id: string) => (
    <FieldRow {...rp(path)} label={label} inline>
      <label className="flex items-center gap-2 text-sm" htmlFor={id}>
        <input id={id} type="checkbox" className="size-4 accent-[var(--primary)]" checked={value<boolean>(path)} onChange={(e) => edit(path, e.target.checked)} />
        {label}
      </label>
    </FieldRow>
  );

  const weather = value<{ label: string; latitude: number; longitude: number } | null>(["weather"]);
  const setWeather = (next: Partial<{ label: string; latitude: number; longitude: number }>) => edit(["weather"], { label: "", latitude: 0, longitude: 0, ...(weather ?? {}), ...next });

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">
        {hasAbove
          ? `A field set here wins over the levels above. Fields you leave alone keep following them, and Reset hands one back.`
          : "These apply to every screen unless a group or a screen sets its own."}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
          <CardDescription>Shown in the header of the board and on the emergency screen.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          {text(["site", "name"], "Name", "s-name", 80)}
          {text(["site", "subtitle"], "Subtitle", "s-subtitle", 120)}
          <div className="sm:col-span-2">
            <FieldRow {...rp(["site", "logo"])} label="Logo">
              <MediaField
                id="s-logo"
                label="Logo"
                accept="image"
                hideLabel
                value={value<{ assetId: string } | null>(["site", "logo"])?.assetId ?? null}
                // Removing the logo here is a choice ("no logo"), not the same as inheriting.
                onChange={(id) => edit(["site", "logo"], id ? { assetId: id } : null)}
                clearable
              />
            </FieldRow>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Emergency details</CardTitle>
          <CardDescription>What people need to read when an alert takes over the screen.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-3">
          {text(["site", "zone"], "Building or zone", "s-zone", 60)}
          {text(["site", "assemblyPoint"], "Assembly point", "s-assembly", 80)}
          {text(["site", "emergencyNumber"], "Emergency number", "s-number", 30)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Content and widgets</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5 sm:grid-cols-2">
          <FieldRow {...rp(["service"])} label="Staff shown" htmlFor="s-service">
            <Select id="s-service" value={value<string>(["service"])} onChange={(e) => edit(["service"], e.target.value)}>
              <option value="all">Everyone</option>
              {SERVICES.map((s) => (
                <option key={s} value={s}>
                  {SERVICE_LABEL[s]} only
                </option>
              ))}
            </Select>
          </FieldRow>
          {check(["carousel", "enabled"], "Rotate through the scenes (otherwise the first stays)", "s-rotate")}
          {check(["widgets", "clock"], "Clock", "s-clock")}
          {check(["widgets", "date"], "Date", "s-date")}
          {check(["widgets", "weather"], "Weather", "s-weather")}
        </CardContent>
      </Card>

      {value<boolean>(["widgets", "weather"]) && (
        <Card>
          <CardHeader>
            <CardTitle>Weather position</CardTitle>
            <CardDescription>The screen fetches the weather itself from this position.</CardDescription>
          </CardHeader>
          <CardContent>
            <FieldRow {...rp(["weather"])}>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Place name" htmlFor="w-label">
                  <Input id="w-label" maxLength={60} value={weather?.label ?? ""} onChange={(e) => setWeather({ label: e.target.value })} />
                </Field>
                <Field label="Latitude" htmlFor="w-lat">
                  <Input id="w-lat" type="number" step="any" min={-90} max={90} value={weather?.latitude ?? ""} onChange={(e) => setWeather({ latitude: Number(e.target.value) })} />
                </Field>
                <Field label="Longitude" htmlFor="w-lon">
                  <Input id="w-lon" type="number" step="any" min={-180} max={180} value={weather?.longitude ?? ""} onChange={(e) => setWeather({ longitude: Number(e.target.value) })} />
                </Field>
              </div>
            </FieldRow>
          </CardContent>
        </Card>
      )}

      <ErrorText>{error}</ErrorText>
      <div className="flex items-center justify-end gap-3">
        {saved && !dirty && <span role="status" className="text-sm text-primary">Saved.</span>}
        <Button type="button" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
      </div>
    </div>
  );
}
