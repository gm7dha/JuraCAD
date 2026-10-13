import { useEffect, useRef } from "react";

import { evaluate, formatMm } from "../model/expr";
import { describeRef } from "../geometry/topoRef";
import { FEATURE_DEFS, isPatternFeature, isPickFeature, isSketchSolid, OPERATION_LABELS, resolveParams, type ParamDef } from "../model/features";
import { planeLabel } from "../sketch/planes";
import type { Axis } from "../model/types";
import { axisLabel, defaultAxis } from "../sketch/axis";
import { useDocument, useStore } from "../model/store";
import type { Operation } from "../model/types";
import { Icons } from "./icons";

const OPERATIONS: Operation[] = ["new", "add", "remove"];

const OPERATION_HINTS: Record<Operation, string> = {
  new: "Make a new, separate part",
  add: "Merge into the latest part",
  remove: "Cut away from the latest part",
};

function ParamField({ def, value, autoFocus }: { def: ParamDef; value: string; autoFocus: boolean }) {
  const setDraftParam = useStore((s) => s.setDraftParam);
  const r = evaluate(value);
  const error = !r.ok ? r.error : def.positive && r.value <= 0 ? "Must be more than 0" : null;
  // Show the worked-out value when the user typed maths or units.
  const showsWorking = r.ok && !error && value.trim() !== String(r.value);
  const id = `param-${def.key}`;

  return (
    <div className={`param-field${error ? " invalid" : ""}`}>
      <label htmlFor={id}>{def.label}</label>
      <div className="param-input">
        <input
          id={id}
          value={value}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          inputMode="decimal"
          onChange={(e) => setDraftParam(def.key, e.target.value)}
          onFocus={(e) => e.target.select()}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <span className="unit">{def.unit ?? "mm"}</span>
      </div>
      {error ? (
        <div className="param-message error" id={`${id}-error`}>
          {error}
        </div>
      ) : showsWorking && r.ok ? (
        <div className="param-message">= {def.unit === "°" ? `${Math.round(r.value * 1000) / 1000}°` : def.unit === "" ? r.value : formatMm(r.value)}</div>
      ) : null}
    </div>
  );
}

/** Extrude and revolve settings: which sketch, which way (and, for revolve, around what). */
function SketchSolidOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const setDraftField = useStore((s) => s.setDraftField);
  const doc = useDocument();
  if (!draft || !isSketchSolid(draft.type)) return null;
  // Only sketches above this extrude in the list can be used.
  const index = doc.features.findIndex((f) => f.id === draft.id);
  const before = mode === "edit" && index >= 0 ? doc.features.slice(0, index) : doc.features;
  const sketches = before.filter((f) => f.type === "sketch");
  const opts = draft.extrude ?? { end: "blind" as const, flip: false };
  const rev = draft.revolve ?? { axis: "vertical", flip: false };
  const chosen = sketches.find((f) => f.id === draft.sketchRef)?.sketch?.data;
  const lines = chosen ? chosen.curves.filter((c) => c.type === "line") : [];
  const pickSketch = (id: string | undefined) => {
    const data = sketches.find((f) => f.id === id)?.sketch?.data;
    setDraftField(
      draft.type === "revolve" && data ? { sketchRef: id, revolve: { ...rev, axis: defaultAxis(data) } } : { sketchRef: id },
    );
  };

  return (
    <fieldset className="param-group">
      <legend>Sketch</legend>
      {sketches.length === 0 ? (
        <p className="dialog-error">There are no sketches yet. Cancel, then use Sketch to draw a shape first.</p>
      ) : (
        <select
          className="full-select"
          aria-label="Sketch to extrude"
          value={draft.sketchRef ?? ""}
          onChange={(e) => pickSketch(e.target.value || undefined)}
        >
          {!draft.sketchRef && <option value="">Choose a sketch…</option>}
          {sketches.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
      {draft.type === "revolve" && (
        <>
          <label className="field-label" htmlFor="revolve-axis">
            Spin around
          </label>
          <select
            id="revolve-axis"
            className="full-select"
            value={rev.axis}
            onChange={(e) => setDraftField({ revolve: { ...rev, axis: e.target.value } })}
          >
            <option value="vertical">{chosen ? axisLabel(chosen, "vertical") : "Up–down axis"}</option>
            <option value="horizontal">{chosen ? axisLabel(chosen, "horizontal") : "Left–right axis"}</option>
            {chosen &&
              lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {axisLabel(chosen, l.id)}
                </option>
              ))}
            {chosen && !["vertical", "horizontal"].includes(rev.axis) && !lines.some((l) => l.id === rev.axis) && (
              <option value={rev.axis}>Missing line — pick another</option>
            )}
          </select>
          <p className="dialog-hint field-hint">Tip: draw a construction line (Q) in the sketch to spin around any line you like.</p>
          <label className="check-row">
            <input type="checkbox" checked={rev.flip} onChange={(e) => setDraftField({ revolve: { ...rev, flip: e.target.checked } })} />
            Flip direction (for less than a full turn)
          </label>
        </>
      )}
      {draft.type === "extrude" && (
      <div className="segmented two" role="radiogroup" aria-label="Direction">
        {(["blind", "symmetric"] as const).map((end) => (
          <button
            type="button"
            key={end}
            role="radio"
            aria-checked={opts.end === end}
            className={opts.end === end ? "selected" : ""}
            onClick={() => setDraftField({ extrude: { ...opts, end } })}
            title={end === "blind" ? "Extrude out from the sketch on one side" : "Extrude the same amount on both sides of the sketch"}
          >
            {end === "blind" ? "One way" : "Symmetric"}
          </button>
        ))}
      </div>
      )}
      {draft.type === "extrude" && opts.end === "blind" && (
        <label className="check-row">
          <input type="checkbox" checked={opts.flip} onChange={(e) => setDraftField({ extrude: { ...opts, flip: e.target.checked } })} />
          Flip direction
        </label>
      )}
    </fieldset>
  );
}

const AXIS_LABELS: Record<Axis, string> = { x: "X (red, left–right)", y: "Y (green, front–back)", z: "Z (blue, up–down)" };

/** Mirror and pattern settings: which features to repeat, and how. */
function PatternOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const doc = useDocument();
  const toggleDraftSource = useStore((s) => s.toggleDraftSource);
  const setDraftField = useStore((s) => s.setDraftField);
  const setDraftMirrorPlane = useStore((s) => s.setDraftMirrorPlane);
  if (!draft || !isPatternFeature(draft.type)) return null;
  const mirror = draft.type === "mirror";
  const sources = (mirror ? draft.mirror?.sources : draft.pattern?.sources) ?? [];
  const named = sources.map((id) => ({ id, name: doc.features.find((f) => f.id === id)?.name ?? "Deleted feature" }));
  const pattern = draft.pattern ?? { sources: [], axis: "x" as Axis, flip: false };
  const plane = draft.mirror?.plane;

  return (
    <>
      <fieldset className="param-group">
        <legend>Features to {mirror ? "mirror" : "repeat"}</legend>
        {named.length === 0 ? (
          <p className="dialog-hint pick-hint">Click the features to {mirror ? "mirror" : "repeat"} in the feature list (for example a hole).</p>
        ) : (
          <ul className="pick-list" aria-label="Features to repeat">
            {named.map((f) => (
              <li key={f.id}>
                <span>{f.name}</span>
                <button type="button" className="icon-button small" onClick={() => toggleDraftSource(f.id)} title="Remove" aria-label="Remove">
                  <Icons.Cross size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {named.length > 0 && <p className="muted small field-note">Click features in the list to add or remove them. Each copy adds or cuts just like the original.</p>}
      </fieldset>
      {mirror && plane ? (
        <fieldset className="param-group">
          <legend>Mirror across</legend>
          <select
            className="full-select"
            aria-label="Plane to mirror across"
            value={plane.kind === "default" ? plane.name : "face"}
            onChange={(e) => e.target.value !== "face" && setDraftMirrorPlane({ kind: "default", name: e.target.value as "Top" | "Front" | "Right" })}
          >
            <option value="Right">Right plane (mirrors left ↔ right)</option>
            <option value="Front">Front plane (mirrors front ↔ back)</option>
            <option value="Top">Top plane (mirrors up ↔ down)</option>
            {plane.kind === "face" && <option value="face">{planeLabel(plane)}</option>}
          </select>
          <p className="dialog-hint field-hint">Or click a plane or flat face in the 3D view.</p>
        </fieldset>
      ) : (
        <fieldset className="param-group">
          <legend>{draft.type === "circularPattern" ? "Around the axis" : "Along the axis"}</legend>
          <select
            className="full-select"
            aria-label="Axis"
            value={pattern.axis}
            onChange={(e) => setDraftField({ pattern: { ...pattern, axis: e.target.value as Axis } })}
          >
            {(["x", "y", "z"] as const).map((a) => (
              <option key={a} value={a}>
                {AXIS_LABELS[a]}
                {draft.type === "circularPattern" ? " through the origin" : ""}
              </option>
            ))}
          </select>
          <label className="check-row">
            <input type="checkbox" checked={pattern.flip} onChange={(e) => setDraftField({ pattern: { ...pattern, flip: e.target.checked } })} />
            Flip direction
          </label>
        </fieldset>
      )}
    </>
  );
}

/** Fillet/chamfer/shell: the edges and faces picked so far. */
function PicksField() {
  const draft = useStore((s) => s.editing?.draft);
  const parts = useStore((s) => s.parts);
  const toggleDraftPick = useStore((s) => s.toggleDraftPick);
  const setDraftField = useStore((s) => s.setDraftField);
  if (!draft || !isPickFeature(draft.type)) return null;
  const picks = draft.picks ?? [];
  const multiPart = new Set(picks.map((p) => p.partId)).size > 1;
  const shell = draft.type === "shell";
  const verb = draft.type === "fillet" ? "round" : "bevel";

  return (
    <fieldset className="param-group">
      <legend>{shell ? "Faces to remove" : "Edges"}</legend>
      {picks.length === 0 ? (
        <p className="dialog-hint pick-hint">
          {shell
            ? "Click the face (or faces) to leave open — usually the top. The rest of the part becomes walls."
            : `Click the edges you want to ${verb} in the 3D view. Click a face to ${verb} all its edges.`}
        </p>
      ) : (
        <ul className="pick-list" aria-label="Picked edges and faces">
          {picks.map((p, i) => (
            <li key={i}>
              <span>
                {describeRef(p.ref, shell)}
                {multiPart && <span className="muted"> · {parts.find((x) => x.id === p.partId)?.name ?? "part"}</span>}
              </span>
              <button type="button" className="icon-button small" onClick={() => toggleDraftPick(p)} title="Remove from this feature" aria-label="Remove">
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {picks.length > 0 && (
        <div className="pick-footer">
          <span className="muted small">Click more {shell ? "faces" : "edges"} to add them, or click one again to remove it.</span>
          <button type="button" className="link-button" onClick={() => setDraftField({ picks: [] })}>
            Clear
          </button>
        </div>
      )}
    </fieldset>
  );
}

/** The floating feature dialog (top-left of the viewport), like Onshape's. */
export function FeatureDialog() {
  const editing = useStore((s) => s.editing);
  const setDraftField = useStore((s) => s.setDraftField);
  const commitDraft = useStore((s) => s.commitDraft);
  const cancelDraft = useStore((s) => s.cancelDraft);
  const buildError = useStore((s) => (s.editing ? s.featureErrors[s.editing.draft.id] : undefined));
  const busy = useStore((s) => s.rebuildBusy);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Sketches handle Esc themselves (it leaves the current tool, not the sketch).
    if (!editing || editing.draft.type === "sketch") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, cancelDraft]);

  if (!editing || editing.draft.type === "sketch") return null;
  const { draft, mode } = editing;
  const def = FEATURE_DEFS[draft.type];
  const { errors } = resolveParams(draft);
  const hasErrors = Object.keys(errors).length > 0;
  const groups: { title: string; params: ParamDef[] }[] = [
    { title: draft.type === "extrude" ? "Depth" : draft.type === "revolve" ? "How far round" : draft.type === "shell" ? "Walls" : isPatternFeature(draft.type) ? "Copies" : "Size", params: def.params.filter((p) => p.group === "size") },
    { title: "Position", params: def.params.filter((p) => p.group === "position") },
  ];

  return (
    <form
      ref={ref}
      className="feature-dialog"
      aria-label={`${def.label} feature`}
      onSubmit={(e) => {
        e.preventDefault();
        commitDraft();
      }}
    >
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">{def.label}</span>
        <span className="feature-dialog-actions">
          <button
            type="submit"
            className="dialog-ok"
            disabled={hasErrors}
            title={hasErrors ? "Fix the highlighted values first" : "Accept (Enter)"}
            aria-label="Accept"
          >
            <Icons.Tick size={18} />
          </button>
          <button type="button" className="dialog-cancel" onClick={cancelDraft} title="Cancel (Esc)" aria-label="Cancel">
            <Icons.Cross size={18} />
          </button>
        </span>
      </header>

      <div className="feature-dialog-body">
        <input
          className="feature-name-input"
          value={draft.name}
          aria-label="Feature name"
          onChange={(e) => setDraftField({ name: e.target.value })}
        />

        {!isPickFeature(draft.type) && !isPatternFeature(draft.type) && (
        <div className="segmented" role="radiogroup" aria-label="Operation">
          {OPERATIONS.map((op) => (
            <button
              type="button"
              key={op}
              role="radio"
              aria-checked={draft.operation === op}
              className={draft.operation === op ? "selected" : ""}
              onClick={() => setDraftField({ operation: op })}
              title={OPERATION_HINTS[op]}
            >
              {OPERATION_LABELS[op]}
            </button>
          ))}
        </div>
        )}

        <SketchSolidOptions />
        <PicksField />
        <PatternOptions />

        {groups.filter((g) => g.params.length > 0).map((g, gi) => (
          <fieldset key={g.title} className="param-group">
            <legend>{g.title}</legend>
            {g.params.map((p, pi) => (
              <ParamField
                key={p.key}
                def={p}
                value={draft.params[p.key] ?? p.defaultValue}
                autoFocus={mode === "create" && gi === 0 && pi === 0}
              />
            ))}
          </fieldset>
        ))}

        {buildError && !hasErrors && (
          <div className="dialog-error" role="alert">
            <Icons.Warning size={16} /> {buildError}
          </div>
        )}
        <p className="dialog-hint">
          {busy ? "Updating preview…" : "Tip: you can type maths and units, e.g. 10 + 2 or 1 in."}
        </p>
      </div>
    </form>
  );
}
