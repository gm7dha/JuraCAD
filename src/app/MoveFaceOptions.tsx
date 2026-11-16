/**
 * Move face's dialog extras (Onshape's): the Offset / Translate / Rotate choice and, for Translate and Rotate, the
 * direction or axis — X, Y, Z, or an edge / face clicked in the 3D view — with a flip.
 */
import { describeRef } from "../geometry/topoRef";
import { MOVE_FACE_MODES, moveFaceMode, withMoveFaceAxis, withMoveFaceMode } from "../model/moveFace";
import { useStore } from "../model/store";
import type { Axis, MoveFaceDef } from "../model/types";

export function MoveFaceOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (draft?.type !== "moveFace") return null;
  const mode = moveFaceMode(draft);
  const shown = mode === "classic" ? "offset" : mode;
  const def: MoveFaceDef = draft.moveFace ?? { mode: "offset" };
  const set = (moveFace: MoveFaceDef) => setDraftField({ moveFace });
  const picking = def.picking === "along";
  const rotate = shown === "rotate";
  const value = def.along ? "picked" : def.axis ?? "z";
  return (
    <>
      <div className="segmented three" role="radiogroup" aria-label="How the faces move">
        {MOVE_FACE_MODES.map((m) => (
          <button type="button" key={m.mode} role="radio" aria-checked={shown === m.mode} className={shown === m.mode ? "selected" : ""} title={m.hint} onClick={() => set(withMoveFaceMode(draft.moveFace, m.mode))}>
            {m.label}
          </button>
        ))}
      </div>
      {mode === "classic" && <p className="dialog-hint field-hint">Made before Move face had types: it pushes flat faces out. Choose Offset to move round faces too.</p>}
      {(shown === "translate" || rotate) && (
        <fieldset className={`param-group pick-slot${picking ? " active" : ""}`} onClick={() => !picking && set({ ...def, picking: "along" })}>
          <legend>{rotate ? "Axis to turn about" : "Direction"}</legend>
          <select
            className="full-select"
            aria-label={rotate ? "Axis to turn about" : "Direction to move along"}
            value={value}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "x" || v === "y" || v === "z") set(withMoveFaceAxis(def, v as Axis));
            }}
          >
            <option value="x">{rotate ? "X axis" : "Along X"}</option>
            <option value="y">{rotate ? "Y axis" : "Along Y"}</option>
            <option value="z">{rotate ? "Z axis" : "Along Z"}</option>
            {def.along && <option value="picked">{describeRef(def.along.ref, true)}</option>}
          </select>
          <p className="dialog-hint field-hint">
            {picking
              ? rotate
                ? "Now click a straight edge, a round edge or a hole's wall in the 3D view: the faces turn about it."
                : "Now click a straight edge (the faces move along it) or a flat face (they move straight out from it) in the 3D view."
              : rotate
                ? "Click here, then an edge or a round face in the 3D view, to turn about it. X, Y and Z go through the origin."
                : "Click here, then an edge or a flat face in the 3D view, to move along it."}
          </p>
          <label className="check-row" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={!!def.flip} onChange={(e) => set({ ...def, flip: e.target.checked || undefined })} />
            {rotate ? "Flip (turn the other way)" : "Flip (move the other way)"}
          </label>
          {picking && (
            <button type="button" className="link-button" onClick={(e) => { e.stopPropagation(); set({ ...def, picking: undefined }); }}>
              Done — back to picking faces
            </button>
          )}
        </fieldset>
      )}
    </>
  );
}
