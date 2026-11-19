import { kindIcon } from "@/lib/screens";
import type { LayoutDef, Tile, TileKindDef } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * A scene drawn the way a screen lays it out: a CSS grid from the layout's description, one box per tile.
 * With `onSelect` each box is a button, which is how a tile is chosen for editing.
 */
export function SceneLayout({
  layout,
  tiles,
  kinds,
  selected,
  onSelect,
  className,
  compact = false,
}: {
  layout: LayoutDef;
  tiles?: Tile[];
  kinds?: TileKindDef[];
  selected?: number;
  onSelect?: (index: number) => void;
  className?: string;
  compact?: boolean;
}) {
  return (
    <div className={cn("grid aspect-video w-full gap-1 rounded-lg bg-secondary p-1", className)} style={{ gridTemplateColumns: layout.columns, gridTemplateRows: layout.rows }}>
      {layout.tiles.map(([r1, c1, r2, c2], i) => {
        const tile = tiles?.[i];
        const def = tile ? kinds?.find((k) => k.kind === tile.kind) : undefined;
        const Icon = tile ? kindIcon(tile.kind) : null;
        const label = tile ? (def?.label ?? tile.kind) : `Tile ${i + 1}`;
        const style = { gridRow: `${r1} / ${r2}`, gridColumn: `${c1} / ${c2}` };
        const box = cn("flex min-h-0 min-w-0 flex-col items-center justify-center gap-1 overflow-hidden rounded-md border bg-card text-xs text-muted-foreground", selected === i && "border-primary text-foreground ring-2 ring-primary/40");
        const inner = (
          <>
            {Icon && <Icon className={compact ? "size-3.5" : "size-5"} aria-hidden />}
            {!compact && <span className="max-w-full truncate px-1">{label}</span>}
          </>
        );
        return onSelect ? (
          <button key={i} type="button" style={style} aria-pressed={selected === i} aria-label={`Tile ${i + 1}: ${label}`} onClick={() => onSelect(i)} className={cn(box, "outline-none hover:border-primary/50 focus-visible:ring-2 focus-visible:ring-ring/60")}>
            {inner}
          </button>
        ) : (
          <div key={i} style={style} title={label} className={box}>
            {inner}
          </div>
        );
      })}
    </div>
  );
}
