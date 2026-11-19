/**
 * Sketch panel settings for the newer editing tools (Chamfer, Slot on a curve,
 * a linear pattern's second direction), and their toolbar icons. Kept apart
 * from SketchPanel.tsx; the settings live in sketch/editToolOptions.ts.
 */
import type { ReactNode } from "react";

import { useLengthUnit } from "../model/store";
import { showLength, storeLength } from "../model/units";
import { useEditToolOptions, type EditToolOptions } from "../sketch/editToolOptions";
import type { ChamferMode } from "../sketch/sketchChamfer";
import { viewportApi } from "../viewport/Viewport";

const CHAMFER_MODES: [ChamferMode, string, string][] = [
  ["equal", "Equal", "The same distance back from the corner along both lines"],
  ["two", "Two distances", "A different distance along each line (the first line is the one you clicked first, or the corner's first)"],
  ["angle", "Distance + angle", "A distance along the first line and the chamfer's angle to it"],
];

function setOption(patch: Partial<Omit<EditToolOptions, "set">>) {
  useEditToolOptions.getState().set(patch);
  viewportApi.sketch?.refreshPreview();
}

/** The settings shown in the sketch panel while Chamfer or Slot on a curve is on. */
export function SketchEditOptions({ tool }: { tool: string }) {
  const mode = useEditToolOptions((s) => s.chamferMode);
  const distance = useEditToolOptions((s) => s.chamferDistance);
  const distance2 = useEditToolOptions((s) => s.chamferDistance2);
  const angle = useEditToolOptions((s) => s.chamferAngle);
  const width = useEditToolOptions((s) => s.slotWidth);
  const unit = useLengthUnit();
  if (tool === "sketchChamfer")
    return (
      <div className="pattern-options">
        <div className="segmented three" role="radiogroup" aria-label="Chamfer type">
          {CHAMFER_MODES.map(([key, label, title]) => (
            <button key={key} type="button" role="radio" aria-checked={mode === key} className={mode === key ? "selected" : ""} title={title} onClick={() => setOption({ chamferMode: key })}>
              {label}
            </button>
          ))}
        </div>
        <label className="tool-option">
          Distance
          <input value={showLength(distance, unit)} spellCheck={false} aria-label="Chamfer distance" onChange={(e) => setOption({ chamferDistance: storeLength(e.target.value, unit) })} />
          <span className="muted">{unit}</span>
        </label>
        {mode === "two" && (
          <label className="tool-option">
            Second distance
            <input value={showLength(distance2, unit)} spellCheck={false} aria-label="Chamfer second distance" onChange={(e) => setOption({ chamferDistance2: storeLength(e.target.value, unit) })} />
            <span className="muted">{unit}</span>
          </label>
        )}
        {mode === "angle" && (
          <label className="tool-option">
            Angle
            <input value={angle} spellCheck={false} aria-label="Chamfer angle" onChange={(e) => setOption({ chamferAngle: e.target.value })} />
            <span className="muted">°</span>
          </label>
        )}
        <p className="dialog-hint">
          Click a corner where two lines meet, or two lines (they're trimmed or carried on to meet). The corner stays as a dashed point, so its
          dimensions keep working. More chamfers of the same size stay equal to the first one: change its size and they all change.
        </p>
      </div>
    );
  if (tool === "slotAlong")
    return (
      <div className="pattern-options">
        <label className="tool-option">
          Width
          <input value={showLength(width, unit)} spellCheck={false} aria-label="Slot width" onChange={(e) => setOption({ slotWidth: storeLength(e.target.value, unit) })} />
          <span className="muted">{unit}</span>
        </label>
        <p className="dialog-hint">
          Click a line, arc, circle, spline or ellipse (or a run of joined lines and arcs): a slot that wide is drawn along it, with round ends. The
          curve becomes its dashed middle line and the slot follows it when it changes — handy for adjustable parts (a slot along an arc lets a bolt slide round).
        </p>
      </div>
    );
  if (tool === "sketchFillet")
    return <p className="dialog-hint">Click a corner, or two lines or arcs to round between (they're trimmed or carried on to the round). More rounds of the same size stay equal to the first.</p>;
  if (tool === "trim") return <p className="dialog-hint">Click a piece to cut it away, or drag across several pieces to trim them all at once.</p>;
  return null;
}

/** A linear sketch pattern's second direction (rows × columns). */
export function SecondDirectionFields() {
  const on = useEditToolOptions((s) => s.pattern2);
  const count = useEditToolOptions((s) => s.pattern2Count);
  const spacing = useEditToolOptions((s) => s.pattern2Spacing);
  const angle = useEditToolOptions((s) => s.pattern2Angle);
  const unit = useLengthUnit();
  return (
    <>
      <label className="check-row">
        <input type="checkbox" checked={on} onChange={(e) => setOption({ pattern2: e.target.checked })} />
        Second direction (rows and columns)
      </label>
      {on && (
        <>
          <label className="tool-option">
            How many
            <input
              type="number"
              min={2}
              max={200}
              aria-label="How many in the second direction"
              value={count}
              onChange={(e) => setOption({ pattern2Count: Math.max(2, Math.min(200, Math.round(Number(e.target.value)) || 2)) })}
            />
          </label>
          <label className="tool-option">
            Spacing
            <input value={showLength(spacing, unit)} spellCheck={false} aria-label="Second direction spacing" onChange={(e) => setOption({ pattern2Spacing: storeLength(e.target.value, unit) })} />
            <span className="muted">{unit}</span>
          </label>
          <label className="tool-option">
            Direction
            <input value={angle} spellCheck={false} aria-label="Second direction" onChange={(e) => setOption({ pattern2Angle: e.target.value })} />
            <span className="muted">°</span>
          </label>
        </>
      )}
    </>
  );
}

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const EditToolIcons = {
  Chamfer: () => (
    <Icon>
      <path d="M4 20V10l6-6h10" />
      <path d="M4 10V4h6" strokeDasharray="1.5 1.5" />
    </Icon>
  ),
  SlotAlong: () => (
    <Icon>
      <path d="M5 18a13 13 0 0 1 13-13" strokeDasharray="2 2" />
      <path d="M2.5 18a15.5 15.5 0 0 1 15.5-15.5M7.5 18a10.5 10.5 0 0 1 10.5-10.5" />
      <path d="M2.5 18a2.5 2.5 0 0 0 5 0M18 2.5a2.5 2.5 0 0 1 0 5" />
    </Icon>
  ),
  EllipticalArc: () => (
    <Icon>
      <path d="M3 12a9 5.5 0 0 1 18 0" />
      <path d="M3 12a9 5.5 0 0 0 18 0" strokeDasharray="1.5 2" />
      <circle cx="12" cy="12" r="1.2" fill="currentColor" />
    </Icon>
  ),
};
