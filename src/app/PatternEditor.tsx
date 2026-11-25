/**
 * Changing a sketch pattern after it's made (Onshape's Edit pattern): shown in the sketch panel when a copy (or an
 * original) of a pattern is picked, or from the right-click menu's "Edit pattern…".
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";

import { useLengthUnit } from "../model/store";
import { showLength, storeLength } from "../model/units";
import { useEditToolOptions } from "../sketch/editToolOptions";
import { patternIdOf, readPattern, type PatternNow } from "../sketch/patternEdit";
import type { SketchData } from "../sketch/types";
import { applyPatternChange } from "./sketchActions";

const NO_IDS: string[] = [];

export function PatternEditor({ data, selection }: { data: SketchData; selection: string[] | undefined }) {
  const editing = useEditToolOptions((s) => s.editingPattern);
  const set = useEditToolOptions((s) => s.set);
  const sel = selection ?? NO_IDS;
  const picked = useMemo(() => (sel.length ? patternIdOf(data, sel) : null), [data, sel]);
  const shown = useMemo(() => (editing ? readPattern(data, editing) : null), [data, editing]);
  // The pattern the editor was opened for has gone (undo, deleted): close it.
  useEffect(() => {
    if (editing && !shown) set({ editingPattern: null });
  }, [editing, shown, set]);
  if (shown) return <PatternFields key={shown.id + JSON.stringify(shown)} now={shown} onClose={() => set({ editingPattern: null })} />;
  if (!picked) return null;
  return (
    <div className="tool-option">
      <button type="button" className="text-button" onClick={() => set({ editingPattern: picked })} title="Change how many copies there are, and how far apart">
        Edit pattern…
      </button>
    </div>
  );
}

function PatternFields({ now, onClose }: { now: PatternNow; onClose: () => void }) {
  const unit = useLengthUnit();
  const linear = now.kind === "linear";
  const [count, setCount] = useState(now.count);
  const [value, setValue] = useState(linear ? showLength(now.value, unit) : now.value);
  const [angle, setAngle] = useState(String(now.angle ?? 0));
  const [second, setSecond] = useState(!!now.second);
  const [count2, setCount2] = useState(now.second?.count ?? 2);
  const [value2, setValue2] = useState(showLength(now.second?.value ?? "10", unit));
  const [angle2, setAngle2] = useState(String(now.second?.angle ?? 90));
  const clampCount = (raw: string) => Math.max(2, Math.min(200, Math.round(Number(raw)) || 2));
  const apply = () => {
    const a = Number(angle);
    const a2 = Number(angle2);
    applyPatternChange(now.id, {
      count,
      value: linear ? storeLength(value, unit) : value,
      ...(linear && !now.alongLine && Number.isFinite(a) ? { angle: a } : {}),
      ...(linear ? { second: second ? { count: count2, value: storeLength(value2, unit), angle: Number.isFinite(a2) ? a2 : 90 } : null } : {}),
    });
  };
  const enter = (e: KeyboardEvent) => {
    if (e.key === "Enter") apply();
  };
  return (
    <div className="pattern-options" role="group" aria-label="Edit pattern">
      <p className="dialog-hint">
        <strong>{linear ? "Pattern in a row" : "Pattern round a centre"}</strong> — change it and press Apply. Copies already there keep their
        dimensions and relations.
      </p>
      <label className="tool-option">
        How many
        <input type="number" min={2} max={200} aria-label="Pattern count" value={count} onChange={(e) => setCount(clampCount(e.target.value))} onKeyDown={enter} />
      </label>
      <label className="tool-option" title="A number, a sum or a variable">
        {linear ? "Spacing" : "Spread over"}
        <input value={value} spellCheck={false} aria-label={linear ? "Pattern spacing (edit)" : "Pattern angle (edit)"} onChange={(e) => setValue(e.target.value)} onKeyDown={enter} />
        <span className="muted">{linear ? unit : "°"}</span>
      </label>
      {linear && !now.alongLine && (
        <label className="tool-option">
          Direction
          <input value={angle} spellCheck={false} aria-label="Pattern direction (edit)" onChange={(e) => setAngle(e.target.value)} onKeyDown={enter} />
          <span className="muted">°</span>
        </label>
      )}
      {linear && (
        <>
          <label className="check-row">
            <input type="checkbox" checked={second} onChange={(e) => setSecond(e.target.checked)} />
            Second direction (rows and columns)
          </label>
          {second && (
            <>
              <label className="tool-option">
                How many
                <input type="number" min={2} max={200} aria-label="Second direction count (edit)" value={count2} onChange={(e) => setCount2(clampCount(e.target.value))} onKeyDown={enter} />
              </label>
              <label className="tool-option">
                Spacing
                <input value={value2} spellCheck={false} aria-label="Second direction spacing (edit)" onChange={(e) => setValue2(e.target.value)} onKeyDown={enter} />
                <span className="muted">{unit}</span>
              </label>
              <label className="tool-option">
                Direction
                <input value={angle2} spellCheck={false} aria-label="Second direction (edit)" onChange={(e) => setAngle2(e.target.value)} onKeyDown={enter} />
                <span className="muted">°</span>
              </label>
            </>
          )}
        </>
      )}
      <div className="tool-option">
        <button type="button" className="primary-button" onClick={apply}>
          Apply
        </button>
        <button type="button" className="text-button" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  );
}
