import { Field } from "@/components/Field";
import { MediaField } from "@/components/MediaPicker";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { GROUP_LABEL, kindIcon, newTile } from "@/lib/screens";
import type { FieldDef, Tile, TileKindDef } from "@/lib/types";

/** The kind selector, grouped (board, media, live) from what the server says exists. */
export function KindSelect({ id, kinds, value, onChange }: { id: string; kinds: TileKindDef[]; value: string; onChange: (tile: Tile) => void }) {
  const Icon = kindIcon(value);
  const known = kinds.some((k) => k.kind === value);
  return (
    <div className="flex items-center gap-2">
      <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden />
      <Select id={id} value={value} onChange={(e) => onChange(newTile(kinds.find((k) => k.kind === e.target.value)!))}>
        {!known && <option value={value}>{value} (unknown)</option>}
        {(["board", "media", "live"] as const).map((group) => (
          <optgroup key={group} label={GROUP_LABEL[group]}>
            {kinds
              .filter((k) => k.group === group)
              .map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.label}
                </option>
              ))}
          </optgroup>
        ))}
      </Select>
    </div>
  );
}

/** Draws one field of a tile kind from its description, so a kind added on the server needs no form here. */
function SettingField({ id, def, value, onChange }: { id: string; def: FieldDef; value: unknown; onChange: (v: unknown) => void }) {
  if (def.type === "asset") {
    const assetId = (value as { assetId?: string } | undefined)?.assetId ?? null;
    return <MediaField id={id} label={def.label} accept={def.accept} value={assetId} onChange={(v) => onChange(v ? { assetId: v } : undefined)} clearable={false} />;
  }
  if (def.type === "boolean") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--primary)]" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
        {def.label}
      </label>
    );
  }
  if (def.type === "select") {
    return (
      <Field label={def.label} htmlFor={id} hint={def.help}>
        <Select id={id} value={String(value ?? def.default ?? "")} onChange={(e) => onChange(e.target.value)}>
          {def.options?.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  if (def.type === "longtext") {
    const text = String(value ?? "");
    return (
      <Field label={def.label} htmlFor={id} hint={def.max ? `${text.length} / ${def.max}. Screens are read from a distance: keep it short.` : def.help}>
        <textarea
          id={id}
          rows={3}
          maxLength={def.max}
          required={def.required}
          value={text}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </Field>
    );
  }
  if (def.type === "number") {
    return (
      <Field label={def.label} htmlFor={id} hint={def.help}>
        <Input id={id} type="number" min={def.min} max={def.max} required={def.required} value={value === undefined ? "" : String(value)} onChange={(e) => onChange(e.target.value === "" ? undefined : Number(e.target.value))} />
      </Field>
    );
  }
  return (
    <Field label={def.label} htmlFor={id} hint={def.help}>
      <Input id={id} type={def.type === "url" ? "url" : "text"} required={def.required} maxLength={def.max} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={def.type === "url" ? "https://" : undefined} />
    </Field>
  );
}

/** The settings of one tile: a field per entry of its kind's description. */
export function TileForm({ idPrefix, def, tile, onChange }: { idPrefix: string; def: TileKindDef | undefined; tile: Tile; onChange: (tile: Tile) => void }) {
  if (!def) return <p className="text-sm text-muted-foreground">This kind of tile is not known to this console. It is kept as it is; screens that know it will show it.</p>;
  if (def.fields.length === 0) return <p className="text-sm text-muted-foreground">{def.description} Nothing to set.</p>;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{def.description}</p>
      {def.fields.map((f) => (
        <SettingField
          key={f.key}
          id={`${idPrefix}-${f.key}`}
          def={f}
          value={tile.settings[f.key]}
          onChange={(v) => {
            const settings = { ...tile.settings };
            if (v === undefined) delete settings[f.key];
            else settings[f.key] = v;
            onChange({ ...tile, settings });
          }}
        />
      ))}
    </div>
  );
}
