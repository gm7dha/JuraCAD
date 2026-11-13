/**
 * Dialog parts for curve features (Helix, Projected, Bridging, Composite, Fit spline, Intersection, Offset, Isocline and
 * Trim curves) and the
 * path choice of Sweep and Curve pattern (a sketch, a curve feature, or part edges clicked in the view).
 */
import { useMemo } from "react";
import { describeRef } from "../geometry/topoRef";
import { curveKindInfo } from "../model/curves";
import { activeFeatures, studioParts, useStore } from "../model/store";
import type { BridgeMatch, CurveDef, Feature, GeomPick } from "../model/types";
import { geomPickLabel } from "../sketch/planeTypes";
import { planeLabel } from "../sketch/planes";
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

/** Features above the one being made or changed (or the rollback bar), of these types. */
function offered(features: Feature[], draftId: string, editing: boolean, rollbackTo: string | null | undefined, keep: (f: Feature) => boolean): Feature[] {
  const at = features.findIndex((f) => f.id === draftId);
  const bar = rollbackTo ? features.findIndex((f) => f.id === rollbackTo) : -1;
  const before = editing && at >= 0 ? features.slice(0, at) : bar >= 0 ? features.slice(0, bar + 1) : features;
  return before.filter((f) => f.id !== draftId && !f.suppressed && keep(f));
}

function Chip({ text, onClear, label }: { text: string; onClear: () => void; label: string }) {
  return (
    <div className="reference-chip">
      <span>{text}</span>
      <button type="button" className="icon-button small" onClick={onClear} title="Clear" aria-label={label}>
        <Icons.Cross size={14} />
      </button>
    </div>
  );
}

const MATCHES: { value: BridgeMatch; label: string }[] = [
  { value: "position", label: "Just touch" },
  { value: "tangent", label: "Same direction" },
  { value: "curvature", label: "Same direction and bend" },
];

/** The settings of an open curve feature. */
export function CurveOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const rollbackTo = useStore((s) => s.rollbackTo);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  const names = useNames();
  if (draft?.type !== "curve" || !draft.curve) return null;
  const def = draft.curve;
  const set = (patch: Partial<CurveDef>) => setDraftField({ curve: { ...def, ...patch } });
  const label = (g: GeomPick) => geomPickLabel(g, names);
  const sketches = offered(features, draft.id, mode === "edit", rollbackTo, (f) => f.type === "sketch");
  const picks = draft.picks ?? [];
  const pickList = (what: string) =>
    picks.length ? (
      <ul className="pick-list" aria-label={what}>
        {picks.map((p, i) => (
          <li key={i}>
            <span>
              {describeRef(p.ref)} of {names(p.partId) ?? "a part"}
            </span>
            <button type="button" className="icon-button small" onClick={() => setDraftField({ picks: picks.filter((_, k) => k !== i) })} title="Take it out" aria-label="Remove">
              <Icons.Cross size={14} />
            </button>
          </li>
        ))}
      </ul>
    ) : null;
  const sketchSelect = (labelText: string, value: string | undefined, onChange: (v: string | undefined) => void) => (
    <>
      <label className="field-label">{labelText}</label>
      <select className="full-select" aria-label={labelText} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Choose a sketch…</option>
        {sketches.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </>
  );
  const info = curveKindInfo(def.kind);
  return (
    <fieldset className="param-group">
      <legend>{info.label}</legend>
      <p className="dialog-hint field-hint">{info.description}</p>
      {def.kind === "helix" && (
        <>
          <div className="segmented" role="radiogroup" aria-label="Wind round">
            {(["axis", "face"] as const).map((a) => (
              <button type="button" key={a} role="radio" aria-checked={(def.around ?? "axis") === a} className={(def.around ?? "axis") === a ? "selected" : ""} onClick={() => set({ around: a, picking: undefined })}>
                {a === "axis" ? "An axis" : "A round face or edge"}
              </button>
            ))}
          </div>
          {def.around === "face" ? (
            def.on ? (
              <Chip text={`${describeRef(def.on.ref)} of ${names(def.on.partId) ?? "a part"}`} onClear={() => set({ on: undefined })} label="Clear the face" />
            ) : (
              <p className="dialog-error">Click a round face (the side of a rod, hole or cone) or a round edge.</p>
            )
          ) : (
            <>
              <label className="field-label">Axis</label>
              {def.axis ? <Chip text={label(def.axis)} onClear={() => set({ axis: undefined, picking: undefined })} label="Clear the axis" /> : <p className="dialog-error">Click an edge, sketch line, round face or mate connector for the axis.</p>}
              <p className="dialog-hint field-hint">
                Or choose:{" "}
                {(["x", "y", "z"] as const).map((a) => (
                  <button key={a} type="button" className="link-button" onClick={() => set({ axis: { p: [0, 0, 0], dir: a === "x" ? [1, 0, 0] : a === "y" ? [0, 1, 0] : [0, 0, 1], axis: a } })}>
                    {a.toUpperCase()}
                  </button>
                ))}
              </p>
              <label className="field-label">Start point (sets the radius)</label>
              {def.start ? (
                <Chip text={label(def.start)} onClear={() => set({ start: undefined })} label="Clear the start point" />
              ) : (
                <button type="button" className={def.picking === "start" ? "link-button selected" : "link-button"} onClick={() => set({ picking: def.picking === "start" ? undefined : "start" })}>
                  {def.picking === "start" ? "Click a point in the 3D view…" : "Pick a start point (or use the diameter below)"}
                </button>
              )}
            </>
          )}
          <label className="field-label">Sizes given</label>
          <select className="full-select" aria-label="Sizes given" value={def.helixBy ?? "heightTurns"} onChange={(e) => set({ helixBy: e.target.value as CurveDef["helixBy"] })}>
            <option value="heightTurns">{def.around === "face" ? "Turns (over the face's height)" : "Height and turns"}</option>
            <option value="heightPitch">{def.around === "face" ? "Pitch (over the face's height)" : "Height and pitch"}</option>
            <option value="turnsPitch">Turns and pitch</option>
          </select>
          <label className="check-row">
            <input type="checkbox" checked={!!def.clockwise} onChange={(e) => set({ clockwise: e.target.checked || undefined })} />
            Clockwise (seen from above as it rises)
          </label>
          <label className="check-row">
            <input type="checkbox" checked={!!def.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} />
            Rise the other way
          </label>
        </>
      )}
      {def.kind === "projected" && (
        <>
          <div className="segmented" role="radiogroup" aria-label="Project">
            {(["faces", "sketches"] as const).map((k) => (
              <button type="button" key={k} role="radio" aria-checked={(def.project ?? "faces") === k} className={(def.project ?? "faces") === k ? "selected" : ""} onClick={() => set({ project: k })}>
                {k === "faces" ? "Onto faces" : "Sketch to sketch"}
              </button>
            ))}
          </div>
          {sketchSelect(def.project === "sketches" ? "First sketch" : "Sketch to project", draft.sketchRef, (v) => setDraftField({ sketchRef: v }))}
          {def.project === "sketches" ? (
            sketchSelect("Second sketch", def.sketch2, (v) => set({ sketch2: v }))
          ) : (
            <>
              {pickList("Faces")}
              {!picks.length && <p className="dialog-error">Click the faces to project onto. The sketch is pressed onto them straight across from its plane.</p>}
            </>
          )}
        </>
      )}
      {def.kind === "bridge" && (
        <>
          {(["from", "to"] as const).map((end) => {
            const g = def[end];
            const match = (end === "from" ? def.matchFrom : def.matchTo) ?? "tangent";
            return (
              <div key={end}>
                <label className="field-label">{end === "from" ? "From" : "To"}</label>
                {g ? (
                  <Chip text={label(g)} onClear={() => set({ [end]: undefined, picking: end } as Partial<CurveDef>)} label={`Clear the ${end} point`} />
                ) : (
                  <button type="button" className={def.picking === end ? "link-button selected" : "link-button"} onClick={() => set({ picking: end })}>
                    {def.picking === end || (!def.picking && end === "from") ? "Click an edge's end, a corner, a curve's end or a point…" : "Click to choose this end"}
                  </button>
                )}
                <select className="full-select" aria-label={`How it meets at the ${end === "from" ? "start" : "end"}`} value={match} onChange={(e) => set(end === "from" ? { matchFrom: e.target.value as BridgeMatch } : { matchTo: e.target.value as BridgeMatch })}>
                  {MATCHES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <label className="check-row">
                  <input type="checkbox" checked={!!(end === "from" ? def.flipFrom : def.flipTo)} onChange={(e) => set(end === "from" ? { flipFrom: e.target.checked || undefined } : { flipTo: e.target.checked || undefined })} />
                  The other way here
                </label>
              </div>
            );
          })}
          <p className="dialog-hint field-hint">An edge's end (click near it) matches the edge's direction; a plain point just touches. Bulge swings the curve out further.</p>
        </>
      )}
      {def.kind === "composite" && (
        <>
          {pickList("Edges")}
          {(def.curves ?? []).length > 0 && (
            <ul className="pick-list" aria-label="Curves">
              {(def.curves ?? []).map((id) => (
                <li key={id}>
                  <span>{names(id) ?? "A curve"}</span>
                  <button type="button" className="icon-button small" onClick={() => set({ curves: (def.curves ?? []).filter((x) => x !== id) })} title="Take it out" aria-label="Remove">
                    <Icons.Cross size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!picks.length && !(def.curves ?? []).length && <p className="dialog-error">Click edges and curves that meet end to end.</p>}
        </>
      )}
      {def.kind === "fitSpline" && (
        <>
          {(def.points ?? []).length > 0 && (
            <ol className="pick-list" aria-label="Points">
              {(def.points ?? []).map((g, i) => (
                <li key={i}>
                  <span>{label(g)}</span>
                  <button type="button" className="icon-button small" onClick={() => set({ points: (def.points ?? []).filter((_, k) => k !== i) })} title="Take it out" aria-label="Remove">
                    <Icons.Cross size={14} />
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className={(def.points ?? []).length < 2 ? "dialog-error" : "dialog-hint field-hint"}>Click points in order: corners (near the end of an edge), edge middles, flat faces' centres, mate connectors or a curve's ends. Click one again to take it out.</p>
          <label className="check-row">
            <input type="checkbox" checked={!!def.closed} onChange={(e) => set({ closed: e.target.checked || undefined })} />
            Closed (back round to the first point)
          </label>
        </>
      )}
      {def.kind === "intersection" && (
        <>
          {pickList("Faces")}
          <label className="field-label">Plane (optional)</label>
          {def.plane ? <Chip text={planeLabel(def.plane)} onClear={() => set({ plane: undefined })} label="Clear the plane" /> : <p className="dialog-hint field-hint">Click a plane to cut the faces with it — or, without one, the first face is met with the others.</p>}
          {!picks.length && <p className="dialog-error">Click the faces.</p>}
        </>
      )}
      {def.kind === "offset" && (
        <>
          {pickList("Edges and face")}
          <p className={picks.length ? "dialog-hint field-hint" : "dialog-error"}>
            Click a face to move its whole outline across it, or click edges and then the face they move across (without one, the first face beside the edges is used).
          </p>
          <label className="check-row">
            <input type="checkbox" checked={!!def.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} />
            Other way (out of the face)
          </label>
        </>
      )}
      {def.kind === "isocline" && (
        <>
          {pickList("Faces")}
          {!picks.length && <p className="dialog-error">Click the faces to find the slope on.</p>}
          <label className="field-label">Direction</label>
          {def.axis ? <Chip text={label(def.axis)} onClear={() => set({ axis: undefined, picking: "axis" })} label="Clear the direction" /> : <p className="dialog-error">Click a line, flat face or plane for the direction.</p>}
          <p className="dialog-hint field-hint">
            <button type="button" className={def.picking === "axis" ? "link-button selected" : "link-button"} onClick={() => set({ picking: def.picking === "axis" ? undefined : "axis" })}>
              {def.picking === "axis" ? "Click a line or flat face in the 3D view…" : "Pick a direction"}
            </button>{" "}
            or choose:{" "}
            {(["x", "y", "z"] as const).map((a) => (
              <button key={a} type="button" className="link-button" onClick={() => set({ axis: { p: [0, 0, 0], dir: a === "x" ? [1, 0, 0] : a === "y" ? [0, 1, 0] : [0, 0, 1], axis: a }, picking: undefined })}>
                {a.toUpperCase()}
              </button>
            ))}
          </p>
          <label className="check-row">
            <input type="checkbox" checked={!!def.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} />
            Sloping the other way (facing away from the direction)
          </label>
        </>
      )}
      {def.kind === "trim" && (
        <>
          <label className="field-label">Curve to trim</label>
          {def.curves?.[0] ? (
            <Chip text={names(def.curves[0]) ?? "A curve"} onClear={() => set({ curves: [], picking: "curve" })} label="Clear the curve to trim" />
          ) : (
            <p className="dialog-error">Click the curve to trim in the 3D view.</p>
          )}
          <label className="field-label">Cut back to</label>
          {def.curves?.[1] ? (
            <Chip text={names(def.curves[1]) ?? "A curve"} onClear={() => set({ curves: def.curves!.slice(0, 1) })} label="Clear what it's cut back to" />
          ) : def.plane ? (
            <Chip text={planeLabel(def.plane)} onClear={() => set({ plane: undefined })} label="Clear the plane" />
          ) : picks.length ? (
            pickList("Face")
          ) : (
            <p className="dialog-error">Click a face, a plane or another curve.</p>
          )}
          <label className="check-row">
            <input type="checkbox" checked={!!def.flip} onChange={(e) => set({ flip: e.target.checked || undefined })} />
            Keep the other end
          </label>
        </>
      )}
    </fieldset>
  );
}

/** Sweep's and Curve pattern's path: a sketch, a curve feature, or part edges clicked in the view. */
export function PathChoice({ label, onSketch }: { label: string; onSketch: (id: string | undefined) => void }) {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const rollbackTo = useStore((s) => s.rollbackTo);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  const names = useNames();
  if (!draft) return null;
  const choices = offered(features, draft.id, mode === "edit", rollbackTo, (f) => f.type === "sketch" || f.type === "curve");
  const edges = draft.pathEdges;
  const value = edges ? "@edges" : draft.pathRef ?? "";
  return (
    <>
      <label className="field-label">{label}</label>
      <select
        className="full-select"
        aria-label={label}
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "@edges") setDraftField({ pathEdges: edges ?? [], pathRef: undefined });
          else {
            setDraftField({ pathEdges: undefined });
            onSketch(v || undefined);
          }
        }}
      >
        <option value="">Choose a sketch or curve…</option>
        {choices.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
        <option value="@edges">Part edges (click them)</option>
      </select>
      {edges && (
        <>
          {edges.length > 0 && (
            <ul className="pick-list" aria-label="Path edges">
              {edges.map((p, i) => (
                <li key={i}>
                  <span>
                    {describeRef(p.ref)} of {names(p.partId) ?? "a part"}
                  </span>
                  <button type="button" className="icon-button small" onClick={() => setDraftField({ pathEdges: edges.filter((_, k) => k !== i) })} title="Take it out" aria-label="Remove">
                    <Icons.Cross size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className={edges.length ? "dialog-hint field-hint" : "dialog-error"}>Click edges that join end to end. A curve clicked in the view becomes the path instead.</p>
        </>
      )}
    </>
  );
}
