/**
 * Dialog parts for Onshape's other Plane types (Plane point, Point normal,
 * Line angle, Three point, Curve point, Fit) and for the Mate connector
 * feature: what's been clicked, how to take it out, and the few choices each has.
 */
import type { GeomPick, PlaneOptions } from "../model/types";
import { activeFeatures, studioParts, useStore } from "../model/store";
import { geomPickLabel, isMorePlaneMode, needsLine, pointsNeeded } from "../sketch/planeTypes";
import { Icons } from "./icons";
import { useMemo } from "react";

/** Every type, with the friendly names shown in the dialog (Onshape's names in brackets). */
export const PLANE_KINDS: { mode: PlaneOptions["mode"]; label: string; hint: string }[] = [
  { mode: "offset", label: "A distance from a plane (Offset)", hint: "Parallel to a plane or flat face, a set distance away" },
  { mode: "angle", label: "Tilted from a plane", hint: "Turned about one of the plane's directions" },
  { mode: "midplane", label: "Halfway between two faces (Mid plane)", hint: "Halfway between two parallel flat faces" },
  { mode: "point", label: "Through a point, parallel to a plane (Plane point)", hint: "Click a point; it lies flat to the plane chosen" },
  { mode: "pointNormal", label: "Through a point, square to a line (Point normal)", hint: "Click a corner, then a straight edge, axis or flat face" },
  { mode: "lineAngle", label: "Through a line, at an angle (Line angle)", hint: "Click a straight edge, axis or sketch line; then type the angle" },
  { mode: "threePoint", label: "Through three points (Three point)", hint: "Click three corners, edge middles, face centres or mate connectors" },
  { mode: "curvePoint", label: "Square to an edge (Curve point)", hint: "Click an edge where the plane should cross it" },
  { mode: "fit", label: "Best fit through points (Fit)", hint: "Click three or more points; the plane fits them as closely as it can" },
];

/** The kind of plane, as a drop-down (as Onshape's Plane type). */
export function PlaneKindSelect({ pd, update }: { pd: PlaneOptions; update: (patch: Partial<PlaneOptions>) => void }) {
  const hint = PLANE_KINDS.find((k) => k.mode === pd.mode)?.hint;
  return (
    <label className="full-select-label">
      <select className="full-select" aria-label="Kind of plane" value={pd.mode} title={hint} onChange={(e) => update({ mode: e.target.value as PlaneOptions["mode"] })}>
        {PLANE_KINDS.map((k) => (
          <option key={k.mode} value={k.mode}>
            {k.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** Names for what a pick is on (parts, sketches, mate connectors). */
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

const POINT_HINT = "Click in the 3D view: a corner (near the end of an edge), an edge's middle, a flat face's centre or a mate connector.";
const LINE_HINT = "Click a straight edge, a round edge or face (its axis), a flat face (straight out of it), a sketch line or a mate connector (its Z) — or choose an axis:";

/** The newer types' points, line, place along an edge and flip. */
export function MorePlaneFields({ pd, update }: { pd: PlaneOptions; update: (patch: Partial<PlaneOptions>) => void }) {
  const names = useNames();
  if (!isMorePlaneMode(pd.mode)) return null;
  const mode = pd.mode;
  const points = pd.points ?? [];
  const want = pointsNeeded(mode);
  const label = (g: GeomPick) => geomPickLabel(g, names);
  const remove = (i: number) => {
    const rest = points.filter((_, k) => k !== i);
    update(rest.length ? { points: rest } : { points: undefined });
  };
  const axis = (a: "x" | "y" | "z") => update({ line: { p: [0, 0, 0], dir: a === "x" ? [1, 0, 0] : a === "y" ? [0, 1, 0] : [0, 0, 1], axis: a } });
  return (
    <>
      {mode !== "lineAngle" && (
        <fieldset className="param-group">
          <legend>{mode === "curvePoint" ? "Edge" : want > 1 ? "Points" : "Point"}</legend>
          {points.length > 0 && (
            <ul className="pick-list" aria-label={mode === "curvePoint" ? "Edge" : "Points"}>
              {points.map((g, i) => (
                <li key={i}>
                  <span>{label(g)}</span>
                  <button type="button" className="icon-button small" onClick={() => remove(i)} title="Take it out" aria-label="Remove">
                    <Icons.Cross size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {points.length < want || mode === "fit" ? (
            <p className={points.length < want ? "dialog-error" : "dialog-hint field-hint"}>
              {mode === "curvePoint"
                ? "Click an edge where the plane should cross it."
                : points.length < want
                  ? `${want - points.length === 1 ? "One more point" : `${want - points.length} more points`}. ${POINT_HINT}`
                  : "Click more points to fit to, or a chosen one again to take it out."}
            </p>
          ) : null}
          {mode === "curvePoint" && points.length > 0 && (
            <label className="param-row">
              <span>Where along it</span>
              <input
                type="range"
                min={0}
                max={100}
                step={1}
                aria-label="Where along the edge"
                value={Math.round((pd.position ?? 0.5) * 100)}
                onChange={(e) => update({ position: Number(e.target.value) / 100 })}
              />
              <span className="muted small">{Math.round((pd.position ?? 0.5) * 100)}%</span>
            </label>
          )}
        </fieldset>
      )}
      {needsLine(mode) && mode !== "curvePoint" && (
        <fieldset className="param-group">
          <legend>{mode === "lineAngle" ? "Line to turn about" : "Square to"}</legend>
          {pd.line ? (
            <div className="reference-chip">
              <span>{label(pd.line)}</span>
              <button type="button" className="icon-button small" onClick={() => update({ line: undefined })} title="Clear" aria-label="Clear the line">
                <Icons.Cross size={14} />
              </button>
            </div>
          ) : (
            <p className="dialog-error">{mode === "lineAngle" ? "Click the line the plane goes through." : "Click what the plane stands square to."}</p>
          )}
          <p className="dialog-hint field-hint">
            {LINE_HINT}{" "}
            {(["x", "y", "z"] as const).map((a) => (
              <button key={a} type="button" className="link-button" onClick={() => axis(a)}>
                {a.toUpperCase()}
              </button>
            ))}
          </p>
          {mode === "lineAngle" && <p className="dialog-hint field-hint">At 0° the plane stands upright through the line (or, for an upright line, faces along Y). Type the angle to turn it.</p>}
        </fieldset>
      )}
      <label className="check-row">
        <input type="checkbox" checked={!!pd.flip} onChange={(e) => update({ flip: e.target.checked || undefined })} />
        Turn it over (face the other way)
      </label>
    </>
  );
}

/** Mate connector settings: where it sits, which part it belongs to, turned over. The moves and turns are its boxes. */
export function MateConnectorOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  const names = useNames();
  if (draft?.type !== "mateConnector" || !draft.connector) return null;
  const c = draft.connector;
  const where = c.at.pick || c.at.sketchPoint || c.at.connector ? geomPickLabel(c.at, names) : c.plane ? `${c.plane.kind === "default" ? `The ${c.plane.name} plane` : c.plane.label} (at its origin)` : "Nowhere yet";
  const spots: { value: string; label: string }[] =
    c.at.pick?.ref.kind === "edge"
      ? [
          { value: "", label: c.at.pick.ref.curve === "CIRCLE" ? "Centre" : "Middle" },
          { value: "start", label: "One end" },
          { value: "end", label: "Other end" },
          ...(c.at.pick.ref.curve === "CIRCLE" ? [{ value: "middle", label: "On the edge, halfway" }] : []),
        ]
      : [];
  const solids = parts.filter((p) => !p.surface);
  return (
    <>
      <fieldset className="param-group">
        <legend>Where</legend>
        <div className="reference-chip">
          <span>{where}</span>
        </div>
        {spots.length > 0 && (
          <select
            className="full-select"
            aria-label="Where on the edge"
            value={c.at.spot ?? ""}
            onChange={(e) => {
              const { spot: _s, ...at } = c.at;
              setDraftField({ connector: { ...c, at: e.target.value ? { ...at, spot: e.target.value as "start" | "end" | "middle" } : at } });
            }}
          >
            {spots.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
        )}
        <p className="dialog-hint field-hint">Click a face (its centre), an edge (its middle, or a round edge's centre), a corner (near an edge's end), another mate connector or a plane in the 3D view.</p>
      </fieldset>
      <label className="param-row">
        <span>Belongs to</span>
        <select
          className="full-select"
          aria-label="Owner part"
          value={c.owner ?? ""}
          onChange={(e) => {
            const { owner: _o, ...rest } = c;
            setDraftField({ connector: e.target.value ? { ...rest, owner: e.target.value } : rest });
          }}
        >
          <option value="">{c.at.pick ? `The part it's on (${names(c.at.pick.partId) ?? "?"})` : "The latest part"}</option>
          {solids.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <p className="dialog-hint field-hint">In an assembly, click it to mate to it. It also moves parts in Move / copy (by mate connectors), and you can sketch on it.</p>
      <label className="check-row">
        <input type="checkbox" checked={!!c.flipZ} onChange={(e) => setDraftField({ connector: { ...c, flipZ: e.target.checked || undefined } })} />
        Turn Z over
      </label>
    </>
  );
}
