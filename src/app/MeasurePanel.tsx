import { useEffect, useState } from "react";

import type { Measurement } from "../geometry/measureMath";
import { getKernel } from "../kernel/connect";
import { pickFor, useLengthUnit, useStore } from "../model/store";
import { formatArea, formatLength, formatVolume } from "../model/units";

const mm = (v: number) => formatLength(v);
const mm2 = (v: number) => formatArea(v);

/**
 * Onshape-style measurements for whatever is selected in the 3D view:
 * one thing shows its size, two show the gap and angle between them.
 */
export function MeasurePanel() {
  const selection = useStore((s) => s.selection);
  // Whole parts picked (Parts list or a selection box) are measured too.
  const selectedParts = useStore((s) => s.selectedParts);
  const wholeParts = selection.length === 0 && selectedParts.length > 0 && selectedParts.length <= 2;
  const parts = useStore((s) => s.parts);
  const editing = useStore((s) => s.editing !== null);
  useLengthUnit(); // shown in the design's units
  const [result, setResult] = useState<Measurement | null>(null);

  useEffect(() => {
    setResult(null);
    if (editing) return;
    if (wholeParts) {
      let live = true;
      getKernel()
        .measureParts(selectedParts)
        .then((r) => live && setResult(r))
        .catch(() => live && setResult(null));
      return () => {
        live = false;
      };
    }
    if (selection.length === 0 || selection.length > 2) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, parts, editing, wholeParts, selectedParts]);

  if (editing || (selection.length === 0 && !wholeParts)) return null;
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
    if (item.volume !== undefined) rows.push([`${prefix}${item.label} — volume`, formatVolume(item.volume)]);
  });
  if (result.centreDistance) {
    const c = result.centreDistance;
    rows.push(["Centre to centre", mm(c.total)]);
    rows.push(["  along X / Y / Z", `${mm(c.dx)} / ${mm(c.dy)} / ${mm(c.dz)}`]);
  }
  if (result.distance !== undefined) rows.push(["Closest distance", wholeParts && result.distance < 1e-6 ? (result.overlap ? "0 (they overlap)" : "0 (touching)") : mm(result.distance)]);
  if (result.overlap) rows.push(["Overlap", formatVolume(result.overlap)]);
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
      {(wholeParts ? selectedParts.length === 1 : selection.length === 1) && (
        <p className="muted small">{wholeParts ? "Select a second part (Shift or Ctrl-click in the Parts list) to measure between them." : "Shift-click a second thing to measure between them."}</p>
      )}
    </div>
  );
}
