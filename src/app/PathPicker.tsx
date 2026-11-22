/**
 * Click paths and roads on a puzzle window's top view to leave them off (or put them back): an SVG laid exactly over the
 * view's canvas, placed with the same mapping the canvas is drawn with (`onView`/`fromView` in pickMarks.ts). Dropped
 * lines show faint and dashed so they can be clicked back; the line under the pointer is highlighted, and its name and
 * length are said in the line under the view (never over the map, so it can't hide the line). Touch: a tap picks the
 * nearest line within a finger's reach. Keyboard: the view takes the focus, the arrow keys step through the lines, Enter
 * or Space leaves one off or puts it back. The choice itself is pure (src/terrain/pickMarks.ts).
 */
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { MapFeatures } from "../terrain/osm";
import { dropAll, fromView, isDropped, keptCount, lineLabel, nearestLine, NONE_DROPPED, onView, toggleDropped as toggleLine, type ViewBox } from "../terrain/pickMarks";

type Line = MapFeatures["lines"][number];

/** How near (screen px) the pointer must be to pick a line: wider for a finger. */
const REACH_PX = { mouse: 9, touch: 20, pen: 12 } as const;
/** The overlay's own units across (its height follows the view's shape). */
const VIEW_W = 1000;

/** Paths and roads to click off on a top view: the pickable ones only (pickableLines), what's off, and how to change it. */
export interface TopViewPick {
  lines: Line[];
  dropped: ReadonlySet<string>;
  onChange: (d: ReadonlySet<string>) => void;
  /** The puzzle is being remade, so the view may not show the latest choice yet. */
  pending?: boolean;
}

/**
 * A top view's canvas (`children`) with the picking SVG laid exactly over it (`box` = the OS grid metres the canvas
 * covers), then the hovered line's name and the kept count under it. No `pick` = just the canvas.
 */
export function PickableView({ pick, box, children }: { pick: TopViewPick | null; box: ViewBox | null; children: ReactNode }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState(-1);
  const [focus, setFocus] = useState(-1);
  const down = useRef<{ x: number; y: number } | null>(null);
  const on = !!pick && !!box && pick.lines.length > 0 && box.width > 0 && box.height > 0;
  if (!on) {
    return (
      <>
        <div className="path-pick-wrap">{children}</div>
        {pick && <PathPickBar lines={pick.lines} dropped={pick.dropped} onChange={pick.onChange} pending={pick.pending} />}
      </>
    );
  }
  const { lines, dropped, onChange } = pick;
  const vh = (VIEW_W * box.height) / box.width;
  const at = (p: [number, number]) => onView(box, VIEW_W, vh, p).map((v) => v.toFixed(2)).join(",");
  const find = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rect = ref.current!.getBoundingClientRect();
    if (!rect.width || !rect.height) return -1;
    const p = fromView(box, rect.width, rect.height, [e.clientX - rect.left, e.clientY - rect.top]);
    const reach = (REACH_PX[e.pointerType as keyof typeof REACH_PX] ?? REACH_PX.mouse) * (box.width / rect.width);
    return nearestLine(lines, p, reach);
  };
  const lit = hover >= 0 && hover < lines.length ? hover : focus >= 0 && focus < lines.length ? focus : -1;
  const shown = lit >= 0 ? lines[lit] : null;
  const key = (e: ReactKeyboardEvent<SVGSVGElement>) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (step) {
      e.preventDefault();
      setHover(-1);
      setFocus((f) => (f < 0 || f >= lines.length ? (step > 0 ? 0 : lines.length - 1) : (f + step + lines.length) % lines.length));
    } else if ((e.key === "Enter" || e.key === " ") && focus >= 0 && focus < lines.length) {
      e.preventDefault();
      onChange(toggleLine(dropped, lines[focus]));
    }
  };
  return (
    <>
      <div className="path-pick-wrap">
        {children}
        <svg
          ref={ref}
          className="path-pick"
          viewBox={`0 0 ${VIEW_W} ${vh.toFixed(3)}`}
          preserveAspectRatio="none"
          data-own-touch
          tabIndex={0}
          role="group"
          aria-label="Paths and roads on the map: click one, or use the arrow keys and Enter, to leave it off or put it back"
          onKeyDown={key}
          onBlur={() => setFocus(-1)}
          onPointerMove={(e) => {
            if (e.pointerType === "touch") return;
            setHover(find(e));
          }}
          onPointerLeave={(e) => e.pointerType !== "touch" && setHover(-1)}
          onPointerDown={(e) => (down.current = { x: e.clientX, y: e.clientY })}
          onPointerCancel={() => (down.current = null)}
          onPointerUp={(e) => {
            const d = down.current;
            down.current = null;
            if (!d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 8) return;
            const i = find(e);
            setHover(i);
            if (i >= 0) onChange(toggleLine(dropped, lines[i]));
          }}
        >
          {lines.map((l, i) =>
            isDropped(l, dropped) ? (
              <g key={i}>
                <polyline className="path-pick-off-under" points={l.pts.map(at).join(" ")} vectorEffect="non-scaling-stroke" />
                <polyline className="path-pick-off" points={l.pts.map(at).join(" ")} vectorEffect="non-scaling-stroke" />
              </g>
            ) : null,
          )}
          {shown && <polyline className="path-pick-hover" points={shown.pts.map(at).join(" ")} vectorEffect="non-scaling-stroke" />}
        </svg>
      </div>
      <span className="path-pick-label small" aria-live="polite">
        {shown ? `${lineLabel(shown)} — ${isDropped(shown, dropped) ? "left off (click to put it back)" : "click to leave it off"}` : ""}
      </span>
      <PathPickBar lines={lines} dropped={dropped} onChange={onChange} pending={pick.pending} />
    </>
  );
}

/** "12 of 15 paths and roads kept", with Keep all / Leave all off. `pending`: the view is still being remade. */
function PathPickBar({ lines, dropped, onChange, pending }: { lines: Line[]; dropped: ReadonlySet<string>; onChange: (d: ReadonlySet<string>) => void; pending?: boolean }) {
  const f: MapFeatures = { lines, shapes: [], names: [] };
  const n = keptCount(f, dropped);
  if (!n.total) return null;
  const what = n.roads && n.paths ? "paths and roads" : n.roads ? (n.total === 1 ? "road" : "roads") : n.total === 1 ? "path" : "paths";
  return (
    <div className="path-pick-bar small">
      <span>
        {n.kept} of {n.total} {what} kept{pending ? " — updating the puzzle…" : " — click one on the map to leave it off"}
      </span>
      <button className="text-button" disabled={n.kept === n.total} onClick={() => onChange(NONE_DROPPED)}>
        Keep all
      </button>
      <button className="text-button" disabled={n.kept === 0} onClick={() => onChange(dropAll(f, dropped))}>
        Leave all off
      </button>
    </div>
  );
}
