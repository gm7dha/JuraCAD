/**
 * Sweep's dialog extras (Onshape's): the profile from a sketch or a part's flat face, Profile control (None / Keep
 * profile orientation / Lock profile direction, with the direction clicked in the 3D view), how the twist is given
 * (Angle, Turns or Pitch, and Opposite direction) and Scale. The boxes themselves (twist, turns, pitch, scale) are the
 * feature's ordinary size boxes, shown by visibleParamKeys.
 */
import { describeRef } from "../geometry/topoRef";
import { canTwist, directionLabel, lockFacesLabel, PROFILE_CONTROLS, profileControlOf, tidySweepControl, TWIST_BY, twistByOf, withProfileControl, type ProfileControl, type TwistBy } from "../model/sweepOptions";
import { useStore } from "../model/store";
import type { SweepOptions as SweepDef } from "../model/types";

/** Sketch or face: which the profile is, picked at the top of the Sweep dialog. */
export function SweepProfileChoice() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (draft?.type !== "sweep" || draft.surface) return null;
  const c: SweepDef = draft.sweepControl ?? {};
  const fromFace = !!c.face || c.picking === "face";
  const set = (sweepControl: SweepDef) => setDraftField({ sweepControl: tidySweepControl(sweepControl) });
  return (
    <>
      <div className="segmented two" role="radiogroup" aria-label="Profile">
        <button type="button" role="radio" aria-checked={!fromFace} className={!fromFace ? "selected" : ""} title="Sweep the closed shapes of a sketch" onClick={() => set({ ...c, face: undefined, picking: c.picking === "face" ? undefined : c.picking })}>
          Sketch
        </button>
        <button type="button" role="radio" aria-checked={fromFace} className={fromFace ? "selected" : ""} title="Sweep a flat face of a part (holes in it stay holes)" onClick={() => !fromFace && setDraftField({ sweepControl: tidySweepControl({ ...c, picking: "face" }), moreAreas: undefined, thin: undefined })}>
          Face of a part
        </button>
      </div>
      {fromFace && (
        <fieldset className={`param-group pick-slot${c.picking === "face" ? " active" : ""}`} onClick={() => c.picking !== "face" && set({ ...c, picking: "face" })}>
          <legend>Profile face</legend>
          <p className="field-note">{c.face ? describeRef(c.face.ref, true) : "None yet"}</p>
          <p className="dialog-hint field-hint">
            {c.picking === "face" ? "Now click a flat face of a part in the 3D view." : "Click here, then a flat face in the 3D view, to sweep another face."} Holes in the face stay holes.
          </p>
        </fieldset>
      )}
    </>
  );
}

/** Profile control, twist and scale. */
export function SweepControlOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (draft?.type !== "sweep") return null;
  const c: SweepDef = draft.sweepControl ?? {};
  const set = (sweepControl: SweepDef | undefined) => setDraftField({ sweepControl: tidySweepControl(sweepControl) });
  const choice = profileControlOf(draft);
  const picking = c.picking === "direction";
  const pickingFaces = c.picking === "lockFaces";
  const twistBy = twistByOf(draft);
  return (
    <>
      <label className="field-label">Profile control</label>
      <select
        className="full-select"
        aria-label="Profile control"
        value={choice === "direction" || picking ? "direction" : pickingFaces ? "faces" : choice}
        title={PROFILE_CONTROLS.find((p) => p.id === choice)?.hint}
        onChange={(e) => set(withProfileControl(draft, e.target.value as ProfileControl))}
      >
        {PROFILE_CONTROLS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      <p className="dialog-hint field-hint">{PROFILE_CONTROLS.find((p) => p.id === (picking ? "direction" : choice))?.hint}</p>
      {choice === "faces" && (
        <fieldset className={`param-group pick-slot${pickingFaces ? " active" : ""}`} onClick={() => !pickingFaces && set({ ...c, picking: "lockFaces" })}>
          <legend>Faces to keep the angle to</legend>
          <p className="field-note">{lockFacesLabel(c.lockFaces)}</p>
          {pickingFaces && c.lockFaces?.length ? (
            <button type="button" className="link-button" onClick={(e) => { e.stopPropagation(); set({ ...c, picking: undefined }); }}>
              Done
            </button>
          ) : null}
          <p className="dialog-hint field-hint">
            {pickingFaces
              ? "Now click the faces in the 3D view (click one again to take it out). The path must be edges of these faces: choose Part edges as the path."
              : "Click here, then faces in the 3D view, to change them."}
          </p>
        </fieldset>
      )}
      {(choice === "direction" || picking) && (
        <fieldset className={`param-group pick-slot${picking ? " active" : ""}`} onClick={() => !picking && set({ ...c, picking: "direction" })}>
          <legend>Direction</legend>
          <p className="field-note">{directionLabel(c.lockDirection)}</p>
          <p className="dialog-hint field-hint">
            {picking
              ? "Now click a line, a straight edge, a flat face, Top/Front/Right or a mate connector in the 3D view."
              : "Click here, then something in the 3D view, to lock to another direction. The path mustn't run along it anywhere."}
          </p>
        </fieldset>
      )}
      {canTwist(draft) && !picking && (
        <>
          <label className="field-label">Twist given as</label>
          <div className="segmented three" role="radiogroup" aria-label="Twist given as">
            {TWIST_BY.map((t) => (
              <button
                type="button"
                key={t.id}
                role="radio"
                aria-checked={twistBy === t.id}
                className={twistBy === t.id ? "selected" : ""}
                onClick={() => set({ ...c, twistBy: t.id === "angle" ? undefined : (t.id as Exclude<TwistBy, "angle">) })}
              >
                {t.label}
              </button>
            ))}
          </div>
          <label className="check-row">
            <input type="checkbox" aria-label="Opposite direction" checked={!!c.opposite} onChange={(e) => set({ ...c, opposite: e.target.checked || undefined })} />
            Opposite direction (twist the other way)
          </label>
          <p className="dialog-hint field-hint">
            {twistBy === "turns"
              ? "Whole (or part) turns of the shape round the path, from start to end — e.g. 2 for two full turns."
              : twistBy === "pitch"
                ? "How far along the path the shape goes for each whole turn — e.g. 20 mm makes 5 turns along a 100 mm path."
                : "Twist turns the shape steadily round the path as it goes — e.g. 90° for a quarter turn by the end, up to 3600° (10 turns)."}{" "}
            Round a closed loop, use whole turns so the ends meet.
          </p>
        </>
      )}
      <label className="check-row" title="The shape grows or shrinks steadily along the path">
        <input type="checkbox" aria-label="Scale" checked={!!c.scaled} onChange={(e) => set({ ...c, scaled: e.target.checked || undefined })} />
        Scale (change size along the path)
      </label>
      {c.scaled && <p className="dialog-hint field-hint">The scale is the size at the end of the path compared with the shape as drawn: 0.5 for half the size, 2 for twice. With the shape part way along the path, it&apos;s that size where it sits.</p>}
    </>
  );
}
