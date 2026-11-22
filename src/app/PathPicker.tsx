/**
 * Click paths and roads on a puzzle window's top view to leave them off (or put them back): drawn over the view's canvas
 * as an SVG in OS grid metres. Dropped lines show faint and dashed so they can be clicked back; the line under the pointer
 * is highlighted with its name and length. Touch: a tap picks the nearest line within a finger's reach. The choice itself
 * is pure (src/terrain/pickMarks.ts).
 */
import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { MapFeatures } from "../terrain/osm";
import { canPick, dropAll, isDropped, keptCount, lineLabel, nearestLine, NONE_DROPPED, toggleDropped as toggleLine } from "../terrain/pickMarks";

type Line = MapFeatures["lines"][number];

/** How near (screen px) the pointer must be to pick a line: wider for a finger. */
const REACH_PX = { mouse: 9, touch: 20, pen: 12 } as const;

/** The SVG laid over the top view; `box` = the OS grid metres the canvas covers. */
export function PathPickOverlay({ lines, dropped, onChange, box }: { lines: Line[]; dropped: ReadonlySet<string>; onChange: (d: ReadonlySet<string>) => void; box: { e0: number; n0: number; width: number; height: number } }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);
  const down = useRef<{ x: number; y: number; type: string } | null>(null);
  const pickable = lines.filter(canPick);
  if (!pickable.length) return null;
  const { e0, n0, width: W, height: H } = box;
  const at = ([e, n]: [number, number]) => `${(e - e0).toFixed(1)},${(H - (n - n0)).toFixed(1)}`;
  const find = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = ref.current!.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const [x, y] = [e.clientX - rect.left, e.clientY - rect.top];
    const perPx = W / rect.width;
    const reach = (REACH_PX[e.pointerType as keyof typeof REACH_PX] ?? REACH_PX.mouse) * perPx;
    const index = nearestLine(pickable, [e0 + x * perPx, n0 + H - y * (H / rect.height)], reach);
    return { index, x, y };
  };
  const shown = hover && hover.index >= 0 ? pickable[hover.index] : null;
  return (
    <>
      <svg
        ref={ref}
        className="path-pick"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        data-own-touch
        onPointerMove={(e) => {
          if (e.pointerType === "touch") return;
          const f = find(e);
          setHover(f && f.index >= 0 ? f : null);
        }}
        onPointerLeave={(e) => e.pointerType !== "touch" && setHover(null)}
        onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY, type: e.pointerType })}
        onPointerUp={(e) => {
          const d = down.current;
          down.current = null;
          if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
          const f = find(e);
          if (!f || f.index < 0) return setHover(null);
          onChange(toggleLine(dropped, pickable[f.index]));
          setHover(f);
        }}
      >
        {pickable.map((l, i) =>
          isDropped(l, dropped) ? (
            <polyline key={i} className="path-pick-off" points={l.pts.map(at).join(" ")} vectorEffect="non-scaling-stroke" />
          ) : null,
        )}
        {shown && <polyline className="path-pick-hover" points={shown.pts.map(at).join(" ")} vectorEffect="non-scaling-stroke" />}
      </svg>
      {shown && hover && (
        <span className="path-pick-label small" style={{ left: hover.x, top: hover.y }}>
          {lineLabel(shown)} — {isDropped(shown, dropped) ? "left off (click to put it back)" : "click to leave it off"}
        </span>
      )}
    </>
  );
}

/** "12 of 15 paths and roads kept", with Keep all / Leave all off. */
export function PathPickBar({ features, dropped, onChange }: { features: MapFeatures; dropped: ReadonlySet<string>; onChange: (d: ReadonlySet<string>) => void }) {
  const n = keptCount(features, dropped);
  if (!n.total) return null;
  const what = n.roads && n.paths ? "paths and roads" : n.roads ? (n.total === 1 ? "road" : "roads") : n.total === 1 ? "path" : "paths";
  return (
    <div className="path-pick-bar small">
      <span>
        {n.kept} of {n.total} {what} kept — click one on the map above to leave it off, or click it again to put it back.
      </span>
      <button className="text-button" disabled={n.kept === n.total} onClick={() => onChange(NONE_DROPPED)}>
        Keep all
      </button>
      <button className="text-button" disabled={n.kept === 0} onClick={() => onChange(dropAll(features, dropped))}>
        Leave all off
      </button>
    </div>
  );
}
