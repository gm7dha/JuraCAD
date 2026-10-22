/**
 * A small map of a sketch's areas in the Extrude / Revolve / Sweep dialog:
 * click the areas to use (like clicking regions in Onshape). Nothing picked
 * means every closed shape, as before. The map (and the work of finding the
 * areas) only appears once asked for, or when areas are already picked.
 */
import { useMemo, useState } from "react";

import { areasUsedByAll, missingAreasMessage, pickedAreas, sketchAreas, toggleArea, type AreaPick } from "../sketch/areas";
import type { Pt } from "../sketch/regions";
import type { SketchData } from "../sketch/types";

const pathOf = (poly: Pt[]) => (poly.length ? `M${poly.map(([x, y]) => `${x} ${-y}`).join("L")}Z` : "");

export function AreaPicker({ data, areas, verb, onChange }: { data: SketchData; areas: AreaPick[] | undefined; verb: string; onChange: (areas: AreaPick[] | undefined) => void }) {
  const [open, setOpen] = useState(false);
  const all = !areas?.length;
  if (all && !open) {
    return (
      <div className="area-picker">
        <p className="dialog-hint field-hint">
          Using every closed shape.{" "}
          <button type="button" className="link-button" onClick={() => setOpen(true)}>
            Pick areas…
          </button>
        </p>
      </div>
    );
  }
  return <AreaMap data={data} areas={areas} verb={verb} onChange={onChange} />;
}

function AreaMap({ data, areas, verb, onChange }: { data: SketchData; areas: AreaPick[] | undefined; verb: string; onChange: (areas: AreaPick[] | undefined) => void }) {
  const map = useMemo(() => sketchAreas(data), [data]);
  const { picked, missing } = useMemo(() => pickedAreas(map, areas), [map, areas]);
  const all = !areas?.length;
  // With nothing picked: the areas every closed shape covers (not holes) show as used.
  const used = useMemo(() => (all ? areasUsedByAll(data) : null), [all, data]);
  // Bigger areas first, so smaller ones inside them (drawn on top) can be clicked.
  const order = useMemo(() => map.areas.map((_a, i) => i).sort((a, b) => map.areas[b].outer.area - map.areas[a].outer.area), [map]);
  if (map.areas.length === 0) return <p className="dialog-hint field-hint">The sketch has no closed areas to pick.</p>;
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const a of map.areas)
    for (const [x, y] of a.outer.polygon) {
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  const pad = Math.max(x1 - x0, y1 - y0) * 0.05 || 1;
  return (
    <div className="area-picker">
      <label className="field-label">Areas to {verb}</label>
      <svg
        className="area-map"
        viewBox={`${x0 - pad} ${-y1 - pad} ${x1 - x0 + 2 * pad} ${y1 - y0 + 2 * pad}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Sketch areas: click the ones to ${verb}`}
      >
        {order.map((i) => {
          const a = map.areas[i];
          const on = picked.has(i);
          const toggle = () => onChange(toggleArea(map, areas, i));
          return (
            <path
              key={i}
              className={`area-shape${on ? " picked" : used?.has(i) ? " all" : ""}`}
              d={[pathOf(a.outer.polygon), ...a.holes.map((h) => pathOf(h.polygon))].join(" ")}
              fillRule="evenodd"
              vectorEffect="non-scaling-stroke"
              role="button"
              tabIndex={0}
              aria-pressed={on}
              aria-label={`Area ${i + 1}${on ? " (picked)" : ""}`}
              onClick={toggle}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  toggle();
                }
              }}
            >
              <title>{on ? "Click to leave this area out" : `Click to ${verb} this area`}</title>
            </path>
          );
        })}
      </svg>
      {missing > 0 && <p className="dialog-error">{missingAreasMessage(missing, verb)}</p>}
      <p className="dialog-hint field-hint">
        {all
          ? `Using every closed shape (shaded). To ${verb} only some areas, click them — where lines cross, each piece is its own area.`
          : `${picked.size} area${picked.size === 1 ? "" : "s"} picked. Click an area again to leave it out.`}
        {!all && (
          <>
            {" "}
            <button type="button" className="link-button" onClick={() => onChange(undefined)}>
              Use all closed shapes
            </button>
          </>
        )}
      </p>
    </div>
  );
}
