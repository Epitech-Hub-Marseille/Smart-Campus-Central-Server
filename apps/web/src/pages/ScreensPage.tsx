import { Layers, MonitorPlay, Pencil, Plus, Trash2, Users } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { CarouselManager } from "@/components/screens/CarouselManager";
import { GroupDialog } from "@/components/screens/GroupDialog";
import { SettingsEditor } from "@/components/screens/SettingsEditor";
import { ErrorText } from "@/components/Field";
import { PageHeader } from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import type { ScopeKind, ScopeView, ScreenGroup, ScreensOverview, TileKinds } from "@/lib/types";
import { useFetch } from "@/lib/useFetch";
import { cn } from "@/lib/utils";

interface Scope {
  scope: ScopeKind;
  key: string;
}

/** "default", "group:ID" or "device:ID", as kept in the address so a level can be linked to and survives a reload. */
const parseScope = (raw: string | null): Scope => {
  const [scope, ...rest] = (raw ?? "default").split(":");
  const key = rest.join(":");
  return (scope === "group" || scope === "device") && key ? { scope, key } : { scope: "default", key: "-" };
};
const scopeParam = (s: Scope) => (s.scope === "default" ? "default" : `${s.scope}:${s.key}`);

/**
 * Faculty screens: who shows what. The left list is the hierarchy (all screens, groups, screens); the right side
 * edits the selected level. A screen's own settings win over its group's, which win over the default.
 */
export function ScreensPage() {
  const [params, setParams] = useSearchParams();
  const selected = parseScope(params.get("scope"));
  const overview = useFetch<ScreensOverview>("/faculty/screens");
  const registry = useFetch<TileKinds>("/faculty/tile-kinds");
  const view = useFetch<ScopeView>(`/faculty/scopes/${selected.scope}/${selected.key}`);
  const [tab, setTab] = useState<"settings" | "carousel">("carousel");
  const [dialog, setDialog] = useState<{ group: ScreenGroup | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const select = (s: Scope) => setParams({ scope: scopeParam(s) }, { replace: true });
  const refresh = () => {
    overview.reload();
    view.reload();
  };

  const group = selected.scope === "group" ? overview.data?.groups.find((g) => g.id === selected.key) : undefined;

  async function removeGroup(g: ScreenGroup) {
    if (!confirm(`Delete the group "${g.name}"? Its screens go back to the default settings and playlist.`)) return;
    setError(null);
    try {
      await api(`/faculty/groups/${g.id}`, { method: "DELETE" });
      select({ scope: "default", key: "-" });
      refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Delete failed");
    }
  }

  return (
    <div>
      <PageHeader
        title="Faculty screens"
        description="Group screens, set how they look and choose what they rotate through. A screen's own settings win over its group's."
        actions={
          <>
            <Button variant="outline" asChild>
              <Link to="/media">Media library</Link>
            </Button>
            <Button variant="outline" asChild>
              <Link to="/news">News</Link>
            </Button>
            <Button onClick={() => setDialog({ group: null })}>
              <Plus /> New group
            </Button>
          </>
        }
      />
      <ErrorText>{overview.error ?? registry.error ?? error}</ErrorText>

      <div className="grid gap-6 lg:grid-cols-[18rem_1fr]">
        <nav aria-label="Screens and groups" className="flex flex-col gap-4">
          <ScopeItem
            icon={<Layers className="size-4" aria-hidden />}
            label="All screens"
            detail="The default for every screen"
            active={selected.scope === "default"}
            own={overview.data?.default}
            onClick={() => select({ scope: "default", key: "-" })}
          />

          <section aria-label="Groups">
            <h2 className="mb-1.5 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Groups</h2>
            <div className="flex flex-col gap-0.5">
              {overview.data?.groups.map((g) => (
                <ScopeItem
                  key={g.id}
                  icon={<Users className="size-4" aria-hidden />}
                  label={g.name}
                  detail={`${g.members.length} screen${g.members.length === 1 ? "" : "s"}`}
                  active={selected.scope === "group" && selected.key === g.id}
                  own={g.own}
                  onClick={() => select({ scope: "group", key: g.id })}
                />
              ))}
              {overview.data?.groups.length === 0 && <p className="px-3 py-1 text-sm text-muted-foreground">No group yet.</p>}
            </div>
          </section>

          <section aria-label="Screens">
            <h2 className="mb-1.5 px-3 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Screens</h2>
            <div className="flex flex-col gap-0.5">
              {overview.data?.displays.map((d) => (
                <ScopeItem
                  key={d.id}
                  icon={<MonitorPlay className="size-4" aria-hidden />}
                  label={d.name}
                  detail={d.groupId ? (overview.data?.groups.find((g) => g.id === d.groupId)?.name ?? "") : "No group"}
                  online={d.online}
                  active={selected.scope === "device" && selected.key === d.id}
                  own={d.own}
                  onClick={() => select({ scope: "device", key: d.id })}
                />
              ))}
              {overview.data?.displays.length === 0 && (
                <p className="px-3 py-1 text-sm text-muted-foreground">
                  No Faculty screen is enrolled. Approve one from <Link to="/devices" className="text-primary underline-offset-4 hover:underline">Devices</Link>.
                </p>
              )}
            </div>
          </section>
        </nav>

        <div className="min-w-0">
          {view.error ? (
            <ErrorText>{view.error}</ErrorText>
          ) : !view.data || !registry.data ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex flex-col gap-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-semibold tracking-tight">{view.data.name}</h2>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {view.data.scope === "default" && "Applies to every screen that does not set its own."}
                    {view.data.scope === "group" && `${view.data.screens} screen${view.data.screens === 1 ? "" : "s"} follow this group unless they set their own.`}
                    {view.data.scope === "device" && (view.data.group ? <>In the group <button type="button" className="text-primary underline-offset-4 hover:underline" onClick={() => select({ scope: "group", key: view.data!.group!.id })}>{view.data.group.name}</button>. Its own settings win.</> : "Not in a group: follows the default.")}
                  </p>
                </div>
                {group && (
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" onClick={() => setDialog({ group })}>
                      <Pencil /> Edit group
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => void removeGroup(group)}>
                      <Trash2 /> Delete
                    </Button>
                  </div>
                )}
              </div>

              <div role="tablist" aria-label="What to edit" className="flex gap-1 border-b">
                {(["carousel", "settings"] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="tab"
                    id={`tab-${t}`}
                    aria-selected={tab === t}
                    aria-controls="tab-panel"
                    onClick={() => setTab(t)}
                    className={cn("-mb-px border-b-2 px-4 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60", tab === t ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground")}
                  >
                    {t === "carousel" ? "Carousel" : "Settings"}
                    {t === "carousel" && view.data!.scenes && <Badge className="ml-2">Own</Badge>}
                    {t === "settings" && Object.keys(view.data!.config).length > 0 && <Badge className="ml-2">Own</Badge>}
                  </button>
                ))}
              </div>
              <div role="tabpanel" id="tab-panel" aria-labelledby={`tab-${tab}`}>
                {tab === "carousel" ? <CarouselManager view={view.data} registry={registry.data} onSaved={refresh} /> : <SettingsEditor view={view.data} registry={registry.data} onSaved={refresh} />}
              </div>
            </div>
          )}
        </div>
      </div>

      {dialog && overview.data && (
        <GroupDialog
          group={dialog.group}
          overview={overview.data}
          onClose={() => setDialog(null)}
          onSaved={(id) => {
            setDialog(null);
            select({ scope: "group", key: id });
            refresh();
          }}
        />
      )}
    </div>
  );
}

function ScopeItem({ icon, label, detail, active, own, online, onClick }: { icon: React.ReactNode; label: string; detail: string; active: boolean; own?: { config: boolean; playlist: boolean }; online?: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-current={active ? "true" : undefined}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
        active ? "border-primary/40 bg-accent text-foreground" : "border-transparent text-muted-foreground hover:bg-accent/60 hover:text-foreground",
      )}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <span className="truncate">{label}</span>
          {online !== undefined && <span className={cn("size-1.5 shrink-0 rounded-full", online ? "bg-primary" : "bg-muted-foreground/60")} role="img" aria-label={online ? "Online" : "Offline"} />}
        </span>
        <span className="block truncate text-xs">{[detail, own?.config && "own settings", own?.playlist && "own playlist"].filter(Boolean).join(" · ")}</span>
      </span>
    </button>
  );
}
