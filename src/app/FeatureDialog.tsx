import { useEffect, useRef } from "react";

import { evaluate } from "../model/expr";
import { formatLength, lengthNumber, showLength, storeLength } from "../model/units";
import { describeRef } from "../geometry/topoRef";
import { FEATURE_DEFS, isPatternFeature, isPickFeature, isSketchSolid, OPERATION_LABELS, resolveParams, visibleParamKeys, type ParamDef } from "../model/features";
import { describeHole, SCREW_SIZES, standardParams } from "../model/holes";
import type { HoleOptions as HoleSettings } from "../model/types";
import { holePositionCount } from "../sketch/holePositions";
import { planeLabel } from "../sketch/planes";
import { framesOf, planeAsSketchPlane } from "../sketch/planeFeature";
import type { Axis } from "../model/types";
import { axisLabel, defaultAxis } from "../sketch/axis";
import { activeFeatures, studioParts, useLengthUnit, useStore } from "../model/store";
import type { Operation } from "../model/types";
import { DeleteFaceHelp } from "./DeleteFaceHelp";
import { Icons } from "./icons";
import { FASTENER_KINDS, FASTENER_LABELS, FASTENER_SIZES, type FastenerKind } from "../model/fasteners";
import { ISO_COARSE } from "../kernel/thread";
import { importedSize } from "../model/importFile";
import { chooseImportFile } from "./fileActions";

const OPERATIONS: Operation[] = ["new", "add", "remove", "intersect"];

const OPERATION_HINTS: Record<Operation, string> = {
  new: "Make a new, separate part",
  add: "Merge into the latest part",
  remove: "Cut away from the latest part",
  intersect: "Keep only where it overlaps the latest part",
};

function ParamField({ def, value, autoFocus }: { def: ParamDef; value: string; autoFocus: boolean }) {
  const setDraftParam = useStore((s) => s.setDraftParam);
  const unit = useLengthUnit();
  const isLength = def.unit === undefined || def.unit === "mm";
  // Lengths are shown and typed in the design's units (see units.ts).
  const shown = isLength ? showLength(value, unit) : value;
  const r = evaluate(value);
  const error = !r.ok ? r.error : def.positive && r.value <= 0 ? "Must be more than 0" : null;
  // Show the worked-out value when the user typed maths or units.
  const showsWorking = r.ok && !error && shown.trim() !== (isLength ? lengthNumber(r.value, unit, 4) : String(r.value));
  const id = `param-${def.key}`;

  return (
    <div className={`param-field${error ? " invalid" : ""}`}>
      <label htmlFor={id}>{def.label}</label>
      <div className="param-input">
        <input
          id={id}
          value={shown}
          autoFocus={autoFocus}
          spellCheck={false}
          autoComplete="off"
          inputMode="decimal"
          onChange={(e) => setDraftParam(def.key, isLength ? storeLength(e.target.value, unit) : e.target.value)}
          onFocus={(e) => e.target.select()}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        />
        <span className="unit">{isLength ? unit : def.unit}</span>
      </div>
      {error ? (
        <div className="param-message error" id={`${id}-error`}>
          {error}
        </div>
      ) : showsWorking && r.ok ? (
        <div className="param-message">= {def.unit === "°" ? `${Math.round(r.value * 1000) / 1000}°` : def.unit === "" ? r.value : formatLength(r.value, unit)}</div>
      ) : null}
    </div>
  );
}

/** Split settings: which part, and the plane to cut it along. */
function SplitOptionsField() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  const features = useStore(activeFeatures);
  if (draft?.type !== "split" || !draft.splitDef) return null;
  const sp = draft.splitDef;
  const update = (patch: Partial<typeof sp>) => setDraftField({ splitDef: { ...sp, ...patch } });
  const planes = features.filter((f) => f.type === "plane");
  const frames = framesOf(features);
  const planeValue = sp.plane.kind === "default" ? sp.plane.name : sp.plane.planeRef ? `plane:${sp.plane.planeRef}` : "face";
  return (
    <>
      <fieldset className={`param-group pick-slot${sp.picking !== "plane" ? " active" : ""}`} onClick={() => sp.picking === "plane" && update({ picking: "part" })}>
        <legend>Part to split</legend>
        <p className={sp.partId ? "field-hint" : "dialog-hint field-hint"}>{sp.partId ? parts.find((p) => p.id === sp.partId)?.name ?? "(missing part)" : "Click the part to split."}</p>
      </fieldset>
      <fieldset className={`param-group pick-slot${sp.picking === "plane" ? " active" : ""}`} onClick={() => sp.picking !== "plane" && update({ picking: "plane" })}>
        <legend>Split along</legend>
        <select
          className="full-select"
          aria-label="Plane to split along"
          value={planeValue}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "Top" || v === "Front" || v === "Right") update({ plane: { kind: "default", name: v } });
            else if (v.startsWith("plane:")) {
              const f = planes.find((x) => `plane:${x.id}` === v);
              const frame = f && frames.get(f.id);
              if (f && frame) update({ plane: planeAsSketchPlane(f, frame) });
            }
          }}
        >
          <option value="Top">Top plane</option>
          <option value="Front">Front plane</option>
          <option value="Right">Right plane</option>
          {planes.map((f) => (
            <option key={f.id} value={`plane:${f.id}`}>
              {f.name}
            </option>
          ))}
          {planeValue === "face" && <option value="face">{planeLabel(sp.plane)}</option>}
        </select>
        <p className="dialog-hint field-hint">Or click a plane or flat face in the 3D view.</p>
      </fieldset>
      <div className="segmented three" role="radiogroup" aria-label="Keep">
        {(
          [
            ["both", "Both pieces", "Keep both pieces, as two parts"],
            ["front", "Front side", "Keep the piece on the plane's front side"],
            ["back", "Back side", "Keep the piece on the plane's back side"],
          ] as const
        ).map(([keep, label, hint]) => (
          <button type="button" key={keep} role="radio" aria-checked={sp.keep === keep} className={sp.keep === keep ? "selected" : ""} title={hint} onClick={() => update({ keep })}>
            {label}
          </button>
        ))}
      </div>
    </>
  );
}

/** Replace face: the face or plane the picked faces are moved onto. */
function ReplaceFaceOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  if (draft?.type !== "replaceFace") return null;
  const rd = draft.replaceDef ?? { target: null };
  const picking = rd.picking === "target";
  const planes = features.filter((f) => f.type === "plane");
  const frames = framesOf(features);
  const target = rd.target;
  const value = !target ? "" : target.kind === "default" ? target.name : target.planeRef ? `plane:${target.planeRef}` : "face";
  return (
    <fieldset className={`param-group pick-slot${picking ? " active" : ""}`} onClick={() => !picking && setDraftField({ replaceDef: { ...rd, picking: "target" } })}>
      <legend>Move them onto</legend>
      <select
        className="full-select"
        aria-label="Face or plane to move them onto"
        value={value}
        onClick={(e) => e.stopPropagation()}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "Top" || v === "Front" || v === "Right") setDraftField({ replaceDef: { target: { kind: "default", name: v }, picking: "faces" } });
          else if (v.startsWith("plane:")) {
            const f = planes.find((x) => `plane:${x.id}` === v);
            const frame = f && frames.get(f.id);
            if (f && frame) setDraftField({ replaceDef: { target: planeAsSketchPlane(f, frame), picking: "faces" } });
          }
        }}
      >
        {!target && <option value="">(not picked yet)</option>}
        <option value="Top">Top plane</option>
        <option value="Front">Front plane</option>
        <option value="Right">Right plane</option>
        {planes.map((f) => (
          <option key={f.id} value={`plane:${f.id}`}>
            {f.name}
          </option>
        ))}
        {value === "face" && target && <option value="face">{planeLabel(target)}</option>}
      </select>
      <p className="dialog-hint field-hint">
        {picking ? "Now click the flat face (on any part) to move them onto, or a plane." : "Click here, then a flat face in the 3D view, to move them onto it. It must be parallel to them."}
      </p>
    </fieldset>
  );
}

/** Draft: the neutral plane, and which way the part pulls out. */
function DraftOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  if (draft?.type !== "draft") return null;
  const neutral = draft.neutral ?? { kind: "default" as const, name: "Top" as const };
  const planes = features.filter((f) => f.type === "plane");
  const frames = framesOf(features);
  const value = neutral.kind === "default" ? neutral.name : neutral.planeRef ? `plane:${neutral.planeRef}` : "face";
  return (
    <fieldset className="param-group">
      <legend>Neutral plane</legend>
      <select
        className="full-select"
        aria-label="Neutral plane"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          if (v === "Top" || v === "Front" || v === "Right") setDraftField({ neutral: { kind: "default", name: v } });
          else if (v.startsWith("plane:")) {
            const f = planes.find((x) => `plane:${x.id}` === v);
            const frame = f && frames.get(f.id);
            if (f && frame) setDraftField({ neutral: planeAsSketchPlane(f, frame) });
          }
        }}
      >
        <option value="Top">Top plane</option>
        <option value="Front">Front plane</option>
        <option value="Right">Right plane</option>
        {planes.map((f) => (
          <option key={f.id} value={`plane:${f.id}`}>
            {f.name}
          </option>
        ))}
        {value === "face" && <option value="face">{planeLabel(neutral)}</option>}
      </select>
      <p className="dialog-hint field-hint">The faces pivot where they meet this plane (or click a plane in the 3D view). Usually the base of the part.</p>
      <label className="check-row">
        <input type="checkbox" checked={!!draft.flipSide} onChange={(e) => setDraftField({ flipSide: e.target.checked })} />
        Flip (pull out the other way)
      </label>
    </fieldset>
  );
}

/** Rib: which sketch; Rib and Thicken: which way. */
function RibThickenOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  if (draft?.type !== "rib" && draft?.type !== "thicken" && draft?.type !== "sheetMetal" && draft?.type !== "flange" && draft?.type !== "hem" && draft?.type !== "tab") return null;
  const at = features.findIndex((f) => f.id === draft.id);
  const sketches = (at >= 0 ? features.slice(0, at) : features).filter((f) => f.type === "sketch" && !f.suppressed);
  return (
    <>
      {(draft.type === "rib" || draft.type === "sheetMetal" || draft.type === "tab") && (
        <fieldset className="param-group">
          <legend>{draft.type === "rib" ? "Rib lines" : draft.type === "tab" ? "Shape of the tab" : "Shape of the sheet"}</legend>
          <select className="full-select" aria-label={draft.type === "rib" ? "Sketch with the rib lines" : draft.type === "tab" ? "Sketch with the tab's shape" : "Sketch with the sheet's shape"} value={draft.sketchRef ?? ""} onChange={(e) => setDraftField({ sketchRef: e.target.value || undefined })}>
            {!draft.sketchRef && <option value="">Choose a sketch…</option>}
            {sketches.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </select>
          <p className="dialog-hint field-hint">
            {draft.type === "rib"
              ? "Draw the rib as a line (or lines) across the corner it braces, on a plane through the part."
              : draft.type === "tab"
              ? "Sketch on a face of the sheet (its top or bottom, or a flange's face) — closed shapes that overlap or meet the edge become part of that wall, and of its flat pattern."
              : "A closed shape makes a flat sheet (holes in it go through). Or draw the side view as connected lines — an L, U or Z — for a bent sheet: the lines are one face of the metal and the corners become bends. Then bend flanges off its edges."}
          </p>
        </fieldset>
      )}
      {draft.type === "flange" && (
        <label className="check-row" title="Where one of these flanges meets another full-length 90° flange at a square corner, their ends are extended so one laps over the other instead of leaving a gap">
          <input type="checkbox" checked={!!draft.closeCorners} onChange={(e) => setDraftField({ closeCorners: e.target.checked || undefined })} />
          Close corners where flanges meet
        </label>
      )}
      {draft.type !== "tab" && (
      <label className="check-row">
        <input type="checkbox" checked={!!draft.flipSide} onChange={(e) => setDraftField({ flipSide: e.target.checked })} />
        {draft.type === "rib"
          ? "Flip (fill the other side of the line)"
          : draft.type === "sheetMetal"
          ? "Flip (the metal on the other side of the sketch)"
          : draft.type === "flange"
          ? "Bend down instead of up"
          : draft.type === "hem"
          ? "Fold under instead of over"
          : "Flip (grow inwards)"}
      </label>
      )}
    </>
  );
}

/** Boolean settings: join, cut or intersect, and the parts for each. */
function BooleanOptionsField() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const toggle = useStore((s) => s.toggleBooleanPart);
  const parts = useStore(studioParts);
  if (draft?.type !== "boolean" || !draft.booleanDef) return null;
  const b = draft.booleanDef;
  const update = (patch: Partial<typeof b>) => setDraftField({ booleanDef: { ...b, ...patch } });
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? "(missing part)";
  const list = (ids: string[], label: string) => (
    <ul className="pick-list" aria-label={label}>
      {ids.map((id) => (
        <li key={id}>
          <span>{nameOf(id)}</span>
          <button type="button" className="icon-button small" onClick={() => toggle(id)} title="Remove" aria-label={`Remove ${nameOf(id)}`}>
            <Icons.Cross size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      <div className="segmented three" role="radiogroup" aria-label="Boolean">
        {(
          [
            ["union", "Join", "Merge the parts into one"],
            ["subtract", "Subtract", "Cut some parts with others"],
            ["intersect", "Intersect", "Keep only where the parts overlap"],
          ] as const
        ).map(([op, label, hint]) => (
          <button type="button" key={op} role="radio" aria-checked={b.op === op} className={b.op === op ? "selected" : ""} title={hint} onClick={() => update({ op, picking: "targets" })}>
            {label}
          </button>
        ))}
      </div>
      {b.op !== "subtract" ? (
        <fieldset className="param-group">
          <legend>Parts</legend>
          {list(b.targets, "Parts")}
          <p className="dialog-hint field-hint">Click parts in the 3D view or the Parts list to add or remove them.</p>
        </fieldset>
      ) : (
        <>
          <fieldset className={`param-group pick-slot${b.picking !== "tools" ? " active" : ""}`} onClick={() => b.picking === "tools" && update({ picking: "targets" })}>
            <legend>Parts to cut</legend>
            {list(b.targets, "Parts to cut")}
            {b.picking !== "tools" && <p className="dialog-hint field-hint">Click the parts to cut.</p>}
          </fieldset>
          <fieldset className={`param-group pick-slot${b.picking === "tools" ? " active" : ""}`} onClick={() => b.picking !== "tools" && update({ picking: "tools" })}>
            <legend>Cut with</legend>
            {list(b.tools, "Cut with")}
            {b.picking === "tools" ? <p className="dialog-hint field-hint">Click the parts to cut with.</p> : <p className="dialog-hint field-hint">Click here, then the parts to cut with.</p>}
            <label className="check-row" onClick={(e) => e.stopPropagation()}>
              <input type="checkbox" checked={b.keepTools} onChange={(e) => update({ keepTools: e.target.checked })} />
              Keep the parts used to cut
            </label>
          </fieldset>
        </>
      )}
    </>
  );
}

/** Plane settings: what it's based on, and how (a distance away, tilted, or halfway between two faces). */
function PlaneDefOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  if (draft?.type !== "plane" || !draft.planeDef) return null;
  const pd = draft.planeDef;
  const update = (patch: Partial<typeof pd>) => setDraftField({ planeDef: { ...pd, ...patch } });
  // Earlier Plane features can be based on too.
  const at = features.findIndex((f) => f.id === draft.id);
  const earlier = (at >= 0 ? features.slice(0, at) : features).filter((f) => f.type === "plane");
  const frames = framesOf(features);
  const refValue = pd.ref.kind === "default" ? pd.ref.name : pd.ref.planeRef ? `plane:${pd.ref.planeRef}` : "face";
  return (
    <>
      <div className="segmented three" role="radiogroup" aria-label="Kind of plane">
        {(
          [
            ["offset", "Distance", "Parallel to a plane or flat face, a set distance away"],
            ["angle", "Tilted", "Turned about one of the plane's directions"],
            ["midplane", "Halfway", "Halfway between two parallel flat faces"],
          ] as const
        ).map(([mode, label, hint]) => (
          <button type="button" key={mode} role="radio" aria-checked={pd.mode === mode} className={pd.mode === mode ? "selected" : ""} title={hint} onClick={() => update({ mode })}>
            {label}
          </button>
        ))}
      </div>
      <fieldset className="param-group">
        <legend>{pd.mode === "midplane" ? "Between" : "From"}</legend>
        <select
          className="full-select"
          aria-label="Plane to start from"
          value={refValue}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "Top" || v === "Front" || v === "Right") update({ ref: { kind: "default", name: v } });
            else if (v.startsWith("plane:")) {
              const f = earlier.find((x) => `plane:${x.id}` === v);
              const frame = f && frames.get(f.id);
              if (f && frame) update({ ref: planeAsSketchPlane(f, frame) });
            }
          }}
        >
          <option value="Top">Top plane</option>
          <option value="Front">Front plane</option>
          <option value="Right">Right plane</option>
          {earlier.map((f) => (
            <option key={f.id} value={`plane:${f.id}`}>
              {f.name}
            </option>
          ))}
          {refValue === "face" && <option value="face">{planeLabel(pd.ref)}</option>}
        </select>
        {pd.mode === "midplane" && (
          <p className={pd.ref2 ? "dialog-hint field-hint" : "dialog-error"}>
            {pd.ref2 ? `and ${planeLabel(pd.ref2)}` : "Now click a second flat face, parallel to the first."}
            {pd.ref2 && (
              <button type="button" className="text-button small-text" onClick={() => update({ ref2: undefined })}>
                {" "}Pick again
              </button>
            )}
          </p>
        )}
        {pd.mode === "angle" && (
          <select className="full-select" aria-label="Tilt about" value={pd.axis} onChange={(e) => update({ axis: e.target.value === "v" ? "v" : "u" })}>
            <option value="u">Tilt about its across direction</option>
            <option value="v">Tilt about its up direction</option>
          </select>
        )}
        <p className="dialog-hint field-hint">Or click a plane or flat face in the 3D view{pd.mode === "midplane" ? " (first one face, then the other)" : ""}.</p>
      </fieldset>
    </>
  );
}

/** Extrude and revolve settings: which sketch, which way (and, for revolve, around what). */
function SketchSolidOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  if (!draft || !isSketchSolid(draft.type)) return null;
  // Only sketches above this extrude in the list can be used.
  const index = features.findIndex((f) => f.id === draft.id);
  const before = mode === "edit" && index >= 0 ? features.slice(0, index) : features;
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
      <div className="segmented four" role="radiogroup" aria-label="Direction">
        {(["blind", "symmetric", "upToFace", "throughAll"] as const).map((end) => (
          <button
            type="button"
            key={end}
            role="radio"
            aria-checked={opts.end === end}
            className={opts.end === end ? "selected" : ""}
            onClick={() => setDraftField({ extrude: { ...opts, end } })}
            title={
              end === "blind"
                ? "Extrude out from the sketch on one side"
                : end === "symmetric"
                  ? "Extrude the same amount on both sides of the sketch"
                  : end === "upToFace"
                    ? "Extrude until it reaches a flat face you click (parallel to the sketch)"
                    : "Cut right through every part, on both sides of the sketch, however thick it gets (Remove only)"
            }
          >
            {end === "blind" ? "One way" : end === "symmetric" ? "Both" : end === "upToFace" ? "To face" : "Through"}
          </button>
        ))}
      </div>
      )}
      {draft.type === "extrude" && opts.end === "upToFace" && (
        <p className={`dialog-hint field-hint${opts.upTo ? "" : " attention"}`}>
          {opts.upTo ? "Face chosen — click another face to change it." : "Click the flat face to extrude up to."}
        </p>
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

/** Text: the words, the plane, bold, and which way. */
function TextFeatureOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (draft?.type !== "text" || !draft.text) return null;
  const t = draft.text;
  const where = t.face ? "a round face (wrapped round it)" : !t.plane ? "— click a plane or a face —" : t.plane.kind === "default" ? `${t.plane.name} plane` : t.plane.label;
  return (
    <fieldset className="param-group">
      <legend>Text</legend>
      <textarea
        className="text-feature-input"
        value={t.value}
        rows={2}
        aria-label="Text"
        spellCheck={false}
        onChange={(e) => setDraftField({ text: { ...t, value: e.target.value } })}
      />
      <p className="dialog-hint field-hint">
        On <strong>{where}</strong>. Click a plane, a flat face or a round face to move it there.
        {t.face ? " On a round face, Start X moves it round the face and Start Y along it." : ""}
      </p>
      <label className="check-row">
        <input type="checkbox" checked={t.bold} onChange={(e) => setDraftField({ text: { ...t, bold: e.target.checked } })} />
        Bold
      </label>
      <label className="check-row">
        <input type="checkbox" checked={t.flip} onChange={(e) => setDraftField({ text: { ...t, flip: e.target.checked } })} />
        Flip direction (into the part — use with Remove to engrave)
      </label>
    </fieldset>
  );
}

/** Sweep (profile and path sketches) and loft (the sketches to pass through, in order). */
function SweepLoftOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  if (!draft || (draft.type !== "sweep" && draft.type !== "loft")) return null;
  const index = features.findIndex((f) => f.id === draft.id);
  const sketches = (mode === "edit" && index >= 0 ? features.slice(0, index) : features).filter((f) => f.type === "sketch");
  const select = (label: string, value: string | undefined, onChange: (v: string | undefined) => void) => (
    <>
      <label className="field-label">{label}</label>
      <select className="full-select" aria-label={label} value={value ?? ""} onChange={(e) => onChange(e.target.value || undefined)}>
        <option value="">Choose a sketch…</option>
        {sketches.map((f) => (
          <option key={f.id} value={f.id}>
            {f.name}
          </option>
        ))}
      </select>
    </>
  );
  if (draft.type === "sweep") {
    return (
      <fieldset className="param-group">
        <legend>Sketches</legend>
        {select("Shape (profile)", draft.sketchRef, (v) => setDraftField({ sketchRef: v }))}
        {select("Path to follow", draft.pathRef, (v) => setDraftField({ pathRef: v }))}
        <p className="dialog-hint field-hint">Draw the shape on a plane across the start of the path, e.g. a circle on Front for a path drawn on Top.</p>
      </fieldset>
    );
  }
  const sections = draft.sections ?? [];
  return (
    <fieldset className="param-group">
      <legend>Shapes to join, in order</legend>
      {sketches.map((f) => {
        const at = sections.indexOf(f.id);
        return (
          <label key={f.id} className="check-row">
            <input
              type="checkbox"
              checked={at >= 0}
              onChange={() => setDraftField({ sections: at >= 0 ? sections.filter((x) => x !== f.id) : [...sections, f.id] })}
            />
            {at >= 0 ? `${at + 1}. ` : ""}
            {f.name}
          </label>
        );
      })}
      <p className="dialog-hint field-hint">Tick the sketches in the order the solid should pass through them. Each needs one closed shape.</p>
    </fieldset>
  );
}

/** Transform settings: which part, turned about which axis, moved or copied. */
function TransformOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const parts = useStore(studioParts);
  const setDraftField = useStore((s) => s.setDraftField);
  if (!draft || draft.type !== "transform" || !draft.transform) return null;
  const t = draft.transform;
  const choices = parts.filter((p) => p.id !== draft.id); // not the copy this feature makes
  const update = (patch: Partial<typeof t>) => setDraftField({ transform: { ...t, ...patch } });
  return (
    <fieldset className="param-group">
      <legend>Part</legend>
      <select className="full-select" aria-label="Part to move" value={t.partId ?? ""} onChange={(e) => update({ partId: e.target.value || undefined })}>
        {!t.partId && <option value="">Choose a part…</option>}
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {t.partId && !choices.some((p) => p.id === t.partId) && <option value={t.partId}>Missing part — choose another</option>}
      </select>
      <p className="dialog-hint field-hint">Or click the part in the 3D view.</p>
      <label className="check-row">
        <input type="checkbox" checked={t.copy} onChange={(e) => update({ copy: e.target.checked })} />
        Make a copy (keep the original where it is)
      </label>
      <label className="field-label" htmlFor="transform-about">
        Turn about axes
      </label>
      <select id="transform-about" className="full-select" aria-label="Turn about which point" value={t.about} onChange={(e) => update({ about: e.target.value as "origin" | "centre" })}>
        <option value="centre">through the part's centre</option>
        <option value="origin">through the origin</option>
      </select>
      <p className="dialog-hint field-hint">The turns above happen about X, then Y, then Z.</p>
    </fieldset>
  );
}

/** Import settings: which file, and (for STL) its units. */
function ImportOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (!draft || draft.type !== "import" || !draft.import) return null;
  const file = draft.import;
  return (
    <fieldset className="param-group">
      <legend>File</legend>
      <p className="import-file">
        <strong>{file.fileName}</strong>
        <span className="muted small">
          {" "}
          — {file.format === "step" ? "STEP" : "STL"}, {importedSize(file)}
        </span>
      </p>
      {file.format === "stl" && file.data.length > 1_000_000 && (
        <p className="dialog-hint field-hint">This is a detailed file, so the preview can take up to a minute to appear.</p>
      )}
      <button type="button" className="text-button" onClick={() => chooseImportFile(true)}>
        Choose a different file…
      </button>
      {file.format === "stl" && (
        <>
          <label className="field-label" htmlFor="import-units">
            Units in the file
          </label>
          <select
            id="import-units"
            className="full-select"
            value={file.units}
            onChange={(e) => setDraftField({ import: { ...file, units: e.target.value === "in" ? "in" : "mm" } })}
          >
            <option value="mm">Millimetres</option>
            <option value="in">Inches</option>
          </select>
          <p className="dialog-hint field-hint">STL files don't say what units they use. If the part looks 25 times too small, choose inches.</p>
        </>
      )}
      <p className="dialog-hint field-hint">
        The file is kept inside your design. Use Move to put the part where you want it, and Remove to cut its shape out of
        another part.
      </p>
    </fieldset>
  );
}

/** Hole settings: which sketch marks the holes, what kind, and standard sizes. */
function HoleOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const setDraftField = useStore((s) => s.setDraftField);
  const setDraftParam = useStore((s) => s.setDraftParam);
  const features = useStore(activeFeatures);
  if (!draft || draft.type !== "hole" || !draft.hole) return null;
  const h = draft.hole;
  const index = features.findIndex((f) => f.id === draft.id);
  const sketches = (mode === "edit" && index >= 0 ? features.slice(0, index) : features).filter((f) => f.type === "sketch");
  const chosen = sketches.find((f) => f.id === h.sketchRef)?.sketch?.data;
  const count = chosen ? holePositionCount(chosen) : 0;
  const update = (patch: Partial<HoleSettings>) => {
    const next = { ...h, ...patch };
    setDraftField({ hole: next });
    // Picking a screw size fills in the standard sizes.
    const sizes = standardParams(next.standard, next.fit);
    if (sizes && (patch.standard !== undefined || patch.fit !== undefined)) Object.entries(sizes).forEach(([k, v]) => setDraftParam(k, v));
  };
  const seg = <T extends string>(label: string, value: T, options: [T, string, string][], onPick: (v: T) => void) => (
    <div className={`segmented ${options.length === 2 ? "two" : "three"}`} role="radiogroup" aria-label={label}>
      {options.map(([v, text, hint]) => (
        <button type="button" key={v} role="radio" aria-checked={value === v} className={value === v ? "selected" : ""} onClick={() => onPick(v)} title={hint}>
          {text}
        </button>
      ))}
    </div>
  );

  return (
    <fieldset className="param-group">
      <legend>Where and what</legend>
      {sketches.length === 0 ? (
        <p className="dialog-error">There are no sketches yet. Cancel, then sketch on the face and place points (P) where the holes go.</p>
      ) : (
        <select className="full-select" aria-label="Sketch with the hole positions" value={h.sketchRef ?? ""} onChange={(e) => update({ sketchRef: e.target.value || undefined })}>
          {!h.sketchRef && <option value="">Choose a sketch…</option>}
          {sketches.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      )}
      {chosen && (
        <p className={count ? "dialog-hint field-hint" : "dialog-error"}>
          {count
            ? `${count} hole${count > 1 ? "s" : ""} — one at each point and circle centre in the sketch.`
            : "This sketch has no points or circles. Add points (P) where the holes go."}
        </p>
      )}
      {seg("Hole type", h.kind, [
        ["simple", "Simple", "A plain round hole"],
        ["counterbore", "Counterbore", "A wider step at the top so a cap screw's head sits below the surface"],
        ["countersink", "Countersink", "A cone at the top so a countersunk screw sits flush"],
      ], (kind) => update({ kind }))}
      <label className="field-label" htmlFor="hole-standard">
        Screw size
      </label>
      <select id="hole-standard" className="full-select" value={h.standard} onChange={(e) => update({ standard: e.target.value })}>
        <option value="Custom">Custom sizes</option>
        {SCREW_SIZES.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      {h.standard !== "Custom" &&
        seg("Fit", h.fit, [
          ["clearance", "Clearance", "The screw passes through freely"],
          ["tapped", "Tapped", "Drill size for cutting a thread — the screw screws into the part"],
        ], (fit) => update({ fit }))}
      {seg("Depth", h.end, [
        ["throughAll", "Through all", "Right through the part"],
        ["blind", "To a depth", "Stops at a set depth, with a drill point at the bottom"],
      ], (end) => update({ end }))}
      <label className="check-row">
        <input type="checkbox" checked={h.flip} onChange={(e) => update({ flip: e.target.checked })} />
        Flip direction
      </label>
      <p className="dialog-hint field-hint">{describeHole(h)}</p>
    </fieldset>
  );
}

const AXIS_LABELS: Record<Axis, string> = { x: "X (red, left–right)", y: "Y (green, front–back)", z: "Z (blue, up–down)" };

/** Mirror and pattern settings: which features to repeat, and how. */
function PatternOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const features = useStore(activeFeatures);
  const toggleDraftSource = useStore((s) => s.toggleDraftSource);
  const setDraftField = useStore((s) => s.setDraftField);
  const setDraftMirrorPlane = useStore((s) => s.setDraftMirrorPlane);
  if (!draft || !isPatternFeature(draft.type)) return null;
  const mirror = draft.type === "mirror";
  const sources = (mirror ? draft.mirror?.sources : draft.pattern?.sources) ?? [];
  const named = sources.map((id) => ({ id, name: features.find((f) => f.id === id)?.name ?? "Deleted feature" }));
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
      ) : draft.type === "curvePattern" ? (
        <fieldset className="param-group">
          <legend>Along the path</legend>
          <select className="full-select" aria-label="Path sketch" value={draft.pathRef ?? ""} onChange={(e) => setDraftField({ pathRef: e.target.value || undefined })}>
            <option value="">Choose a sketch…</option>
            {features
              .filter((f) => f.type === "sketch" && f.id !== draft.id)
              .map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
          </select>
          <label className="check-row">
            <input type="checkbox" checked={!!pattern.follow} onChange={(e) => setDraftField({ pattern: { ...pattern, follow: e.target.checked } })} />
            Turn the copies to follow the path
          </label>
          <label className="check-row">
            <input type="checkbox" checked={pattern.flip} onChange={(e) => setDraftField({ pattern: { ...pattern, flip: e.target.checked } })} />
            Start from the other end
          </label>
          <p className="dialog-hint field-hint">The copies are spaced evenly from one end of the path to the other (or all the way round a closed one). Put the original at the start of the path.</p>
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

/** Thread: pick a metric size to set the pitch, with a reminder of what size to make the rod or hole. */
function ThreadOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftParam = useStore((s) => s.setDraftParam);
  if (draft?.type !== "thread") return null;
  const pitch = Number(draft.params.pitch);
  const match = ISO_COARSE.find(([, p]) => Math.abs(p - pitch) < 1e-9);
  return (
    <fieldset className="param-group">
      <legend>Size</legend>
      <select
        className="full-select"
        aria-label="Thread size"
        value={match ? String(match[0]) : ""}
        onChange={(e) => {
          const size = ISO_COARSE.find(([d]) => String(d) === e.target.value);
          if (size) setDraftParam("pitch", String(size[1]));
        }}
      >
        <option value="">Custom pitch</option>
        {ISO_COARSE.map(([d, p]) => (
          <option key={d} value={String(d)}>
            M{d} (pitch {p} mm)
          </option>
        ))}
      </select>
      <p className="dialog-hint field-hint">
        Make a bolt&apos;s rod the full size ({match ? `${match[0]} mm for M${match[0]}` : "e.g. 8 mm for M8"}) and a nut&apos;s hole the tap-drill size (
        {match ? `${Math.round((match[0] - match[1]) * 100) / 100} mm` : "e.g. 6.75 mm for M8"}). For 3D printing, sizes of M6 and up work best.
      </p>
    </fieldset>
  );
}

/** Fillet/chamfer/shell: the edges and faces picked so far. */
function PicksField() {
  const draft = useStore((s) => s.editing?.draft);
  const parts = useStore(studioParts);
  const toggleDraftPick = useStore((s) => s.toggleDraftPick);
  const setDraftField = useStore((s) => s.setDraftField);
  const faceTypes = ["thicken", "draft", "moveFace", "replaceFace", "deleteFace", "thread", "fullRound"];
  const flange = draft?.type === "flange" || draft?.type === "hem";
  if (!draft || !(isPickFeature(draft.type) || faceTypes.includes(draft.type) || flange)) return null;
  const picks = draft.picks ?? [];
  const multiPart = new Set(picks.map((p) => p.partId)).size > 1;
  const thicken = faceTypes.includes(draft.type);
  const shell = draft.type === "shell" || thicken;
  const verb = draft.type === "fillet" ? "round" : "bevel";

  const replacing = draft.type === "replaceFace" ? draft.replaceDef ?? { target: null } : null;
  return (
    <fieldset
      className={replacing ? `param-group pick-slot${replacing.picking !== "target" ? " active" : ""}` : "param-group"}
      onClick={() => replacing && replacing.picking === "target" && setDraftField({ replaceDef: { ...replacing, picking: "faces" } })}
    >
      <legend>
        {draft.type === "hem"
          ? "Edges to fold over"
          : flange
          ? "Edges to bend off"
          : draft.type === "thread"
          ? "Round faces to thread"
          : draft.type === "fullRound"
          ? "Top faces to round over"
          : draft.type === "thicken"
          ? "Faces to thicken"
          : draft.type === "draft"
            ? "Faces to taper"
            : draft.type === "moveFace" || draft.type === "replaceFace"
              ? "Faces to move"
              : draft.type === "deleteFace" || shell
                ? "Faces to remove"
                : "Edges"}
      </legend>
      {picks.length === 0 ? (
        <p className="dialog-hint pick-hint">
          {draft.type === "hem"
            ? "Click straight edges of a sheet metal part (on its top or bottom face). Each is folded back over the sheet."
            : flange
            ? "Click straight edges of a sheet metal part (on its top or bottom face). Each gets a flange; you can also click a flange's own edges."
            : draft.type === "thread"
            ? "Click the outside of a rod (for a bolt) or the inside of a hole (for a nut)."
            : draft.type === "fullRound"
            ? "Click the flat top face of a rib or wall (a long strip with straight, parallel sides)."
            : draft.type === "thicken"
            ? "Click the flat faces to grow into a solid."
            : draft.type === "draft"
            ? "Click the side faces to taper."
            : draft.type === "moveFace"
            ? "Click the flat faces to push out (or in, with a minus distance)."
            : draft.type === "replaceFace"
            ? "Click the flat faces to move."
            : draft.type === "deleteFace"
            ? "Click the faces to remove — all the faces of a fillet, hole or boss."
            : shell
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

const FASTENER_HINTS: Record<FastenerKind, string> = {
  bolt: "X, Y, Z is the middle of the underside of the head; the shank points down. Length is under the head.",
  socketCap: "X, Y, Z is the middle of the underside of the head; the shank points down. Length is under the head.",
  buttonHead: "X, Y, Z is the middle of the underside of the head; the shank points down. Length is under the head.",
  panHead: "X, Y, Z is the middle of the underside of the head; the shank points down. Length is under the head.",
  countersunk: "X, Y, Z is the middle of the flat top of the head (flush with the surface); it points down. Length includes the head.",
  grub: "X, Y, Z is the middle of the end with the hex socket; it points down.",
  nut: "X, Y, Z is the middle of its underside.",
  washer: "X, Y, Z is the middle of its underside.",
};

/** Fastener: the kind (bolt, screws, nut, washer); the size; whether to model the thread. */
function FastenerOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (draft?.type !== "fastener" || !draft.fastener) return null;
  const f = draft.fastener;
  const update = (patch: Partial<typeof f>) => setDraftField({ fastener: { ...f, ...patch } });
  return (
    <fieldset className="param-group">
      <legend>Fastener</legend>
      <label className="field-label" htmlFor="fastener-kind">
        Kind
      </label>
      <select id="fastener-kind" className="full-select" value={f.kind} onChange={(e) => update({ kind: e.target.value as FastenerKind })}>
        {FASTENER_KINDS.map((k) => (
          <option key={k} value={k}>
            {FASTENER_LABELS[k]}
          </option>
        ))}
      </select>
      <label className="field-label" htmlFor="fastener-size">
        Size
      </label>
      <select id="fastener-size" className="full-select" value={f.size} onChange={(e) => update({ size: e.target.value })}>
        {FASTENER_SIZES.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name} ({s.name} × {s.pitch})
          </option>
        ))}
      </select>
      {f.kind !== "washer" && (
        <label className="check-row">
          <input type="checkbox" checked={f.threaded} onChange={(e) => update({ threaded: e.target.checked })} />
          Model the thread (slower; for 3D printing)
        </label>
      )}
      <p className="dialog-hint field-hint">
        {FASTENER_HINTS[f.kind]}
      </p>
    </fieldset>
  );
}

/** Delete part: the parts it removes. */
function DeletePartOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  if (draft?.type !== "deletePart") return null;
  const ids = draft.deleteParts ?? [];
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? "(missing part)";
  return (
    <fieldset className="param-group">
      <legend>Parts to delete</legend>
      {ids.length ? (
        <ul className="pick-list" aria-label="Parts to delete">
          {ids.map((id) => (
            <li key={id}>
              <span>{nameOf(id)}</span>
              <button type="button" className="icon-button small" onClick={() => setDraftField({ deleteParts: ids.filter((x) => x !== id) })} title="Keep this part" aria-label={`Keep ${nameOf(id)}`}>
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="dialog-hint pick-hint">Click the parts to delete (click one again to keep it). Features after this one can't use them.</p>
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
    { title: draft.type === "plane" ? "Placement" : draft.type === "extrude" ? "Depth" : draft.type === "revolve" ? "How far round" : draft.type === "shell" ? "Walls" : isPatternFeature(draft.type) ? "Copies" : draft.type === "transform" ? "Turn" : "Size", params: def.params.filter((p) => p.group === "size") },
    { title: draft.type === "transform" ? "Move" : "Position", params: def.params.filter((p) => p.group === "position") },
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

        {!isPickFeature(draft.type) && !isPatternFeature(draft.type) && draft.type !== "hole" && draft.type !== "transform" && draft.type !== "plane" && draft.type !== "boolean" && draft.type !== "deletePart" && draft.type !== "fastener" && draft.type !== "split" && draft.type !== "rib" && draft.type !== "draft" && draft.type !== "moveFace" && draft.type !== "replaceFace" && draft.type !== "deleteFace" && draft.type !== "sheetMetal" && draft.type !== "flange" && draft.type !== "hem" && draft.type !== "tab" && draft.type !== "fullRound" && draft.type !== "thread" && (
        <div className="segmented four" role="radiogroup" aria-label="Operation">
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

        <PlaneDefOptions />
        <BooleanOptionsField />
        <DeletePartOptions />
        <FastenerOptions />
        {draft.type === "coil" && (
          <label className="check-row">
            <input type="checkbox" checked={!!draft.flipSide} onChange={(e) => setDraftField({ flipSide: e.target.checked || undefined })} />
            Left-handed (winds the other way)
          </label>
        )}
        <SplitOptionsField />
        <RibThickenOptions />
        <DraftOptions />
        <ReplaceFaceOptions />
        <SketchSolidOptions />
        <SweepLoftOptions />
        <TextFeatureOptions />
        <HoleOptions />
        <TransformOptions />
        <ImportOptions />
        <PicksField />
        <ThreadOptions />
        <PatternOptions />

        {groups
          .map((g) => ({ ...g, params: g.params.filter((p) => visibleParamKeys(draft).has(p.key)) }))
          .filter((g) => g.params.length > 0)
          .map((g, gi) => (
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
        {buildError && draft.type === "deleteFace" && <DeleteFaceHelp error={buildError} />}
        <p className="dialog-hint">
          {busy ? "Updating preview…" : def.params.length ? "Tip: you can type maths, units and variables, e.g. 10 + 2, 1 in or wall * 2." : null}
        </p>
      </div>
    </form>
  );
}
