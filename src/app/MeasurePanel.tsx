import { useEffect, useState } from "react";

import type { Measurement } from "../geometry/measureMath";
import { getKernel } from "../kernel/connect";
import { pickFor, useLengthUnit, useStore } from "../model/store";
import { formatArea, formatLength } from "../model/units";

const mm = (v: number) => formatLength(v);
const mm2 = (v: number) => formatArea(v);

/**
 * Onshape-style measurements for whatever is selected in the 3D view:
 * one thing shows its size, two show the gap and angle between them.
 */
export function MeasurePanel() {
  const selection = useStore((s) => s.selection);
  const parts = useStore((s) => s.parts);
  const editing = useStore((s) => s.editing !== null);
  useLengthUnit(); // shown in the design's units
  const [result, setResult] = useState<Measurement | null>(null);

  useEffect(() => {
    setResult(null);
    if (editing || selection.length === 0 || selection.length > 2) return;
    const picks = selection.map((item) => pickFor(parts, item)).filter((p): p is NonNullable<typeof p> => p !== null);
    if (picks.length !== selection.length) return;
    let current = true;
    getKernel()
      .measure(picks)
      .then((r) => current && setResult(r))
      .catch(() => current && setResult(null));
    return () => {
      current = false;
    };
  }, [selection, parts, editing]);

  if (editing || selection.length === 0) return null;
  if (selection.length > 2) {
    return (
      <div className="measure-panel" aria-label="Measurements">
        <p className="muted small">Select one or two things to measure them.</p>
      </div>
    );
  }
  if (!result || result.items.length === 0) return null;

  const rows: [string, string][] = [];
  result.items.forEach((item, i) => {
    const prefix = result.items.length > 1 ? `${i + 1}. ` : "";
    if (item.radius !== undefined) {
      rows.push([`${prefix}${item.label} — diameter`, mm(item.radius * 2)]);
      rows.push(["Radius", mm(item.radius)]);
    }
    if (item.length !== undefined && item.radius === undefined) rows.push([`${prefix}${item.label} — length`, mm(item.length)]);
    if (item.area !== undefined) rows.push([`${prefix}${item.label} — area`, mm2(item.area)]);
  });
  if (result.centreDistance) {
    const c = result.centreDistance;
    rows.push(["Centre to centre", mm(c.total)]);
    rows.push(["  along X / Y / Z", `${mm(c.dx)} / ${mm(c.dy)} / ${mm(c.dz)}`]);
  }
  if (result.distance !== undefined) rows.push(["Closest distance", mm(result.distance)]);
  if (result.angle !== undefined) rows.push(["Angle", `${Math.round(result.angle * 100) / 100}°`]);

  return (
    <div className="measure-panel" aria-label="Measurements" role="status">
      <div className="measure-title">Measure</div>
      <table>
        <tbody>
          {rows.map(([k, v]) => (
            <tr key={k}>
              <td>{k}</td>
              <td>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {selection.length === 1 && <p className="muted small">Shift-click a second thing to measure between them.</p>}
    </div>
  );
}
