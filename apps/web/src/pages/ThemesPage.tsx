import { Download, Palette, Plus, Trash2, Upload } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { ErrorText, Field } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { api } from "@/lib/api";
import type { Device } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";
import { cn } from "@/lib/utils";

interface Tokens {
  mode?: "light" | "dark";
  colors?: Record<string, string | undefined>;
  typography?: { fontFamily?: string; scale?: number };
  shape?: { radius?: number };
}
interface Theme {
  id: string;
  name: string;
  description: string;
  tokens: Tokens;
  css: string;
  version: number;
}
interface Schema {
  colors: string[];
  fonts: string[];
  limits: { css: number; name: number; scaleMin: number; scaleMax: number; radiusMax: number };
}
interface Assignment {
  scope: "default" | "group" | "device";
  key: string;
  themeId: string;
  themeName: string;
}

const COLOR_LABEL: Record<string, string> = {
  background: "Background",
  surface: "Cards",
  text: "Text",
  muted: "Secondary text",
  primary: "Accent",
  primaryText: "Text on accent",
  border: "Borders",
  success: "Success",
  warning: "Warning",
  danger: "Danger",
};
const FONT_LABEL: Record<string, string> = { system: "System", sans: "Sans-serif", serif: "Serif", mono: "Monospace", condensed: "Condensed" };
const FONT_STACK: Record<string, string> = {
  system: "system-ui, sans-serif",
  sans: '"Inter Variable", Inter, system-ui, sans-serif',
  serif: "Georgia, 'Times New Roman', serif",
  mono: "ui-monospace, 'JetBrains Mono', Menlo, monospace",
  condensed: "'Barlow Condensed', 'Arial Narrow', sans-serif",
};
/** The colours a screen uses when a theme does not say, so the preview of a partial theme is honest. */
const BASE = { background: "#ffffff", surface: "#f5f7fc", text: "#101828", muted: "#5b667a", primary: "#1d4f9f", primaryText: "#ffffff", border: "#dfe4ee", success: "#1f9d55", warning: "#c77700", danger: "#d1332b" };

const blank = (): Theme => ({ id: "", name: "", description: "", tokens: { colors: {}, typography: {}, shape: {} }, css: "", version: 0 });

/** Quick local hints, so a mistake shows before saving. The server is the judge and says the same on save. */
const cssHints = (css: string) => [/@import/i.test(css) && "@import is not allowed", /url\s*\(/i.test(css) && "url() is not allowed", /@font-face/i.test(css) && "@font-face is not allowed"].filter(Boolean) as string[];

const colorsOf = (t: Tokens) => ({ ...BASE, ...Object.fromEntries(Object.entries(t.colors ?? {}).filter(([, v]) => v)) });

export function ThemesPage() {
  const themes = useFetch<{ items: Theme[] }>("/themes");
  const schema = useFetch<Schema>("/themes/schema");
  const [selected, setSelected] = useState<string | "new" | null>(null);
  const current = selected === "new" ? blank() : themes.data?.items.find((t) => t.id === selected);

  useEffect(() => {
    if (selected === null && themes.data?.items[0]) setSelected(themes.data.items[0].id);
  }, [selected, themes.data]);

  return (
    <div>
      <PageHeader
        title="Themes"
        description="The look of the door units and the Faculty screens: colours, font, text size and corners as JSON, and optional CSS for the Faculty screens. Emergency alerts are never themed."
        actions={
          <Button onClick={() => setSelected("new")}>
            <Plus /> New theme
          </Button>
        }
      />
      <ErrorText>{themes.error ?? schema.error}</ErrorText>

      <div className="grid gap-6 lg:grid-cols-[16rem_1fr]">
        <nav aria-label="Themes" className="flex flex-col gap-1">
          {themes.data?.items.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={selected === t.id ? "true" : undefined}
              onClick={() => setSelected(t.id)}
              className={cn("flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60", selected === t.id ? "border-primary/40 bg-accent" : "border-transparent hover:bg-accent/60")}
            >
              <span className="size-4 shrink-0 rounded-full border" style={{ background: colorsOf(t.tokens).primary }} aria-hidden />
              <span className="min-w-0 flex-1 truncate font-medium">{t.name}</span>
              <span className="text-xs text-muted-foreground">v{t.version}</span>
            </button>
          ))}
          {themes.data?.items.length === 0 && <p className="px-3 py-2 text-sm text-muted-foreground">No theme yet. Devices use their own look.</p>}
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          {current && schema.data ? (
            <Editor
              key={selected}
              theme={current}
              schema={schema.data}
              onSaved={(id) => {
                setSelected(id);
                themes.reload();
              }}
              onDeleted={() => {
                setSelected(null);
                themes.reload();
              }}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{themes.loading ? "Loading…" : "Choose a theme, or make a new one."}</p>
          )}
          <Assignments themes={themes.data?.items ?? []} />
        </div>
      </div>
    </div>
  );
}

function Editor({ theme, schema, onSaved, onDeleted }: { theme: Theme; schema: Schema; onSaved: (id: string) => void; onDeleted: () => void }) {
  const [draft, setDraft] = useState<Theme>(theme);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const jsonFile = useRef<HTMLInputElement>(null);
  const cssFile = useRef<HTMLInputElement>(null);
  const isNew = !theme.id;
  const dirty = JSON.stringify(draft) !== JSON.stringify(theme);
  const hints = cssHints(draft.css);

  const edit = (patch: Partial<Theme>) => (setDraft((d) => ({ ...d, ...patch })), setSaved(false));
  const setColor = (name: string, value: string | undefined) => {
    const colors = { ...draft.tokens.colors };
    if (value) colors[name] = value;
    else delete colors[name];
    edit({ tokens: { ...draft.tokens, colors } });
  };

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const body = { name: draft.name, description: draft.description, tokens: draft.tokens, css: draft.css };
      const result = isNew ? await api<Theme>("/themes", { body }) : await api<Theme>(`/themes/${theme.id}`, { method: "PUT", body });
      setSaved(true);
      onSaved(result.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete the theme “${theme.name}”?`)) return;
    setError(null);
    try {
      await api(`/themes/${theme.id}`, { method: "DELETE" });
      onDeleted();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete");
    }
  }

  /** A theme file: JSON with `tokens` (and optionally `name`, `description`, `css`), or just the tokens. */
  async function importJson(file: File) {
    setError(null);
    try {
      const json = JSON.parse(await file.text()) as Partial<Theme> & Tokens;
      const tokens: Tokens = json.tokens ?? { mode: json.mode, colors: json.colors, typography: json.typography, shape: json.shape };
      edit({ name: draft.name || json.name || file.name.replace(/\.json$/i, ""), description: json.description ?? draft.description, tokens, css: json.css ?? draft.css });
    } catch {
      setError("That file is not valid JSON.");
    }
  }

  const download = (name: string, text: string, type: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const slug = (draft.name || "theme").toLowerCase().replace(/[^a-z0-9]+/g, "-");

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{isNew ? "New theme" : draft.name}</CardTitle>
          <CardDescription>{isNew ? "Colours you leave unset keep the app's own." : `Version ${theme.version}. Saving sends the new version to every screen that wears it.`}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="t-name">
              <Input id="t-name" required maxLength={schema.limits.name} value={draft.name} onChange={(e) => edit({ name: e.target.value })} />
            </Field>
            <Field label="Description (optional)" htmlFor="t-desc">
              <Input id="t-desc" maxLength={200} value={draft.description} onChange={(e) => edit({ description: e.target.value })} />
            </Field>
          </div>

          <fieldset>
            <legend className="mb-3 text-sm leading-none font-medium">Colours</legend>
            <div className="grid gap-3 sm:grid-cols-2">
              {schema.colors.map((name) => {
                const value = draft.tokens.colors?.[name];
                return (
                  <div key={name} className="flex items-center gap-3">
                    <input type="color" aria-label={COLOR_LABEL[name] ?? name} value={value ?? colorsOf(draft.tokens)[name as keyof typeof BASE]} onChange={(e) => setColor(name, e.target.value)} className="size-9 shrink-0 cursor-pointer rounded-md border bg-transparent p-0.5" />
                    <span className="min-w-0 flex-1 text-sm">
                      {COLOR_LABEL[name] ?? name}
                      <span className="block font-mono text-xs text-muted-foreground">{value ?? "app default"}</span>
                    </span>
                    {value && (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setColor(name, undefined)} aria-label={`Unset ${COLOR_LABEL[name] ?? name}`}>
                        Unset
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-4">
            <Field label="Mode" htmlFor="t-mode">
              <Select id="t-mode" value={draft.tokens.mode ?? ""} onChange={(e) => edit({ tokens: { ...draft.tokens, mode: (e.target.value || undefined) as Tokens["mode"] } })}>
                <option value="">App default</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </Select>
            </Field>
            <Field label="Font" htmlFor="t-font">
              <Select id="t-font" value={draft.tokens.typography?.fontFamily ?? ""} onChange={(e) => edit({ tokens: { ...draft.tokens, typography: { ...draft.tokens.typography, fontFamily: e.target.value || undefined } } })}>
                <option value="">App default</option>
                {schema.fonts.map((f) => (
                  <option key={f} value={f}>
                    {FONT_LABEL[f] ?? f}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={`Text size: ${Math.round((draft.tokens.typography?.scale ?? 1) * 100)}%`} htmlFor="t-scale">
              <input id="t-scale" type="range" min={schema.limits.scaleMin} max={schema.limits.scaleMax} step={0.05} value={draft.tokens.typography?.scale ?? 1} onChange={(e) => edit({ tokens: { ...draft.tokens, typography: { ...draft.tokens.typography, scale: Number(e.target.value) } } })} className="w-full accent-primary" />
            </Field>
            <Field label={`Corners: ${draft.tokens.shape?.radius ?? 10}`} htmlFor="t-radius">
              <input id="t-radius" type="range" min={0} max={schema.limits.radiusMax} step={1} value={draft.tokens.shape?.radius ?? 10} onChange={(e) => edit({ tokens: { ...draft.tokens, shape: { radius: Number(e.target.value) } } })} className="w-full accent-primary" />
            </Field>
          </div>

          <Field label="CSS for the Faculty screens (optional)" htmlFor="t-css" hint={`${draft.css.length} / ${schema.limits.css}. Door units ignore it. No url(), @import or @font-face: nothing is loaded from elsewhere.`}>
            <textarea
              id="t-css"
              rows={7}
              spellCheck={false}
              maxLength={schema.limits.css}
              value={draft.css}
              onChange={(e) => edit({ css: e.target.value })}
              className="w-full rounded-lg border border-input bg-background px-3 py-2 font-mono text-xs outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
            />
          </Field>
          {hints.length > 0 && (
            <p role="alert" className="text-sm text-destructive">
              {hints.join(". ")}.
            </p>
          )}
          <ErrorText>{error}</ErrorText>

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" onClick={() => void save()} disabled={busy || !draft.name.trim() || !dirty || hints.length > 0}>
              {busy ? "Saving…" : isNew ? "Create theme" : "Save theme"}
            </Button>
            {saved && !dirty && <span role="status" className="text-sm text-primary">Saved.</span>}
            <span className="ml-auto flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => jsonFile.current?.click()}>
                <Upload /> Import JSON
              </Button>
              <input ref={jsonFile} type="file" accept="application/json,.json" className="sr-only" aria-label="Theme JSON file" onChange={(e) => (e.target.files?.[0] && void importJson(e.target.files[0]), (e.target.value = ""))} />
              <Button type="button" variant="outline" size="sm" onClick={() => cssFile.current?.click()}>
                <Upload /> Import CSS
              </Button>
              <input ref={cssFile} type="file" accept="text/css,.css" className="sr-only" aria-label="Theme CSS file" onChange={(e) => (e.target.files?.[0] && void e.target.files[0].text().then((css) => edit({ css })), (e.target.value = ""))} />
              <Button type="button" variant="outline" size="sm" onClick={() => download(`${slug}.json`, JSON.stringify({ name: draft.name, description: draft.description, tokens: draft.tokens }, null, 2), "application/json")}>
                <Download /> JSON
              </Button>
              <Button type="button" variant="outline" size="sm" disabled={!draft.css} onClick={() => download(`${slug}.css`, draft.css, "text/css")}>
                <Download /> CSS
              </Button>
              {!isNew && (
                <Button type="button" variant="outline" size="sm" onClick={() => void remove()}>
                  <Trash2 /> Delete
                </Button>
              )}
            </span>
          </div>
        </CardContent>
      </Card>

      <Preview theme={draft} />
    </div>
  );
}

/**
 * A preview of the two apps. The door unit is drawn here from the tokens. The Faculty screen is a small page in a frame with no
 * scripts and no network, so the CSS can be tried without touching this console.
 */
function Preview({ theme }: { theme: Theme }) {
  const c = colorsOf(theme.tokens);
  const radius = theme.tokens.shape?.radius ?? 10;
  const scale = theme.tokens.typography?.scale ?? 1;
  const font = FONT_STACK[theme.tokens.typography?.fontFamily ?? "sans"];
  const dark = theme.tokens.mode === "dark";
  const bg = dark && !theme.tokens.colors?.background ? "#0e0f10" : c.background;
  const srcDoc = useMemo(
    () => `<!doctype html><meta charset="utf-8"><style>
:root{--page:${bg};--card:${c.surface};--ink:${c.text};--muted:${c.muted};--accent:${c.primary};--accent-ink:${c.primaryText};--line:${c.border};--ok:${c.success};--warn:${c.warning};--danger:${c.danger};--radius:${radius}px}
*{box-sizing:border-box}body{margin:0;padding:14px;background:var(--page);color:var(--ink);font:${14 * scale}px ${font}}
.header{display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid var(--line);padding-bottom:8px;margin-bottom:12px}
.header h1{margin:0;font-size:1.3em}.clock{color:var(--accent);font-weight:700;font-size:1.6em}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);padding:12px}
.card h2{margin:0 0 6px;font-size:1em}.pill{display:inline-block;padding:1px 8px;border-radius:99px;background:var(--accent);color:var(--accent-ink);font-size:.8em}
.muted{color:var(--muted)}.ok{color:var(--ok)}.warn{color:var(--warn)}.danger{color:var(--danger)}
</style><style>${theme.css.replace(/<\/style/gi, "")}</style>
<div class="screen"><div class="header"><h1>Faculty information</h1><span class="clock">12:40</span></div>
<div class="grid"><section class="card"><h2>Current events</h2><div>Algorithms <span class="pill">NOW</span></div><div class="muted">B2-104 · 12:40 – 13:39</div></section>
<section class="card"><h2>Staff</h2><div class="ok">● Available</div><div class="warn">● Away</div><div class="danger">● Busy</div></section></div></div>`,
    [bg, c, radius, scale, font, theme.css],
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="size-4" /> Preview
        </CardTitle>
        <CardDescription>Approximate: the apps draw their own screens with these colours, font, size and corners.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-[minmax(0,1fr)_16rem]">
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Faculty screen (with your CSS)</div>
          <iframe title="Faculty screen preview" sandbox="" srcDoc={srcDoc} className="aspect-video w-full rounded-lg border bg-white" />
        </div>
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">Door unit</div>
          <div className="mx-auto aspect-[3/4] w-48 overflow-hidden border-4 border-neutral-800 p-3" style={{ background: bg, color: c.text, borderRadius: radius + 8, fontFamily: font, fontSize: 12 * scale }}>
            <div style={{ color: c.muted }}>B2-104 · Floor 1</div>
            <div style={{ fontSize: "1.8em", fontWeight: 700 }}>Lab</div>
            <div className="mt-3 inline-block px-3 py-1 font-medium" style={{ background: c.primary, color: c.primaryText, borderRadius: radius }}>
              Free
            </div>
            <div className="mt-4 p-2" style={{ background: c.surface, border: `1px solid ${c.border}`, borderRadius: radius }}>
              <div style={{ color: c.muted }}>Next</div>
              <div>Algorithms, 14:00</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function Assignments({ themes }: { themes: Theme[] }) {
  const list = useFetch<{ items: Assignment[] }>("/themes/assignments");
  const devices = useFetch<{ items: Device[] }>("/devices");
  const [scope, setScope] = useState<Assignment["scope"]>("default");
  const [key, setKey] = useState("door");
  const [themeId, setThemeId] = useState("");
  const [error, setError] = useState<string | null>(null);

  const themed = devices.data?.items.filter((d) => d.status === "active" && (d.type === "door" || d.type === "display")) ?? [];
  const groups = [...new Set(themed.flatMap((d) => d.groups))].sort();
  const nameOfDevice = (id: string) => devices.data?.items.find((d) => d.id === id)?.name || id;

  useEffect(() => {
    setKey(scope === "default" ? "door" : scope === "device" ? (themed[0]?.id ?? "") : (groups[0] ?? ""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope, devices.data]);

  async function put(s: string, k: string, id: string | null) {
    setError(null);
    try {
      await api("/themes/assignments", { method: "PUT", body: { scope: s, key: k, themeId: id } });
      list.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save");
    }
  }

  const label = (a: Assignment) => (a.scope === "default" ? `All ${a.key === "door" ? "door units" : "Faculty screens"}` : a.scope === "group" ? `Group ${a.key}` : nameOfDevice(a.key));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Where themes apply</CardTitle>
        <CardDescription>A device wears the theme set for it, otherwise the one of its group (the first in alphabetical order if it is in several), otherwise the default for its kind, otherwise its own look.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <ErrorText>{error ?? list.error}</ErrorText>
        <ul className="divide-y text-sm">
          {list.data?.items.map((a) => (
            <li key={`${a.scope}:${a.key}`} className="flex items-center gap-3 py-2">
              <Badge variant="muted">{a.scope}</Badge>
              <span className="min-w-0 flex-1 truncate">{label(a)}</span>
              <span className="font-medium">{a.themeName}</span>
              <Button variant="ghost" size="icon" aria-label={`Remove theme from ${label(a)}`} onClick={() => void put(a.scope, a.key, null)}>
                <Trash2 />
              </Button>
            </li>
          ))}
          {list.data?.items.length === 0 && <li className="py-2 text-muted-foreground">No assignment yet.</li>}
        </ul>
        <form
          className="grid items-end gap-3 sm:grid-cols-[9rem_1fr_1fr_auto]"
          onSubmit={(e) => {
            e.preventDefault();
            if (themeId && key) void put(scope, key, themeId);
          }}
        >
          <Field label="Applies to" htmlFor="a-scope">
            <Select id="a-scope" value={scope} onChange={(e) => setScope(e.target.value as Assignment["scope"])}>
              <option value="default">All of a kind</option>
              <option value="group">A group</option>
              <option value="device">One device</option>
            </Select>
          </Field>
          <Field label={scope === "default" ? "Kind" : scope === "group" ? "Group" : "Device"} htmlFor="a-key">
            <Select id="a-key" value={key} onChange={(e) => setKey(e.target.value)}>
              {scope === "default" && (
                <>
                  <option value="door">Door units</option>
                  <option value="display">Faculty screens</option>
                </>
              )}
              {scope === "group" && groups.map((g) => <option key={g} value={g}>{g}</option>)}
              {scope === "device" && themed.map((d) => <option key={d.id} value={d.id}>{d.name || d.id}</option>)}
            </Select>
          </Field>
          <Field label="Theme" htmlFor="a-theme">
            <Select id="a-theme" value={themeId} onChange={(e) => setThemeId(e.target.value)}>
              <option value="">Choose…</option>
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
          <Button type="submit" disabled={!themeId || !key}>
            Apply
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
