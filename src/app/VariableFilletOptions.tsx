/**
 * Fillet › Variable (Onshape's): a tick box, then the list of radius points — which edge, where along it, the
 * radius there — with add / remove, and Smooth or Straight between them. Clicking an edge the fillet already rounds
 * adds a point where it's clicked (the store's toggleDraftPick → clickRadiusPoint).
 */
import { describeRef } from "../geometry/topoRef";
import { evaluate } from "../model/expr";
import { showLength, storeLength } from "../model/units";
import { useLengthUnit, useStore } from "../model/store";
import { addRadiusPoint, pointsByEdge, shareWords } from "../model/variableFillet";
import type { FilletRadiusPoint, VariableFillet } from "../model/types";
import { Icons } from "./icons";

export function VariableFilletOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const unit = useLengthUnit();
  if (draft?.type !== "fillet" || draft.allEdges) return null;
  const vf = draft.variableFillet;
  const edges = (draft.picks ?? []).filter((p) => p.ref.kind === "edge");
  const set = (next: VariableFillet | undefined) => setDraftField({ variableFillet: next });
  const change = (index: number, patch: Partial<FilletRadiusPoint>) => vf && set({ ...vf, points: vf.points.map((p, i) => (i === index ? { ...p, ...patch } : p)) });
  const listed = draft && vf ? pointsByEdge(draft) : [];
  return (
    <>
      <label className="check-row" title="Set the radius at the ends of edges and at points along them; the fillet changes between them">
        {/* Ticked: the part is shown as it was, so a picked edge can be clicked where a radius goes. */}
        <input type="checkbox" checked={!!vf} onChange={(e) => (e.target.checked ? setDraftField({ variableFillet: { points: [] }, edgesPicking: true }) : set(undefined))} />
        Variable (different radii along the edges)
      </label>
      {vf && (
        <fieldset className="param-group">
          <legend>Radius points</legend>
          {edges.length === 0 ? (
            <p className="dialog-hint pick-hint">Pick the edges first. Then click an edge again near one end (or part way along) to set the radius there.</p>
          ) : (
            <p className="dialog-hint">
              Click a picked edge near an end, or part way along, to add a radius there. Ends without one use the main radius.
            </p>
          )}
          {listed.length > 0 && (
            <ul className="pick-list" aria-label="Radius points">
              {listed.map(({ point, index, edge }) => {
                const r = evaluate(point.radius);
                const bad = !r.ok ? r.error : r.value <= 0 ? "Must be more than 0" : null;
                const pick = (draft.picks ?? [])[edge];
                return (
                  <li key={index} className={bad ? "invalid" : undefined}>
                    <span title={describeRef(pick.ref)}>
                      Edge {edges.indexOf(pick) + 1},{" "}
                      <select
                        aria-label="Where along the edge"
                        value={point.at === 0 ? "0" : point.at === 1 ? "1" : "mid"}
                        onChange={(e) => change(index, { at: e.target.value === "mid" ? 0.5 : Number(e.target.value) })}
                      >
                        <option value="0">start</option>
                        <option value="mid">{point.at > 0 && point.at < 1 ? shareWords(point.at) : "part way"}</option>
                        <option value="1">end</option>
                      </select>
                      {point.at > 0 && point.at < 1 && (
                        <input
                          type="number"
                          aria-label="How far along (per cent)"
                          min={1}
                          max={99}
                          step={1}
                          style={{ width: "4em" }}
                          value={Math.round(point.at * 100)}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            if (Number.isFinite(v)) change(index, { at: Math.min(0.99, Math.max(0.01, v / 100)) });
                          }}
                        />
                      )}
                      {point.at > 0 && point.at < 1 && "%"}
                    </span>
                    <span className="param-input">
                      <input
                        aria-label="Radius here"
                        title={bad ?? "The radius at this point (a number, a variable or a sum)"}
                        aria-invalid={!!bad}
                        style={{ width: "5em" }}
                        spellCheck={false}
                        autoComplete="off"
                        value={showLength(point.radius, unit)}
                        onChange={(e) => change(index, { radius: storeLength(e.target.value, unit) })}
                      />
                      <span className="unit">{unit}</span>
                    </span>
                    <button
                      type="button"
                      className="icon-button small"
                      onClick={() => vf && set({ ...vf, points: vf.points.filter((_, i) => i !== index) })}
                      title="Remove this radius point"
                      aria-label="Remove"
                    >
                      <Icons.Cross size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {edges.length > 0 && (
            <div className="pick-footer">
              <span className="muted small">Add at the start of:</span>
              {edges.slice(0, 6).map((p, i) => (
                <button type="button" key={i} className="link-button" onClick={() => setDraftField({ variableFillet: addRadiusPoint(draft, p, 0).variableFillet })}>
                  edge {i + 1}
                </button>
              ))}
            </div>
          )}
          <div className="segmented two" role="radiogroup" aria-label="Between the points">
            {(
              [
                [false, "Smooth", "The radius changes smoothly through the points"],
                [true, "Straight", "The radius changes evenly from one point to the next"],
              ] as const
            ).map(([straight, label, hint]) => (
              <button
                type="button"
                key={label}
                role="radio"
                aria-checked={!!vf.straight === straight}
                className={!!vf.straight === straight ? "selected" : ""}
                title={hint}
                onClick={() => set({ ...vf, straight: straight || undefined })}
              >
                {label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
    </>
  );
}
