import { useEffect, useRef } from "react";

import { evaluate, formatMm } from "../model/expr";
import { FEATURE_DEFS, OPERATION_LABELS, resolveParams, type ParamDef } from "../model/features";
import { useStore } from "../model/store";
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
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        cancelDraft();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editing, cancelDraft]);

  if (!editing) return null;
  const { draft, mode } = editing;
  const def = FEATURE_DEFS[draft.type];
  const { errors } = resolveParams(draft);
  const hasErrors = Object.keys(errors).length > 0;
  const groups: { title: string; params: ParamDef[] }[] = [
    { title: "Size", params: def.params.filter((p) => p.group === "size") },
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

        {groups.map((g, gi) => (
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
