import { useEffect, useMemo, useState } from "react";

import { useLengthUnit, useStore } from "../model/store";
import { showLength, storeLength } from "../model/units";
import { planeLabel } from "../sketch/planes";
import { findRegions } from "../sketch/regions";
import { sketchStatus } from "../viewport/Viewport";
import { Icons } from "./icons";

/** The sketch's feature panel (top-left of the viewport), like Onshape's sketch dialog. */
export function SketchPanel() {
  const draft = useStore((s) => (s.editing?.draft.type === "sketch" ? s.editing.draft : null));
  const message = useStore((s) => s.sketch?.message ?? null);
  const selectionCount = useStore((s) => s.sketch?.selection.length ?? 0);
  const tool = useStore((s) => s.sketch?.tool ?? "select");
  const polygonSides = useStore((s) => s.sketch?.polygonSides ?? 6);
  const filletRadius = useStore((s) => s.sketch?.filletRadius ?? "2");
  const offsetDistance = useStore((s) => s.sketch?.offsetDistance ?? "2");
  const unit = useLengthUnit();
  const theme = useStore((s) => s.theme);
  const setSketchOptions = useStore((s) => s.setSketchOptions);
  const setDraftField = useStore((s) => s.setDraftField);
  const commitDraft = useStore((s) => s.commitDraft);
  const cancelDraft = useStore((s) => s.cancelDraft);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const data = draft?.sketch?.data ?? null;
  const plane = draft?.sketch?.plane ?? null;
  const status = useMemo(() => (data ? sketchStatus(data) : null), [data]);
  const regions = useMemo(() => (data ? findRegions(data) : null), [data]);
  useEffect(() => setConfirmCancel(false), [data]);

  if (!draft || !data) return null;
  const freedom = status?.analysis.freedom ?? 0;
  const conflicts = status?.failing.size ?? 0;
  const empty = data.curves.length === 0 && data.points.length === 0;
  const changed = useStore.getState().sketch?.past.length ?? 0;

  return (
    <div className="feature-dialog sketch-panel" role="region" aria-label="Sketch">
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">Sketch</span>
        <span className="feature-dialog-actions">
          <button
            type="button"
            className="dialog-ok"
            onClick={() => commitDraft()}
            disabled={!plane}
            title={plane ? "Finish the sketch" : "Pick a plane first"}
            aria-label="Accept"
          >
            <Icons.Tick size={18} />
          </button>
          <button
            type="button"
            className="dialog-cancel"
            onClick={() => (changed > 0 && !confirmCancel ? setConfirmCancel(true) : cancelDraft())}
            title="Cancel and discard changes"
            aria-label="Cancel"
          >
            <Icons.Cross size={18} />
          </button>
        </span>
      </header>
      <div className="feature-dialog-body">
        <input className="feature-name-input" value={draft.name} aria-label="Sketch name" onChange={(e) => setDraftField({ name: e.target.value })} />
        <div className="sketch-plane-row">
          <span className="muted">On</span> <strong>{plane ? planeLabel(plane) : "— choose a plane —"}</strong>
        </div>
        {tool === "polygon" && (
          <label className="tool-option">
            Sides
            <input
              type="number"
              min={3}
              max={64}
              value={polygonSides}
              onChange={(e) => setSketchOptions({ polygonSides: Math.max(3, Math.min(64, Number(e.target.value) || 3)) })}
            />
          </label>
        )}
        {tool === "offset" && (
          <label className="tool-option">
            Distance
            <input value={showLength(offsetDistance, unit)} spellCheck={false} aria-label="Offset distance" onChange={(e) => setSketchOptions({ offsetDistance: storeLength(e.target.value, unit) })} />
            <span className="muted">{unit}</span>
          </label>
        )}
        {tool === "useEdge" && <p className="dialog-hint">Click edges of a part to copy them into this sketch.</p>}
        {tool === "sketchFillet" && (
          <label className="tool-option">
            Radius
            <input value={showLength(filletRadius, unit)} spellCheck={false} aria-label="Round radius" onChange={(e) => setSketchOptions({ filletRadius: storeLength(e.target.value, unit) })} />
            <span className="muted">{unit}</span>
          </label>
        )}
        {confirmCancel && (
          <div className="dialog-error" role="alert">
            Discard your changes to this sketch? Click ✕ again to discard, or keep sketching.
          </div>
        )}
        {plane && (
          <ul className="sketch-status">
            {empty ? (
              <li className="muted">Start with Line, Rectangle or Circle in the toolbar.</li>
            ) : conflicts > 0 ? (
              <li className="error">
                <Icons.Warning size={15} /> {conflicts} constraint{conflicts > 1 ? "s" : ""} can't all be met — undo, or select the red ones and delete
              </li>
            ) : freedom === 0 ? (
              <li className="ok">
                <Icons.Tick size={15} /> Fully defined
              </li>
            ) : (
              <li className="free">
                Under-defined: {freedom} way{freedom > 1 ? "s" : ""} it can still move or resize. Blue = free, {theme === "dark" ? "white" : "black"} = fixed.
              </li>
            )}
            {regions && !empty && (
              <li className={regions.regions.length ? "muted" : "warn"}>
                {regions.regions.length
                  ? `${regions.regions.length} closed shape${regions.regions.length > 1 ? "s" : ""} ready to extrude`
                  : "No closed shapes yet — Extrude needs a closed outline."}
              </li>
            )}
            {regions?.problems.map((p) => (
              <li key={p} className="warn">
                {p}
              </li>
            ))}
            {selectionCount > 0 && (
              <li className="muted">
                {selectionCount} selected — use the constraint buttons, Q for construction, or Delete.
              </li>
            )}
          </ul>
        )}
        {message && (
          <p className={message.tone === "error" ? "dialog-error" : "dialog-hint"} role={message.tone === "error" ? "alert" : "status"}>
            {message.text}
          </p>
        )}
      </div>
    </div>
  );
}
