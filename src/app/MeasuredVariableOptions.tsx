/**
 * The Measured variable dialog (Onshape's Variable › Measured): its name, what to measure, the things clicked in the
 * view (faces, edges, corners, planes — see Viewport's handlePick and measuredClick), and the value it comes to now.
 */
import { activeFeatures, useStore, studioParts, useLengthUnit } from "../model/store";
import { formatLength } from "../model/units";
import { MEASURE_KINDS, measuredNameProblem, measuredProblem, otherMeasuredNames, targetLabel, withKind, isPlaneTarget, type MeasureKind, type MeasuredDef } from "../model/measuredVariable";
import { Icons } from "./icons";

export function MeasuredVariableOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const value = useStore((s) => (s.editing ? s.measuredValues[s.editing.draft.id] : undefined));
  const docVariables = useStore((s) => s.history.present.variables);
  const parts = useStore(studioParts);
  const unit = useLengthUnit();
  if (draft?.type !== "variable" || !draft.measured) return null;
  const m = draft.measured;
  const set = (next: MeasuredDef) => setDraftField({ measured: next });
  const nameProblem = measuredNameProblem(m, (docVariables ?? []).map((v) => v.name), otherMeasuredNames(activeFeatures(useStore.getState()), draft.id));
  const missing = measuredProblem(m);
  const kind = MEASURE_KINDS.find((k) => k.kind === m.kind)!;
  const partName = (id: string) => parts.find((p) => p.id === id)?.name ?? "a part";
  const planeName = (id: string) => activeFeatures(useStore.getState()).find((f) => f.id === id)?.name ?? "a plane";
  return (
    <>
      <div className={`param-field${nameProblem ? " invalid" : ""}`}>
        <label htmlFor="measured-name">Variable name</label>
        <div className="param-input">
          <input id="measured-name" value={m.name} spellCheck={false} autoComplete="off" onChange={(e) => set({ ...m, name: e.target.value.trim() })} aria-invalid={!!nameProblem} />
        </div>
        {nameProblem ? <div className="param-message error">{nameProblem}</div> : null}
      </div>
      <fieldset className="param-group">
        <legend>Measure</legend>
        <select className="full-select" aria-label="What to measure" value={m.kind} onChange={(e) => set(withKind(m, e.target.value as MeasureKind))}>
          {MEASURE_KINDS.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.label}
            </option>
          ))}
        </select>
        {m.kind === "distance" && (
          <select
            className="full-select"
            aria-label="Which distance"
            value={m.along ?? "min"}
            onChange={(e) => {
              const { along: _a, ...rest } = m;
              set(e.target.value === "min" ? rest : { ...rest, along: e.target.value as "x" | "y" | "z" });
            }}
          >
            <option value="min">The shortest distance</option>
            <option value="x">How far apart along X</option>
            <option value="y">How far apart along Y</option>
            <option value="z">How far apart along Z</option>
          </select>
        )}
        {m.targets.map((t, i) => (
          <div className="reference-chip" key={i}>
            <span>
              {targetLabel(t, planeName)}
              {isPlaneTarget(t) ? "" : ` of ${partName(t.partId)}`}
            </span>
            <button type="button" className="icon-button small" onClick={() => set({ ...m, targets: m.targets.filter((_, j) => j !== i) })} title="Leave this out" aria-label="Leave this out">
              <Icons.Cross size={14} />
            </button>
          </div>
        ))}
        {/* (While something's missing the dialog says what, below.) */}
        {!missing && <p className="dialog-hint pick-hint">Click one again to leave it out. {kind.hint}</p>}
      </fieldset>
      {value && !missing && (
        <div className="dialog-note" role="status">
          {m.name || "It"} = {value.angle ? `${Math.round(value.value * 1000) / 1000}°` : formatLength(value.value, unit)}. Features after this one can use “{m.name}” in any box or sketch dimension.
        </div>
      )}
    </>
  );
}
