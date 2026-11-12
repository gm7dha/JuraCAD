/**
 * Dialog parts for Boundary surface (curves each way, U and V, with how each part edge's side meets its face) and
 * Face blend (faces for side 1 and side 2, flips, trim).
 */
import { useMemo } from "react";
import { describeRef } from "../geometry/topoRef";
import { activeFeatures, studioParts, useStore } from "../model/store";
import { boundaryClick, MOST_EACH_WAY, setMatch } from "../model/surfaceClicks";
import type { BoundaryCurve, BoundaryDef, FaceBlendDef } from "../model/types";
import type { TopoPick } from "../geometry/topoRef";
import { Icons } from "./icons";

function useNames(): (id: string) => string | undefined {
  const features = useStore(activeFeatures);
  const parts = useStore(studioParts);
  return useMemo(() => {
    const byId = new Map<string, string>();
    for (const f of features) byId.set(f.id, f.name);
    for (const p of parts) byId.set(p.id, p.name);
    return (id: string) => byId.get(id);
  }, [features, parts]);
}

const MATCH_LABELS: { value: "" | "tangent" | "curvature"; label: string }[] = [
  { value: "", label: "Just through it" },
  { value: "tangent", label: "Smooth with the face beside it" },
  { value: "curvature", label: "Smooth and bending the same" },
];

/** A Boundary surface's curves, U then V. */
export function BoundaryOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const rollbackTo = useStore((s) => s.rollbackTo);
  const setDraftField = useStore((s) => s.setDraftField);
  const showToast = useStore((s) => s.showToast);
  const features = useStore(activeFeatures);
  const names = useNames();
  if (draft?.type !== "boundary") return null;
  const def: BoundaryDef = draft.boundary ?? { u: [], v: [] };
  const picking = def.picking ?? "u";
  const set = (next: BoundaryDef) => setDraftField({ boundary: next });
  // Sketches above this feature (or the rollback bar) that can be a boundary curve.
  const at = features.findIndex((f) => f.id === draft.id);
  const bar = rollbackTo ? features.findIndex((f) => f.id === rollbackTo) : -1;
  const before = mode === "edit" && at >= 0 ? features.slice(0, at) : bar >= 0 ? features.slice(0, bar + 1) : features;
  const sketches = before.filter((f) => f.type === "sketch" && !f.suppressed);
  const label = (c: BoundaryCurve) => (c.edge ? `${describeRef(c.edge.ref)} of ${names(c.edge.partId) ?? "a part"}` : names(c.curve ?? c.sketch ?? "") ?? "A curve that's gone");
  const way = (w: "u" | "v") => (
    <fieldset className="param-group" key={w}>
      <legend>{w === "u" ? "U curves (opposite sides)" : "V curves (the other two sides)"}</legend>
      {def[w].length > 0 && (
        <ul className="pick-list" aria-label={`${w.toUpperCase()} curves`}>
          {def[w].map((c, i) => (
            <li key={i}>
              <span>{label(c)}</span>
              {c.edge && (
                <select
                  aria-label="How the surface meets the face beside this edge"
                  value={c.match ?? ""}
                  onChange={(e) => set(setMatch(def, w, i, (e.target.value || undefined) as BoundaryCurve["match"]))}
                >
                  {MATCH_LABELS.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )}
              <button type="button" className="icon-button small" onClick={() => set({ ...def, [w]: def[w].filter((_, k) => k !== i) })} title="Take it out" aria-label="Remove">
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </fieldset>
  );
  return (
    <>
      <div className="segmented two" role="radiogroup" aria-label="Which curves a click adds">
        {(["u", "v"] as const).map((w) => (
          <button key={w} type="button" role="radio" aria-checked={picking === w} className={picking === w ? "selected" : ""} onClick={() => set({ ...def, picking: w })}>
            {w === "u" ? "Pick U curves" : "Pick V curves"}
          </button>
        ))}
      </div>
      {way("u")}
      {way("v")}
      <label className="field-label" htmlFor="boundary-sketch">
        Add a sketch's curves (to {picking.toUpperCase()})
      </label>
      <select
        id="boundary-sketch"
        className="full-select"
        value=""
        onChange={(e) => {
          if (!e.target.value) return;
          const next = boundaryClick(def, { kind: "sketch", id: e.target.value });
          if (typeof next === "string") showToast(next);
          else set(next);
        }}
      >
        <option value="">Choose a sketch…</option>
        {sketches.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
      <p className="dialog-hint field-hint">
        Click part edges or curves in the view (up to {MOST_EACH_WAY} each way). Two opposite U curves are enough — they're joined by straight lines — or pick
        V curves joining their ends too. An edge can meet the face beside it smoothly.
      </p>
    </>
  );
}

/** A Face blend's two sides and its choices. */
export function FaceBlendOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const names = useNames();
  if (draft?.type !== "faceBlend") return null;
  const blend: FaceBlendDef = draft.blend ?? { side2: [] };
  const picking = blend.picking ?? "side1";
  const set = (patch: Partial<FaceBlendDef>) => setDraftField({ blend: { ...blend, ...patch } });
  const side1 = draft.picks ?? [];
  const list = (picks: TopoPick[], which: 1 | 2) => (
    <fieldset className="param-group">
      <legend>Side {which}</legend>
      {picks.length > 0 ? (
        <ul className="pick-list" aria-label={`Side ${which} faces`}>
          {picks.map((p, i) => (
            <li key={i}>
              <span>
                {describeRef(p.ref)} of {names(p.partId) ?? "a part"}
              </span>
              <button
                type="button"
                className="icon-button small"
                onClick={() => (which === 1 ? setDraftField({ picks: side1.filter((_, k) => k !== i) }) : set({ side2: blend.side2.filter((_, k) => k !== i) }))}
                title="Take it out"
                aria-label="Remove"
              >
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="dialog-hint field-hint">No faces yet.</p>
      )}
      <label className="check-row">
        <input type="checkbox" checked={which === 1 ? !!blend.flip1 : !!blend.flip2} onChange={(e) => set(which === 1 ? { flip1: e.target.checked || undefined } : { flip2: e.target.checked || undefined })} />
        Flip (roll on the other side of these faces)
      </label>
    </fieldset>
  );
  return (
    <>
      <div className="segmented two" role="radiogroup" aria-label="Which side a click adds to">
        {(["side1", "side2"] as const).map((w) => (
          <button key={w} type="button" role="radio" aria-checked={picking === w} className={picking === w ? "selected" : ""} onClick={() => set({ picking: w })}>
            {w === "side1" ? "Pick side 1" : "Pick side 2"}
          </button>
        ))}
      </div>
      {list(side1, 1)}
      {list(blend.side2, 2)}
      <label className="check-row" title="Surfaces are cut back where the blend touches them and joined to it. Faces of one solid that meet along an edge are rounded there, like a fillet.">
        <input type="checkbox" checked={!blend.noTrim} onChange={(e) => set({ noTrim: e.target.checked ? undefined : true })} />
        Trim the faces and join them to the blend
      </label>
      <p className="dialog-hint field-hint">
        Click faces for each side (on any parts or surfaces). The ball's side is found by itself; tick Flip to roll it on the other side of a set of faces.
        Untick Trim to make the blend as a surface of its own.
      </p>
    </>
  );
}
