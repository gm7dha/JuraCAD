import { useEffect, useRef } from "react";

import { evaluate, formatMm } from "../model/expr";
import { FEATURE_DEFS, OPERATION_LABELS, resolveParams, type ParamDef } from "../model/features";
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
        <span className="unit">mm</span>
      </div>
      {error ? (
        <div className="param-message error" id={`${id}-error`}>
          {error}
        </div>
      ) : showsWorking && r.ok ? (
        <div className="param-message">= {formatMm(r.value)}</div>
      ) : null}
    </div>
  );
}

/** Extrude-only settings: which sketch, which way. */
function ExtrudeOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const setDraftField = useStore((s) => s.setDraftField);
  const doc = useDocument();
  if (!draft || draft.type !== "extrude") return null;
  // Only sketches above this extrude in the list can be used.
  const index = doc.features.findIndex((f) => f.id === draft.id);
  const before = mode === "edit" && index >= 0 ? doc.features.slice(0, index) : doc.features;
  const sketches = before.filter((f) => f.type === "sketch");
  const opts = draft.extrude ?? { end: "blind" as const, flip: false };

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
          onChange={(e) => setDraftField({ sketchRef: e.target.value || undefined })}
        >
          {!draft.sketchRef && <option value="">Choose a sketch…</option>}
          {sketches.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
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
      {opts.end === "blind" && (
        <label className="check-row">
          <input type="checkbox" checked={opts.flip} onChange={(e) => setDraftField({ extrude: { ...opts, flip: e.target.checked } })} />
          Flip direction
        </label>
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
    { title: draft.type === "extrude" ? "Depth" : "Size", params: def.params.filter((p) => p.group === "size") },
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

        <ExtrudeOptions />

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
