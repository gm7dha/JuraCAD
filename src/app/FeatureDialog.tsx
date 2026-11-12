import { useEffect, useRef, useState, type ReactNode } from "react";

import { evaluate } from "../model/expr";
import { formatLength, lengthNumber, showLength, storeLength } from "../model/units";
import { describeRef } from "../geometry/topoRef";
import { AreaPicker } from "./AreaPicker";
import { LoftOptions } from "./LoftOptions";
import { areasTaken, followedSketch, pathChange, sketchesOffered, takesSeveral } from "../sketch/areaClicks";
import { FEATURE_DEFS, isPatternFeature, isPickFeature, isSketchSolid, OPERATION_LABELS, resolveParams, revolveWay, visibleParamKeys, type ParamDef } from "../model/features";
import { describeHole, SCREW_SIZES, standardParams } from "../model/holes";
import type { HoleOptions as HoleSettings } from "../model/types";
import { holePositionCount } from "../sketch/holePositions";
import { PrintedFit } from "./PrintedFit";
import { formatSkip, parseSkip, totalCopies } from "../model/patterns";
import { planeLabel } from "../sketch/planes";
import { mirrorReferenceText, patternReferenceText, setMirrorReference, setPatternDirection, type DirectionChoice } from "../model/patternRefs";
import { framesOf, planeAsSketchPlane } from "../sketch/planeFeature";
import { isMorePlaneMode } from "../sketch/planeTypes";
import { MateConnectorOptions, MorePlaneFields, PlaneKindSelect } from "./PlaneMoreOptions";
import { CurveOptions, PathChoice } from "./CurveOptions";
import { FrameOptions, GussetOptions, TrimFrameOptions } from "./FrameOptions";
import { curveKindInfo } from "../model/curves";
import type { Axis, ExtrudeEnd, Feature } from "../model/types";
import { axisLabel, defaultAxis } from "../sketch/axis";
import { activeFeatures, activeStudioId, studioParts, useLengthUnit, useStore } from "../model/store";
import { compositeProblem } from "../model/composite";
import { draftEffect } from "../model/partLinks";
import { studiosOf } from "../model/studios";
import type { Operation } from "../model/types";
import { DeleteFaceHelp } from "./DeleteFaceHelp";
import { Icons } from "./icons";
import { FASTENER_KINDS, FASTENER_LABELS, FASTENER_SIZES, type FastenerKind } from "../model/fasteners";
import { ISO_COARSE } from "../kernel/thread";
import { importedSize } from "../model/importFile";
import { SIMPLIFY_LABELS, SIMPLIFY_LEVELS } from "../model/simplify";
import { chooseImportFile } from "./fileActions";
import { TRANSFORM_MODES, transformMode } from "../model/transformMath";
import type { TransformMode } from "../model/types";
import { escapeTriadDrag, placeTriad } from "../viewport/transformTriad";

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
  const built = useStore((s) => s.builtFrames);
  if (draft?.type !== "split" || !draft.splitDef) return null;
  const sp = draft.splitDef;
  const update = (patch: Partial<typeof sp>) => setDraftField({ splitDef: { ...sp, ...patch } });
  const planes = features.filter((f) => f.type === "plane");
  const frames = framesOf(features, undefined, built);
  const surfaces = parts.filter((p) => p.surface && p.id !== sp.partId);
  const planeValue = sp.toolPartId ? `surface:${sp.toolPartId}` : sp.plane.kind === "default" ? sp.plane.name : sp.plane.planeRef ? `plane:${sp.plane.planeRef}` : "face";
  // Onshape's Split type: the part, or faces of it.
  const kindChoice = (
    <div className="segmented two" role="radiogroup" aria-label="What to split">
      {(
        [
          [undefined, "Part", "Cut the part in two"],
          ["face", "Faces", "Divide faces of a part into smaller faces (the part keeps its shape), so you can pick part of a face"],
        ] as const
      ).map(([mode, label, hint]) => (
        <button
          type="button"
          key={label}
          role="radio"
          aria-checked={sp.mode === mode}
          className={sp.mode === mode ? "selected" : ""}
          title={hint}
          onClick={() =>
            mode === "face"
              ? setDraftField({ splitDef: { ...sp, mode: "face", picking: "faces", toolPartId: undefined }, picks: draft.picks ?? [] })
              : setDraftField({ splitDef: { ...sp, mode: undefined, tool: undefined, picking: "part" }, picks: undefined, sketchRef: undefined })
          }
        >
          {label}
        </button>
      ))}
    </div>
  );
  if (sp.mode === "face") return <SplitFaceFields kindChoice={kindChoice} />;
  return (
    <>
      {kindChoice}
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
            if (v === "Top" || v === "Front" || v === "Right") update({ plane: { kind: "default", name: v }, toolPartId: undefined });
            else if (v.startsWith("plane:")) {
              const f = planes.find((x) => `plane:${x.id}` === v);
              const frame = f && frames.get(f.id);
              if (f && frame) update({ plane: planeAsSketchPlane(f, frame), toolPartId: undefined });
            } else if (v.startsWith("surface:")) update({ toolPartId: v.slice("surface:".length) });
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
          {surfaces.map((p) => (
            <option key={p.id} value={`surface:${p.id}`}>
              {p.name} (surface)
            </option>
          ))}
          {planeValue === "face" && <option value="face">{planeLabel(sp.plane)}</option>}
          {sp.toolPartId && !surfaces.some((p) => p.id === sp.toolPartId) && <option value={`surface:${sp.toolPartId}`}>(missing surface)</option>}
        </select>
        <p className="dialog-hint field-hint">Or click a plane, a flat face, or a surface in the 3D view. A surface cuts right through along its curve — Extend it first if it stops short.</p>
      </fieldset>
      <div className="segmented three" role="radiogroup" aria-label="Keep">
        {(
          [
            ["both", "Both pieces", "Keep both pieces, as two parts"],
            ["front", "Front side", sp.toolPartId ? "Keep the pieces on the side the surface faces" : "Keep the piece on the plane's front side"],
            ["back", "Back side", sp.toolPartId ? "Keep the pieces behind the surface" : "Keep the piece on the plane's back side"],
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

/** Split face: the faces to divide, and what to divide them along (a plane, a sketch's lines, or edges). */
function SplitFaceFields({ kindChoice }: { kindChoice: ReactNode }) {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const setDraftField = useStore((s) => s.setDraftField);
  const toggleDraftPick = useStore((s) => s.toggleDraftPick);
  const features = useStore(activeFeatures);
  const built = useStore((s) => s.builtFrames);
  const rollbackTo = useStore((s) => s.rollbackTo);
  if (draft?.type !== "split" || !draft.splitDef) return null;
  const sp = draft.splitDef;
  const update = (patch: Partial<typeof sp>) => setDraftField({ splitDef: { ...sp, ...patch } });
  const planes = features.filter((f) => f.type === "plane");
  const frames = framesOf(features, undefined, built);
  const sketches = sketchesOffered(features, draft.id, mode === "edit", rollbackTo);
  const tool = sp.tool ?? "plane";
  const picks = draft.picks ?? [];
  const facePicks = picks.filter((p) => p.ref.kind === "face");
  const edgePicks = picks.filter((p) => p.ref.kind === "edge");
  const value = tool === "sketch" ? `sketch:${draft.sketchRef ?? ""}` : tool === "edges" ? "edges" : sp.plane.kind === "default" ? sp.plane.name : sp.plane.planeRef ? `plane:${sp.plane.planeRef}` : "face";
  const pickList = (list: typeof picks) => (
    <ul className="pick-list" aria-label="Picked">
      {list.map((p, i) => (
        <li key={i}>
          <span>{describeRef(p.ref, p.ref.kind === "face")}</span>
          <button type="button" className="icon-button small" onClick={(e) => (e.stopPropagation(), toggleDraftPick(p))} title="Remove from this feature" aria-label="Remove">
            <Icons.Cross size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <>
      {kindChoice}
      <fieldset className={`param-group pick-slot${sp.picking !== "plane" && sp.picking !== "edges" ? " active" : ""}`} onClick={() => sp.picking !== "faces" && update({ picking: "faces" })}>
        <legend>Faces to split</legend>
        {facePicks.length ? pickList(facePicks) : <p className="dialog-hint field-hint">Click the faces to divide (all on one part).</p>}
      </fieldset>
      <fieldset className={`param-group pick-slot${sp.picking === "plane" || sp.picking === "edges" ? " active" : ""}`} onClick={() => update({ picking: tool === "edges" ? "edges" : "plane" })}>
        <legend>Split along</legend>
        <select
          className="full-select"
          aria-label="What to split the faces along"
          value={value}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "Top" || v === "Front" || v === "Right") setDraftField({ splitDef: { ...sp, tool: undefined, plane: { kind: "default", name: v }, picking: "faces" }, sketchRef: undefined, picks: facePicks });
            else if (v.startsWith("plane:")) {
              const f = planes.find((x) => `plane:${x.id}` === v);
              const frame = f && frames.get(f.id);
              if (f && frame) setDraftField({ splitDef: { ...sp, tool: undefined, plane: planeAsSketchPlane(f, frame), picking: "faces" }, sketchRef: undefined, picks: facePicks });
            } else if (v.startsWith("sketch:")) setDraftField({ splitDef: { ...sp, tool: "sketch", picking: "faces" }, sketchRef: v.slice("sketch:".length) || undefined, picks: facePicks });
            else if (v === "edges") setDraftField({ splitDef: { ...sp, tool: "edges", picking: "edges" }, sketchRef: undefined });
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
          {value === "face" && <option value="face">{planeLabel(sp.plane)}</option>}
          {sketches.map((f) => (
            <option key={f.id} value={`sketch:${f.id}`}>
              The lines of {f.name}
            </option>
          ))}
          {tool === "sketch" && !sketches.some((f) => f.id === draft.sketchRef) && <option value={`sketch:${draft.sketchRef ?? ""}`}>(choose a sketch)</option>}
          <option value="edges">Edges I click</option>
        </select>
        {tool === "edges" ? (
          edgePicks.length ? pickList(edgePicks) : <p className="dialog-hint field-hint">Click edges lying on the faces (on another part or surface touching them).</p>
        ) : (
          <p className="dialog-hint field-hint">
            {tool === "sketch" ? "The sketch's lines and curves are pushed straight through, square to the sketch, and divide the faces where they cross." : "Or click a plane or flat face in the 3D view. The faces are divided where it crosses them."}
          </p>
        )}
      </fieldset>
    </>
  );
}

/** Replace face: the face or plane the picked faces are moved onto. */
function ReplaceFaceOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  const built = useStore((s) => s.builtFrames);
  if (draft?.type !== "replaceFace") return null;
  const rd = draft.replaceDef ?? { target: null };
  const picking = rd.picking === "target";
  const planes = features.filter((f) => f.type === "plane");
  const frames = framesOf(features, undefined, built);
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

/** Draft: the neutral plane, and which way the part pulls out. Ruled surface: the plane the strips run square to. */
function DraftOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  const built = useStore((s) => s.builtFrames);
  if (draft?.type !== "draft" && draft?.type !== "ruled") return null;
  const ruled = draft.type === "ruled";
  const neutral = draft.neutral ?? { kind: "default" as const, name: "Top" as const };
  const planes = features.filter((f) => f.type === "plane");
  const frames = framesOf(features, undefined, built);
  const value = neutral.kind === "default" ? neutral.name : neutral.planeRef ? `plane:${neutral.planeRef}` : "face";
  return (
    <fieldset className="param-group">
      <legend>{ruled ? "Square to" : "Neutral plane"}</legend>
      <select
        className="full-select"
        aria-label={ruled ? "Plane the strips run square to" : "Neutral plane"}
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
      <p className="dialog-hint field-hint">
        {ruled ? "The strips run straight out, square to this plane (or click a plane in the 3D view). Tilt leans them over, across the edge." : "The faces pivot where they meet this plane (or click a plane in the 3D view). Usually the base of the part."}
      </p>
      <label className="check-row">
        <input type="checkbox" checked={!!draft.flipSide} onChange={(e) => setDraftField({ flipSide: e.target.checked })} />
        {ruled ? "Flip (sweep the other way)" : "Flip (pull out the other way)"}
      </label>
    </fieldset>
  );
}

/** Rib: which sketch; Rib and Thicken: which way. */
function RibThickenOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  if (draft?.type !== "rib" && draft?.type !== "thicken" && draft?.type !== "sheetMetal" && draft?.type !== "flange" && draft?.type !== "hem" && draft?.type !== "tab" && draft?.type !== "wrap" && draft?.type !== "bend" && draft?.type !== "jog") return null;
  const lineBend = draft.type === "bend" || draft.type === "jog";
  const convert = draft.type === "sheetMetal" && !!draft.sheetConvert;
  const at = features.findIndex((f) => f.id === draft.id);
  const sketches = (at >= 0 ? features.slice(0, at) : features).filter((f) => f.type === "sketch" && !f.suppressed);
  return (
    <>
      {draft.type === "wrap" && (
        <div className="segmented two" role="radiogroup" aria-label="Raised or engraved">
          {(["add", "remove"] as const).map((op) => (
            <button type="button" key={op} role="radio" aria-checked={draft.operation === op} className={draft.operation === op ? "selected" : ""} onClick={() => setDraftField({ operation: op })}>
              {op === "add" ? "Raised" : "Engraved"}
            </button>
          ))}
        </div>
      )}
      {draft.type === "sheetMetal" && (
        <div className="segmented two" role="radiogroup" aria-label="Make the sheet from">
          {(
            [
              [false, "From a sketch", "Draw the sheet's shape (or its side view) in a sketch"],
              [true, "From a part", "Turn a part into sheet metal: click its flat faces as the walls (Onshape's Convert)"],
            ] as const
          ).map(([c, label, hint]) => (
            <button type="button" key={label} role="radio" aria-checked={convert === c} className={convert === c ? "selected" : ""} title={hint} onClick={() => setDraftField(c ? { sheetConvert: true, picks: draft.picks ?? [], sketchRef: undefined } : { sheetConvert: undefined, picks: undefined, sketchRef: sketches[sketches.length - 1]?.id })}>
              {label}
            </button>
          ))}
        </div>
      )}
      {convert && <ConvertPicks />}
      {(draft.type === "rib" || (draft.type === "sheetMetal" && !convert) || draft.type === "tab" || draft.type === "wrap" || lineBend) && (
        <fieldset className="param-group">
          <legend>{draft.type === "rib" ? "Rib lines" : draft.type === "tab" ? "Shape of the tab" : draft.type === "wrap" ? "Shapes to wrap" : lineBend ? "Line to bend along" : "Shape of the sheet"}</legend>
          <select className="full-select" aria-label={draft.type === "rib" ? "Sketch with the rib lines" : draft.type === "tab" ? "Sketch with the tab's shape" : draft.type === "wrap" ? "Sketch with the shapes to wrap" : lineBend ? "Sketch with the bend line" : "Sketch with the sheet's shape"} value={draft.sketchRef ?? ""} onChange={(e) => setDraftField({ sketchRef: e.target.value || undefined })}>
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
              : draft.type === "wrap"
              ? "Draw the shapes flat, on any plane. Across the sketch runs round the face, up the sketch along it."
              : lineBend
              ? "Sketch one line on a flat face of the sheet (its top or bottom, or a flange's face), across the wall at right angles to the edges it crosses. It's carried on past its ends. The line is the middle of the bend in the flat pattern."
              : draft.type === "tab"
              ? "Sketch on a face of the sheet (its top or bottom, or a flange's face) — closed shapes that overlap or meet the edge become part of that wall, and of its flat pattern."
              : "A closed shape makes a flat sheet (holes in it go through). Or draw the side view as connected lines — an L, U or Z — for a bent sheet: the lines are one face of the metal and the corners become bends. Then bend flanges off its edges."}
          </p>
        </fieldset>
      )}
      {draft.type === "flange" && (
        <>
          <label className="field-label" htmlFor="flange-position">
            Where the flange goes
          </label>
          <select
            id="flange-position"
            className="full-select"
            value={draft.flangePosition ?? "edge"}
            onChange={(e) => setDraftField({ flangePosition: e.target.value === "edge" ? undefined : (e.target.value as "outside" | "inside") })}
          >
            <option value="edge">Bend off the edge (the sheet gets bigger)</option>
            <option value="outside">Outside flush with the edge (keeps the sheet's size)</option>
            <option value="inside">Inside flush with the edge</option>
          </select>
          <p className="dialog-hint field-hint">
            {draft.flangePosition === "outside"
              ? "The sheet is cut back so the flange's outside face lines up with the edge: a box drawn 100 wide stays 100 wide outside."
              : draft.flangePosition === "inside"
              ? "The sheet is cut back so the flange's inside face lines up with the edge: the space inside stays the size you drew."
              : "The bend starts at the edge, so the part grows by the bend and the sheet's thickness."}
          </p>
        </>
      )}
      {draft.type === "flange" && (
        <label className="check-row" title="Where one of these flanges meets another full-length 90° flange at a square corner, their ends are extended so one laps over the other instead of leaving a gap">
          <input type="checkbox" checked={!!draft.closeCorners} onChange={(e) => setDraftField({ closeCorners: e.target.checked || undefined })} />
          Close corners where flanges meet
        </label>
      )}
      {draft.type === "flange" && (
        <>
          <label className="field-label" htmlFor="flange-relief">
            Bend relief shape <span className="muted small">(when shortened at the ends)</span>
          </label>
          <select id="flange-relief" className="full-select" value={draft.reliefShape ?? "rectangle"} onChange={(e) => setDraftField({ reliefShape: e.target.value === "rectangle" ? undefined : (e.target.value as "round" | "tear") })}>
            <option value="rectangle">Rectangle</option>
            <option value="round">Round end</option>
            <option value="tear">Tear (a thin cut)</option>
          </select>
          <label className="field-label" htmlFor="flange-corner-relief">
            Corner relief <span className="muted small">(where two flanges meet)</span>
          </label>
          <select id="flange-corner-relief" className="full-select" value={draft.cornerRelief ?? "none"} onChange={(e) => setDraftField({ cornerRelief: e.target.value === "none" ? undefined : (e.target.value as "round" | "square") })}>
            <option value="none">None</option>
            <option value="round">Round</option>
            <option value="square">Square</option>
          </select>
        </>
      )}
      {(draft.type === "flange" || draft.type === "hem") && (
        <label className="check-row" title="Where these meet a flange or hem on the next edge round, both are trimmed along the corner's diagonal (the gap apart) instead of running into each other — so the flat pattern can be folded up. Only hems and flanges bent past 90° (leaning in) meet; at 90° or less nothing changes.">
          <input type="checkbox" checked={!!draft.mitreCorners} onChange={(e) => setDraftField({ mitreCorners: e.target.checked || undefined })} />
          Mitre corners where they meet others
        </label>
      )}
      {lineBend && (
        <label className="check-row" title="Normally the smaller piece of the wall bends and the bigger one stays where it is. A wall bent off another can only move its far side.">
          <input type="checkbox" checked={!!draft.keepOtherSide} onChange={(e) => setDraftField({ keepOtherSide: e.target.checked || undefined })} />
          Keep the other side still
        </label>
      )}
      {draft.type === "thicken" && (
        <label className="check-row" title="Half the thickness goes each side of the face or surface">
          <input type="checkbox" checked={!!draft.bothSides} onChange={(e) => setDraftField({ bothSides: e.target.checked || undefined })} />
          Both sides (half each way)
        </label>
      )}
      {draft.type !== "tab" && !(draft.type === "thicken" && draft.bothSides) && (
      <label className="check-row">
        <input type="checkbox" checked={!!draft.flipSide} onChange={(e) => setDraftField({ flipSide: e.target.checked })} />
        {draft.type === "rib"
          ? "Flip (fill the other side of the line)"
          : convert
          ? "Metal outside the faces (they become its inside)"
          : draft.type === "sheetMetal"
          ? "Flip (the metal on the other side of the sketch)"
          : draft.type === "jog"
          ? "Step down instead of up"
          : draft.type === "flange" || lineBend
          ? "Bend down instead of up"
          : draft.type === "hem"
          ? "Fold under instead of over"
          : "Flip (grow inwards)"}
      </label>
      )}
    </>
  );
}

/** Sheet metal from a part: the faces that become walls, and the edges between them left open (rips). */
function ConvertPicks() {
  const draft = useStore((s) => s.editing?.draft);
  const toggleDraftPick = useStore((s) => s.toggleDraftPick);
  const setDraftField = useStore((s) => s.setDraftField);
  const picks = draft?.picks ?? [];
  const walls = picks.filter((p) => p.ref.kind === "face");
  const rips = picks.filter((p) => p.ref.kind === "edge");
  const list = (items: typeof picks, label: string) => (
    <ul className="pick-list" aria-label={label}>
      {items.map((p, i) => (
        <li key={i}>
          <span>
            {label === "Walls" ? (i === 0 ? "Wall 1 (stays flat)" : `Wall ${i + 1}`) : `Rip ${i + 1}`}
            <span className="muted"> · {describeRef(p.ref, true)}</span>
          </span>
          <button type="button" className="icon-button small" onClick={() => toggleDraftPick(p)} title="Remove from this feature" aria-label="Remove">
            <Icons.Cross size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
  return (
    <fieldset className="param-group">
      <legend>Walls and rips</legend>
      {picks.length === 0 ? (
        <p className="dialog-hint pick-hint">
          Click the part's flat faces that become the sheet's walls — for a hollowed box, its outside faces. Where two walls meet there's a bend. Then click
          the edges between walls to leave open as rips (a box needs one at each corner), so the sheet can be unfolded flat.
        </p>
      ) : (
        <>
          {walls.length > 0 && list(walls, "Walls")}
          {rips.length > 0 && list(rips, "Rips")}
          <div className="pick-footer">
            <span className="muted small">Click a face to add a wall, an edge between two walls to add a rip, or one again to remove it. The first wall stays flat in the flat pattern.</span>
            <button type="button" className="link-button" onClick={() => setDraftField({ picks: [] })}>
              Clear
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}

/** Fill: how the patch meets the faces beside its edges. Corner break: round or cut off. Delete face: leave open. */
function SurfaceOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (draft?.type === "modifyFillet") {
    const mf = draft.modifyFillet ?? {};
    return (
      <>
        <div className="segmented two" role="radiogroup" aria-label="Change or remove">
          {(
            [
              [false, "Change radius", "Give the fillets a new radius"],
              [true, "Remove fillets", "Take the fillets off and put the sharp edges back"],
            ] as const
          ).map(([remove, label, hint]) => (
            <button
              type="button"
              key={label}
              role="radio"
              aria-checked={!!mf.remove === remove}
              className={!!mf.remove === remove ? "selected" : ""}
              title={hint}
              onClick={() => setDraftField({ modifyFillet: remove || mf.noPropagate ? { ...(remove ? { remove: true } : {}), ...(mf.noPropagate ? { noPropagate: true } : {}) } : undefined })}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="check-row" title="Also change the rounded faces of the same size that carry on smoothly from the ones you click (round a corner, along an edge)">
          <input
            type="checkbox"
            checked={!mf.noPropagate}
            onChange={(e) => setDraftField({ modifyFillet: mf.remove || !e.target.checked ? { ...(mf.remove ? { remove: true } : {}), ...(!e.target.checked ? { noPropagate: true } : {}) } : undefined })}
          />
          Propagate (follow on round the fillet)
        </label>
      </>
    );
  }
  if (draft?.type === "deleteFace") {
    return (
      <label className="check-row" title="Take the faces away without closing the gap: the part becomes a surface (a skin), to reshape and Enclose or Thicken again">
        <input type="checkbox" checked={!!draft.leaveOpen} onChange={(e) => setDraftField({ leaveOpen: e.target.checked || undefined })} />
        Leave the hole open (the part becomes a surface)
      </label>
    );
  }
  if (draft?.type === "cornerBreak") {
    return (
      <div className="segmented two" role="radiogroup" aria-label="Round or cut off">
        {(
          [
            [undefined, "Round", "Round the corners off with the radius"],
            ["chamfer", "Cut off", "Cut the corners off straight, this far back along each edge"],
          ] as const
        ).map(([style, label, hint]) => (
          <button type="button" key={label} role="radio" aria-checked={draft.breakStyle === style} className={draft.breakStyle === style ? "selected" : ""} title={hint} onClick={() => setDraftField({ breakStyle: style })}>
            {label}
          </button>
        ))}
      </div>
    );
  }
  if (draft?.type === "extendSurface") {
    const et = draft.extendTo;
    return (
      <>
        <label className="field-label" htmlFor="extend-to">
          How far
        </label>
        <select
          id="extend-to"
          className="full-select"
          value={et?.mode ?? "distance"}
          onChange={(e) => {
            const mode = e.target.value;
            setDraftField({ extendTo: mode === "face" || mode === "part" ? { mode, ...(et?.target ? { target: et.target } : {}) } : undefined });
          }}
        >
          <option value="distance">By a distance</option>
          <option value="face">Up to a face</option>
          <option value="part">Up to a part</option>
        </select>
        {et && (
          <p className={`dialog-hint field-hint${et.target ? "" : " attention"}`}>
            {et.target
              ? `${et.mode === "face" ? "Face" : "Part"} chosen — click a face of another part to change it.`
              : et.mode === "face"
              ? "Click the face to extend up to (a flat face counts as its whole plane). Click edges to choose what to extend."
              : "Click any face of the solid part to extend up to. Click edges to choose what to extend."}
          </p>
        )}
      </>
    );
  }
  if (draft?.type !== "fill") return null;
  return (
    <>
      <label className="field-label" htmlFor="fill-continuity">
        How it meets the faces beside the edges
      </label>
      <select
        id="fill-continuity"
        className="full-select"
        value={draft.continuity ?? "edges"}
        onChange={(e) => setDraftField({ continuity: e.target.value === "tangent" ? "tangent" : undefined })}
      >
        <option value="edges">Just meet the edges (may leave a crease)</option>
        <option value="tangent">Smoothly (no crease)</option>
      </select>
      <p className="dialog-hint field-hint">
        {draft.continuity
          ? "The patch bulges to carry on the surfaces round the opening without a crease — like a dome on a tube. Edges with no face beside them are just met."
          : "The patch spans the edges as simply as it can: flat if they lie in a plane."}
      </p>
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
  const built = useStore((s) => s.builtFrames);
  if (draft?.type !== "plane" || !draft.planeDef) return null;
  const pd = draft.planeDef;
  const update = (patch: Partial<typeof pd>) => setDraftField({ planeDef: { ...pd, ...patch } });
  // Earlier Plane features can be based on too.
  const at = features.findIndex((f) => f.id === draft.id);
  const earlier = (at >= 0 ? features.slice(0, at) : features).filter((f) => f.type === "plane");
  const frames = framesOf(features, undefined, built);
  const refValue = pd.ref.kind === "default" ? pd.ref.name : pd.ref.planeRef ? `plane:${pd.ref.planeRef}` : "face";
  return (
    <>
      <PlaneKindSelect pd={pd} update={update} />
      {(!isMorePlaneMode(pd.mode) || pd.mode === "point") && (
      <fieldset className="param-group">
        <legend>{pd.mode === "midplane" ? "Between" : pd.mode === "point" ? "Parallel to" : "From"}</legend>
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
        <p className="dialog-hint field-hint">{pd.mode === "point" ? "Or click a plane in the 3D view." : `Or click a plane or flat face in the 3D view${pd.mode === "midplane" ? " (first one face, then the other)" : ""}.`}</p>
      </fieldset>
      )}
      <MorePlaneFields pd={pd} update={update} />
    </>
  );
}

/** Areas of other sketches an Extrude, Revolve or Sweep also uses (clicked in the 3D view), and how to leave them out. */
function MoreAreasNote() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const features = useStore(activeFeatures);
  if (!draft || !takesSeveral(draft)) return null;
  const verb = draft.type === "revolve" ? "revolves" : draft.type === "sweep" ? "sweeps" : "extrudes";
  if (draft.moreAreas?.length) {
    return (
      <p className="dialog-hint field-hint">
        Also {verb}{" "}
        {draft.moreAreas.map((m) => `${m.areas.length} area${m.areas.length === 1 ? "" : "s"} of ${features.find((f) => f.id === m.sketch)?.name ?? "a sketch that's gone"}`).join(", ")}
        {draft.type === "revolve" ? " (round the same axis)" : draft.type === "sweep" ? " (along the same path)" : ""}. Click them in the 3D view to leave them out, or{" "}
        <button type="button" className="link-button" onClick={() => setDraftField({ moreAreas: undefined })}>
          use only {features.find((f) => f.id === draft.sketchRef)?.name ?? "this sketch"}
        </button>
        .
      </p>
    );
  }
  return draft.areas?.length ? <p className="dialog-hint field-hint">To add areas of other sketches, click them in the 3D view.</p> : null;
}

/** Extrude and revolve settings: which sketch, which way (and, for revolve, around what). */
/**
 * Thin (Onshape's): a solid wall of a set thickness along the sketch's lines and curves (open or closed),
 * instead of filling its closed shapes. Not the Surface option, which makes a skin with no inside.
 */
function ThinOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (!draft || (draft.type !== "extrude" && draft.type !== "revolve" && draft.type !== "sweep") || draft.surface) return null;
  const thin = draft.thin;
  const def = FEATURE_DEFS[draft.type];
  const param = (key: string, label?: string) => {
    const p = def.params.find((x) => x.key === key);
    return p ? <ParamField key={key} def={label ? { ...p, label } : p} value={draft.params[key] ?? p.defaultValue} autoFocus={false} /> : null;
  };
  return (
    <>
      <label className="check-row" title="A solid wall of a set thickness along the sketch's lines, arcs and circles — open or closed — instead of filling its closed shapes. A rectangle becomes a hollow tube, a line a flat wall">
        <input type="checkbox" aria-label="Thin wall" checked={!!thin} onChange={(e) => setDraftField({ thin: e.target.checked ? {} : undefined })} />
        Thin wall (a solid wall along the lines)
      </label>
      {thin && (
        <fieldset className="param-group">
          <legend>Thin wall</legend>
          <label className="check-row" title="The wall's thickness is shared equally either side of the lines">
            <input type="checkbox" checked={!!thin.midPlane} onChange={(e) => setDraftField({ thin: { ...thin, midPlane: e.target.checked || undefined } })} />
            Centred on the lines (half each side)
          </label>
          {param("thickness", thin.midPlane ? "Wall thickness" : "Wall thickness (first side)")}
          {!thin.midPlane && param("thickness2")}
          {!thin.midPlane && (
            <label className="check-row" title="Swap the two sides: the first thickness goes on the other side of the lines">
              <input type="checkbox" checked={!!thin.flip} onChange={(e) => setDraftField({ thin: { ...thin, flip: e.target.checked || undefined } })} />
              Flip wall (to the other side)
            </label>
          )}
          <p className="dialog-hint field-hint">
            With no areas picked it follows every line, arc and circle in the sketch{draft.type === "revolve" ? " (not the line it spins around)" : ""}; pick areas to make the wall only round them. Construction lines are left out. On a closed shape, or a line along the edge of one, the first side goes into the shape.
          </p>
        </fieldset>
      )}
    </>
  );
}

function SketchSolidOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const mode = useStore((s) => s.editing?.mode);
  const setDraftField = useStore((s) => s.setDraftField);
  const setDraftParam = useStore((s) => s.setDraftParam);
  const features = useStore(activeFeatures);
  const sketchLinks = useStore((s) => s.sketchLinks);
  const rollbackTo = useStore((s) => s.rollbackTo);
  if (!draft || !isSketchSolid(draft.type)) return null;
  // Only sketches above this extrude in the list (and above the rollback bar) can be used.
  const sketches = sketchesOffered(features, draft.id, mode === "edit", rollbackTo);
  const opts = draft.extrude ?? { end: "blind" as const, flip: false };
  const rev = draft.revolve ?? { axis: "vertical", flip: false };
  const chosen = sketches.find((f) => f.id === draft.sketchRef)?.sketch?.data;
  const chosenData = followedSketch(sketches.find((f) => f.id === draft.sketchRef), sketchLinks)?.data;
  // Areas other features already use (shaded grey).
  const taken = draft.sketchRef && (chosenData ?? chosen) ? areasTaken(features, draft.sketchRef, (chosenData ?? chosen)!, draft.id) : undefined;
  const lines = chosen ? chosen.curves.filter((c) => c.type === "line") : [];
  const pickSketch = (id: string | undefined) => {
    const data = sketches.find((f) => f.id === id)?.sketch?.data;
    setDraftField(
      draft.type === "revolve" && data ? { sketchRef: id, areas: undefined, moreAreas: undefined, revolve: { ...rev, axis: defaultAxis(data) } } : { sketchRef: id, areas: undefined, moreAreas: undefined },
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
      {sketches.length > 0 && !draft.sketchRef && !draft.surface && <p className="dialog-hint field-hint">Or click an area of any sketch in the 3D view.</p>}
      {chosen && !draft.surface && (
        <AreaPicker data={chosenData ?? chosen} areas={draft.areas} verb={draft.type === "revolve" ? "revolve" : "extrude"} onChange={(areas) => setDraftField({ areas })} taken={taken} />
      )}
      <MoreAreasNote />
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
          <div className="segmented three" role="radiogroup" aria-label="Which way round">
            {(
              [
                ["one", "One way", "Spin the angle one way from the sketch"],
                ["symmetric", "Symmetric", "Spin half the angle one way from the sketch and half the other way"],
                ["two", "Two ways", "Spin the angle one way from the sketch and a second angle the other way"],
              ] as const
            ).map(([way, label, hint]) => {
              const now = rev.symmetric ? "symmetric" : rev.second ? "two" : "one";
              return (
                <button
                  type="button"
                  key={way}
                  role="radio"
                  aria-checked={now === way}
                  className={now === way ? "selected" : ""}
                  title={hint}
                  onClick={() => {
                    // Two ways keeps both angles within a full turn (a new revolve's 360° becomes 180° + 90°).
                    const next = revolveWay(draft, way);
                    setDraftField({ revolve: next.revolve });
                    for (const [key, value] of Object.entries(next.params)) setDraftParam(key, value);
                  }}
                >
                  {label}
                </button>
              );
            })}
          </div>
          {!rev.symmetric && (
            <label className="check-row">
              <input type="checkbox" checked={rev.flip} onChange={(e) => setDraftField({ revolve: { ...rev, flip: e.target.checked } })} />
              {rev.second ? "Flip direction (swap which way each angle goes)" : "Flip direction (for less than a full turn)"}
            </label>
          )}
          {rev.second && !rev.symmetric && <p className="dialog-hint field-hint">The two angles together can go up to a full turn (360°).</p>}
        </>
      )}
      {draft.type === "extrude" &&
        (draft.surface ? (
          <div className="segmented two" role="radiogroup" aria-label="Direction">
            {(["blind", "symmetric"] as const).map((end) => (
              <button type="button" key={end} role="radio" aria-checked={opts.end === end} className={opts.end === end ? "selected" : ""} onClick={() => setDraftField({ extrude: { ...opts, end } })}>
                {end === "blind" ? "One way" : "Both"}
              </button>
            ))}
          </div>
        ) : (
          <>
            <label className="field-label" htmlFor="extrude-end">
              How far
            </label>
            <select
              id="extrude-end"
              className="full-select"
              value={opts.end}
              onChange={(e) => {
                const end = e.target.value as ExtrudeEnd;
                // A pick made for one kind of end doesn't fit another.
                const { upTo: _u, upToEnd: _e, ...rest } = opts;
                const keep = PICKED_ENDS[end] && PICKED_ENDS[end] === PICKED_ENDS[opts.end] && opts.upTo;
                setDraftField({ extrude: { ...rest, end, ...(keep ? { upTo: opts.upTo, ...(opts.upToEnd ? { upToEnd: opts.upToEnd } : {}) } : {}) } });
              }}
            >
              {EXTRUDE_ENDS.map(([end, label]) => (
                <option key={end} value={end}>
                  {label}
                </option>
              ))}
            </select>
            <p className={`dialog-hint field-hint${PICKED_ENDS[opts.end] && !opts.upTo ? " attention" : ""}`}>{extrudeEndHint(opts)}</p>
          </>
        ))}
      {draft.type === "extrude" && (opts.end === "blind" || opts.end === "upToNext" || opts.end === "upToPart") && (
        <label className="check-row">
          <input type="checkbox" checked={opts.flip} onChange={(e) => setDraftField({ extrude: { ...opts, flip: e.target.checked } })} />
          Flip direction
        </label>
      )}
      {draft.type === "extrude" && opts.end === "blind" && !draft.surface && (
        <label className="check-row" title="Extrude the other way from the sketch too, by its own depth (Depth the other way)">
          <input type="checkbox" checked={!!opts.second} onChange={(e) => setDraftField({ extrude: { ...opts, second: e.target.checked || undefined } })} />
          Also extrude the other way (a second depth)
        </label>
      )}
    </fieldset>
  );
}

/** The ways an extrude can end, as listed (Onshape's order). */
const EXTRUDE_ENDS: [ExtrudeEnd, string][] = [
  ["blind", "A set depth (one way)"],
  ["symmetric", "A set depth, both ways (symmetric)"],
  ["upToNext", "Up to the next face"],
  ["upToFace", "Up to a face"],
  ["upToPart", "Up to a part"],
  ["upToVertex", "Up to a corner (vertex)"],
  ["throughAll", "Through all (Remove)"],
];

/** Ends that need something clicked in the 3D view, and what. */
const PICKED_ENDS: Partial<Record<ExtrudeEnd, "face" | "edge" | "part">> = { upToFace: "face", upToVertex: "edge", upToPart: "part" };

/** What the chosen end does, and (for the ends that need one) what to click. */
function extrudeEndHint(opts: NonNullable<Feature["extrude"]>): string {
  switch (opts.end) {
    case "blind":
      return "Out from the sketch on one side, by the depth below.";
    case "symmetric":
      return "Half the depth each side of the sketch.";
    case "throughAll":
      return "Cuts right through every part, on both sides of the sketch (Remove only).";
    case "upToNext":
      return "Stops at the next face it meets. Starting inside a part with Remove, it cuts through that wall only.";
    case "upToFace":
      return opts.upTo ? "Face chosen — click another face to change it." : "Click the face to stop at — flat (at any angle) or curved.";
    case "upToPart":
      return opts.upTo ? "Part chosen — click another part to change it." : "Click the part to extrude up to. All of the sketch must meet it.";
    case "upToVertex":
      return opts.upTo ? "Corner chosen — the extrude ends level with it. Click near another corner to change it." : "Click near the end of an edge: the extrude ends level with that corner.";
  }
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
  const sketchLinks = useStore((s) => s.sketchLinks);
  const rollbackTo = useStore((s) => s.rollbackTo);
  if (!draft || (draft.type !== "sweep" && draft.type !== "loft")) return null;
  const sketches = sketchesOffered(features, draft.id, mode === "edit", rollbackTo);
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
    const profile = sketches.find((f) => f.id === draft.sketchRef)?.sketch?.data;
    return (
      <fieldset className="param-group">
        <legend>Sketches</legend>
        {select("Shape (profile)", draft.sketchRef, (v) => setDraftField({ sketchRef: v, areas: undefined, moreAreas: undefined }))}
        {profile && !draft.surface && (
          <AreaPicker
            data={followedSketch(sketches.find((f) => f.id === draft.sketchRef), sketchLinks)?.data ?? profile}
            areas={draft.areas}
            verb="sweep"
            onChange={(areas) => setDraftField({ areas })}
            taken={areasTaken(features, draft.sketchRef!, followedSketch(sketches.find((f) => f.id === draft.sketchRef), sketchLinks)?.data ?? profile, draft.id)}
          />
        )}
        {!draft.surface && <MoreAreasNote />}
        <PathChoice label="Path to follow" onSketch={(v) => setDraftField(pathChange(draft, v))} />
        <p className="dialog-hint field-hint">Draw the shape on a plane across the start of the path, e.g. a circle on Front for a path drawn on Top.</p>
        <label className="check-row" title="The shape doesn't tilt to follow the path's bends: it stays parallel to the plane it was drawn on all the way along">
          <input
            type="checkbox"
            aria-label="Keep profile orientation"
            checked={!!draft.sweepControl?.lockOrientation}
            onChange={(e) => setDraftField({ sweepControl: e.target.checked ? { lockOrientation: true } : undefined })}
          />
          Keep profile orientation (don&apos;t turn with the path)
        </label>
        {!draft.sweepControl?.lockOrientation && <p className="dialog-hint field-hint">Twist turns the shape steadily round the path as it goes — e.g. 90° for a quarter turn by the end, up to 3600° (10 turns). Use a minus amount to turn the other way. Round a closed loop, use whole turns (360°, 720°…) so the ends meet.</p>}
      </fieldset>
    );
  }
  return <LoftOptions sketches={sketches} />;
}

/** What an Extrude, Revolve, Sweep or Hole does to which parts, from its preview (those parts are lit up in the view too). */
function PartEffect() {
  const draft = useStore((s) => s.editing?.draft);
  const parts = useStore(studioParts);
  if (!draft || !["extrude", "revolve", "sweep", "hole"].includes(draft.type) || draft.surface) return null;
  const { text } = draftEffect(parts, draft);
  return text ? (
    <p className="dialog-hint field-hint part-effect" aria-live="polite">
      {text}
    </p>
  ) : null;
}

/** Move / copy settings (Onshape's Transform): which part, the way of moving, what it moves by, the triad, copy. */
function TransformOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const parts = useStore(studioParts);
  const features = useStore(activeFeatures);
  const setDraftField = useStore((s) => s.setDraftField);
  const changeDraftStep = useStore((s) => s.changeDraftStep);
  const undoDraftStep = useStore((s) => s.undoDraftStep);
  const canUndo = useStore((s) => !!s.editing && s.draftSteps?.id === s.editing.draft.id && s.draftSteps.drafts.length > 0);
  if (!draft || draft.type !== "transform" || !draft.transform) return null;
  const t = draft.transform;
  const mode = transformMode(t);
  const choices = parts.filter((p) => p.id !== draft.id); // not the copy this feature makes
  const update = (patch: Partial<typeof t>) => setDraftField({ transform: { ...t, ...patch } });
  const picking = t.picking ?? "part";
  /** Make a click in the view choose this (again: back to choosing the part). */
  const pick = (what: NonNullable<typeof t.picking>) => update({ picking: picking === what ? undefined : what });
  const flip = (label: string) => (
    <label className="check-row">
      <input type="checkbox" checked={!!t.flip} onChange={(e) => changeDraftStep({ transform: { ...t, flip: e.target.checked || undefined } })} />
      {label}
    </label>
  );
  const alongAxis = t.along && "axis" in t.along ? t.along.axis : t.along ? null : mode === "distance" ? "x" : "z";
  const placed = t.triad ? "Placed where you clicked" : t.about === "origin" ? "At the origin" : "At the part's centre";
  return (
    <fieldset className="param-group transform-options">
      <legend>Part</legend>
      <select className="full-select" aria-label="Part to move" value={t.partId ?? ""} onChange={(e) => update({ partId: e.target.value || undefined, picking: undefined })}>
        {!t.partId && <option value="">Choose a part…</option>}
        {choices.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
        {t.partId && !choices.some((p) => p.id === t.partId) && <option value={t.partId}>Missing part — choose another</option>}
      </select>
      <p className={`dialog-hint field-hint${picking === "part" ? "" : " muted"}`}>{picking === "part" ? "Or click the part in the 3D view." : <button type="button" className="text-button" onClick={() => update({ picking: undefined })}>Click a part to move instead</button>}</p>
      <label className="check-row">
        <input type="checkbox" checked={t.copy} onChange={(e) => update({ copy: e.target.checked })} />
        Make a copy (keep the original where it is)
      </label>
      <label className="field-label" htmlFor="transform-mode">
        How to move it
      </label>
      <select
        id="transform-mode"
        className="full-select"
        aria-label="How to move it"
        value={mode}
        onChange={(e) => {
          const next = e.target.value as TransformMode;
          const start = next === "line" ? ("line" as const) : next === "mates" ? ("from" as const) : undefined;
          changeDraftStep({ transform: { ...t, mode: next === "free" ? undefined : next, picking: start } });
        }}
      >
        {TRANSFORM_MODES.map((m) => (
          <option key={m.mode} value={m.mode}>
            {m.label}
          </option>
        ))}
      </select>
      <p className="dialog-hint field-hint">{TRANSFORM_MODES.find((m) => m.mode === mode)?.hint}</p>
      {(mode === "free" || mode === "xyz") && (
        <>
          <div className="transform-triad-row">
            <span className="muted small">Triad: {placed}</span>
            <button type="button" className={`text-button${picking === "triad" ? " active" : ""}`} aria-pressed={picking === "triad"} onClick={() => pick("triad")} title="Click a face, an edge, a corner or a plane to put the triad there, lined up with it. The part stays where it is.">
              Move triad
            </button>
            {t.triad && (
              <button type="button" className="text-button" onClick={() => placeTriad(draft as Parameters<typeof placeTriad>[0], null)} title="Put the triad back on the part, lined up with X, Y and Z">
                Reset
              </button>
            )}
          </div>
          {picking === "triad" && <p className="dialog-hint pick-hint attention">Click a flat face, an edge, a corner or a plane to put the triad there.</p>}
          {mode === "free" && !t.triad && (
            <>
              <label className="field-label" htmlFor="transform-about">
                Turn about axes
              </label>
              <select id="transform-about" className="full-select" aria-label="Turn about which point" value={t.about} onChange={(e) => update({ about: e.target.value as "origin" | "centre" })}>
                <option value="centre">through the part's centre</option>
                <option value="origin">through the origin</option>
              </select>
            </>
          )}
          <p className="dialog-hint field-hint">
            Drag the triad on the part: an arrow moves along it, a square moves in its plane{mode === "free" ? ", a ring turns about it" : ""} and the ball moves anywhere. It snaps to whole steps; hold Shift (or turn on No snapping) to drag freely. Dragging puts plain numbers in the boxes (in place of any sums or variables typed there).
            {mode === "free" ? " Turns happen about X, then Y, then Z." : ""}
          </p>
        </>
      )}
      {(mode === "distance" || mode === "rotate") && (
        <ReferenceBox
          label={mode === "distance" ? "Direction" : "Axis"}
          text={t.along && "dir" in t.along ? (mode === "distance" ? "The clicked edge or face" : "The clicked edge") : null}
          prompt={mode === "distance" ? "Click a straight edge or a flat face in the view" : "Click a straight edge, a round edge or a flat face in the view"}
          active={picking === "along"}
          onActivate={() => update({ picking: "along" })}
          onClear={() => changeDraftStep({ transform: { ...t, along: undefined, picking: undefined } })}
        >
          <QuickChoices label={mode === "distance" ? "Move along" : "Turn about"} options={AXIS_CHOICES} value={alongAxis} onChoose={(axis) => changeDraftStep({ transform: { ...t, along: { axis }, picking: undefined } })} />
          {!(t.along && "dir" in t.along) && (
            <p className="dialog-hint field-hint">
              {mode === "distance" ? "Along the triad's X, Y or Z" : t.triad ? "Through the triad" : t.about === "origin" ? "Through the origin" : "Through the part's centre"}.
            </p>
          )}
        </ReferenceBox>
      )}
      {mode === "rotate" && !(t.along && "dir" in t.along) && !t.triad && (
        <select className="full-select" aria-label="Turn about which point" value={t.about} onChange={(e) => changeDraftStep({ transform: { ...t, about: e.target.value as "origin" | "centre" } })}>
          <option value="centre">through the part's centre</option>
          <option value="origin">through the origin</option>
        </select>
      )}
      {mode === "distance" && flip("The other way")}
      {mode === "rotate" && flip("Turn the other way")}
      {mode === "line" && (
        <>
          <ReferenceBox
            label="Line"
            text={t.line ? `An edge ${formatLength(Math.hypot(t.line.b[0] - t.line.a[0], t.line.b[1] - t.line.a[1], t.line.b[2] - t.line.a[2]))} long` : null}
            prompt="Click a straight edge in the view (it moves from the end nearer your click to the other)"
            active={picking === "line"}
            onActivate={() => update({ picking: "line" })}
            onClear={() => changeDraftStep({ transform: { ...t, line: undefined, picking: "line" } })}
          />
          {flip("The other way")}
        </>
      )}
      {mode === "mates" && (
        <>
          <ReferenceBox
            label="From (on the part)"
            text={t.fromConnector ? `${features.find((f) => f.id === t.fromConnector)?.name ?? "A mate connector"}` : t.from ? "A spot on the part" : null}
            prompt="Click a face, an edge or a corner on the part"
            active={picking === "from"}
            onActivate={() => update({ picking: "from" })}
            onClear={() => changeDraftStep({ transform: { ...t, from: undefined, fromConnector: undefined, picking: "from" } })}
          />
          <ReferenceBox
            label="To"
            text={t.toConnector ? `${features.find((f) => f.id === t.toConnector)?.name ?? "A mate connector"}` : t.to ? "Where it goes" : null}
            prompt="Click where it goes: a face, an edge, a corner or a plane"
            active={picking === "to"}
            onActivate={() => update({ picking: "to" })}
            onClear={() => changeDraftStep({ transform: { ...t, to: undefined, toConnector: undefined, picking: "to" } })}
          />
          {flip("Flip (turn it over, so the faces meet)")}
          <p className="dialog-hint field-hint">Spots are a flat face's middle, an edge's ends or middle, or a round edge's centre — as Onshape's mate connectors. Or click a Mate connector made in this Part Studio.</p>
        </>
      )}
      {canUndo && (
        <button type="button" className="text-button" onClick={() => undoDraftStep()} title="Undo the last drag or click in this dialog (Ctrl+Z)">
          Undo last change here
        </button>
      )}
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
      <label className="check-row" title="Many downloaded files are really just triangles, so you can't pick a hole or fillet an edge. This finds the real flat and round faces in them">
        <input
          type="checkbox"
          checked={!!draft.simplify}
          onChange={(e) => setDraftField({ simplify: e.target.checked ? "normal" : undefined })}
        />
        Simplify: tidy into real faces (for editing)
      </label>
      {draft.simplify && <SimplifyLevelChoice />}
      <p className="dialog-hint field-hint">
        The file is kept inside your design. Use Move to put the part where you want it, and Remove to cut its shape out of
        another part.
      </p>
    </fieldset>
  );
}

/** How closely Simplify must match (Fine / Normal / Coarse), and what it does. */
function SimplifyLevelChoice() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (!draft) return null;
  const level = draft.simplify ?? "normal";
  return (
    <>
      <div className="segmented three" role="radiogroup" aria-label="How closely to match">
        {SIMPLIFY_LEVELS.map((v) => (
          <button
            type="button"
            key={v}
            role="radio"
            aria-checked={level === v}
            className={level === v ? "selected" : ""}
            onClick={() => setDraftField({ simplify: v })}
            title={SIMPLIFY_LABELS[v].hint}
          >
            {SIMPLIFY_LABELS[v].label}
          </button>
        ))}
      </div>
      <p className="dialog-hint field-hint">
        {SIMPLIFY_LABELS[level].hint} Flat areas become single flat faces, and holes, fillets, cones and balls become real round
        faces (so you can measure a hole's true size), fitted through the triangles' corners. Anything else stays as small flat pieces.
      </p>
    </>
  );
}

/** Simplify part: the parts it tidies, and how closely. */
function SimplifyPartOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  if (draft?.type !== "simplify") return null;
  const ids = draft.simplifyParts ?? [];
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? "(missing part)";
  return (
    <fieldset className="param-group">
      <legend>Parts to simplify</legend>
      {ids.length ? (
        <ul className="pick-list" aria-label="Parts to simplify">
          {ids.map((id) => (
            <li key={id}>
              <span>{nameOf(id)}</span>
              <button type="button" className="icon-button small" onClick={() => setDraftField({ simplifyParts: ids.filter((x) => x !== id) })} title="Leave this part as it is" aria-label={`Leave ${nameOf(id)} out`}>
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="dialog-hint pick-hint">Click the parts to simplify (click one again to leave it out).</p>
      <SimplifyLevelChoice />
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
  const rollbackTo = useStore((s) => s.rollbackTo);
  if (!draft || draft.type !== "hole" || !draft.hole) return null;
  const h = draft.hole;
  const sketches = sketchesOffered(features, draft.id, mode === "edit", rollbackTo);
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
        ["throughAll", "Through all", "Right through the part, one way from the sketch (Flip direction for the other way)"],
        ["upToNext", "Up to next", "Through the first wall the drill meets, and no further"],
        ["blind", "To a depth", "Stops at a set depth, with a drill point at the bottom"],
      ], (end) => update({ end }))}
      <label className="check-row">
        <input type="checkbox" checked={h.flip} onChange={(e) => update({ flip: e.target.checked })} />
        Flip direction
      </label>
      {h.end === "throughAll" && (
        <label className="check-row" title="For a sketch on a plane inside the part: drill out both sides of it">
          <input type="checkbox" checked={!!h.bothWays} onChange={(e) => update({ bothWays: e.target.checked || undefined })} />
          Both ways from the sketch
        </label>
      )}
      {h.fit === "tapped" && h.standard !== "Custom" && (
        <>
          <label className="check-row" title="Cut a real screw thread into the hole's wall, so a screw can go straight in — handy for 3D printing">
            <input type="checkbox" checked={!!h.modelThread} onChange={(e) => update({ modelThread: e.target.checked || undefined })} />
            Model the thread (for 3D printing)
          </label>
          {h.modelThread && (
            <p className="dialog-hint field-hint">
              Cuts a real helical {h.standard} thread (60°, standard pitch) into the wall. While this box is open the preview shows the plain hole; the
              thread is cut when you press Accept. That takes a few seconds for each new thread size and length (about a quarter of a second a turn —
              longer for deep holes); holes the same size share the work, and later edits reuse it. Threads smaller than M3 rarely print well; if a printed
              thread is tight, run a tap through it. The thread depth is measured from where the hole goes into the part.
            </p>
          )}
        </>
      )}
      <PrintedFit />
      <p className="dialog-hint field-hint">{describeHole(h)}</p>
    </fieldset>
  );
}


/** Mirror and pattern settings: which features to repeat, and how. */
function PatternOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const features = useStore(activeFeatures);
  const toggleDraftSource = useStore((s) => s.toggleDraftSource);
  const setDraftField = useStore((s) => s.setDraftField);
  const setDraftMirrorPlane = useStore((s) => s.setDraftMirrorPlane);
  const parts = useStore(studioParts);
  if (!draft || !isPatternFeature(draft.type)) return null;
  const mirror = draft.type === "mirror";
  const sources = (mirror ? draft.mirror?.sources : draft.pattern?.sources) ?? [];
  const named = sources.map((id) => ({ id, name: features.find((f) => f.id === id)?.name ?? "Deleted feature" }));
  const pattern = draft.pattern ?? { sources: [], axis: "x" as Axis, flip: false };
  const m = draft.mirror;
  // Mirror a whole part (Onshape's part mirror) instead of features.
  const partMode = mirror && m?.part !== undefined;
  // Onshape's Pattern / Mirror type: whole parts, features (as before) or faces of one part.
  const of = mirror ? (partMode ? "part" : m?.of) : draft.pattern?.of;
  // Only parts that exist by this point in the list (not ones made by later features).
  const at = features.findIndex((f) => f.id === draft.id);
  const later = new Set(at >= 0 ? features.slice(at + 1).map((f) => f.id) : []);
  const partChoices = parts.filter((p) => p.id !== draft.id && !later.has(p.id.split("~")[0]));

  return (
    <>
      {mirror && m && (
        <div className="segmented three" role="radiogroup" aria-label="What to mirror">
          {(
            [
              ["part", "Whole part", "Mirror a whole part — as a new part, or joined onto it (model half, mirror the rest)"],
              [undefined, "Features", "Mirror chosen features (a boss, a hole…) onto the same part"],
              ["face", "Faces", "Mirror a boss, pocket or hole by clicking its faces — it's added or cut on the same part"],
            ] as const
          ).map(([kind, label, hint]) => (
            <button
              type="button"
              key={label}
              role="radio"
              aria-checked={of === kind}
              className={of === kind ? "selected" : ""}
              title={hint}
              onClick={() => {
                if (kind === of) return;
                const { part: _part, join: _join, of: _of, picking: _picking, ...rest } = m;
                if (kind === "part") setDraftField({ mirror: { ...rest, part: partChoices[partChoices.length - 1]?.id ?? "", join: true }, picks: undefined });
                else if (kind === "face") setDraftField({ mirror: { ...rest, of: "face", picking: "faces" }, picks: draft.picks ?? [] });
                else setDraftField({ mirror: rest, picks: undefined });
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {!mirror && (
        <div className="segmented three" role="radiogroup" aria-label="What to repeat">
          {(
            [
              ["part", "Parts", "Repeat whole parts — each copy is a new part"],
              [undefined, "Features", "Repeat chosen features (a boss, a hole…) — each copy adds or cuts like the original"],
              ["face", "Faces", "Repeat a boss, pocket or hole by clicking its faces — the copies are added or cut on the same part"],
            ] as const
          ).map(([kind, label, hint]) => (
            <button
              type="button"
              key={label}
              role="radio"
              aria-checked={of === kind}
              className={of === kind ? "selected" : ""}
              title={hint}
              onClick={() => {
                if (kind === of) return;
                const { of: _of, parts: _parts, picking: _picking, ...rest } = pattern;
                if (kind === "part") setDraftField({ pattern: { ...rest, of: "part", parts: [], picking: "items" }, picks: undefined });
                else if (kind === "face") setDraftField({ pattern: { ...rest, of: "face", picking: "items" }, picks: draft.picks ?? [] });
                else setDraftField({ pattern: rest, picks: undefined });
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      {of === "part" && !mirror && <PatternItemsBox />}
      {of === "face" && <PatternItemsBox />}
      {mirror && m && (
        <ReferenceBox
          label="Mirror plane"
          text={mirrorReferenceText(m, features)}
          prompt="Click a flat face, a plane or a sketch line in the view"
          active={!(m.of === "face" && m.picking === "faces")}
          onActivate={() => {
            const { picking: _p, ...rest } = m;
            setDraftField({ mirror: rest });
          }}
          onClear={() => setDraftField({ mirror: setMirrorReference(m, { kind: "none" }) })}
          hint="A flat face is followed as the part changes. A sketch line mirrors across the plane through it, standing square to its sketch."
        >
          <QuickChoices
            label="Default planes"
            options={[
              ["Top", "Top", "Mirror up ↔ down, across the Top plane"],
              ["Front", "Front", "Mirror front ↔ back, across the Front plane"],
              ["Right", "Right", "Mirror left ↔ right, across the Right plane"],
            ]}
            value={!m.unset && !m.planePick && !m.line && m.plane.kind === "default" ? m.plane.name : null}
            onChoose={(name) => setDraftMirrorPlane({ kind: "default", name })}
          />
        </ReferenceBox>
      )}
      {(draft.type === "linearPattern" || draft.type === "circularPattern") && (
        <PatternDirectionBoxes />
      )}
      {partMode && m ? (
        <fieldset className="param-group">
          <legend>Part to mirror</legend>
          <select className="full-select" aria-label="Part to mirror" value={m.part ?? ""} onChange={(e) => setDraftField({ mirror: { ...m, part: e.target.value } })}>
            {!m.part && <option value="">Choose a part…</option>}
            {partChoices.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            {m.part && !partChoices.some((p) => p.id === m.part) && <option value={m.part}>Missing part — choose another</option>}
          </select>
          <label className="check-row">
            <input type="checkbox" checked={!!m.join} onChange={(e) => setDraftField({ mirror: { ...m, join: e.target.checked || undefined } })} />
            Join the mirror image onto the part (otherwise it&apos;s a new part)
          </label>
          <p className="dialog-hint field-hint">Tip: model one half up to the plane, then mirror it and join — both halves stay the same as you change it.</p>
        </fieldset>
      ) : of ? null : (
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
      )}
      {draft.type === "curvePattern" ? (
        <fieldset className="param-group">
          <legend>Along the path</legend>
          <PathChoice label="Path sketch" onSketch={(v) => setDraftField({ pathRef: v })} />
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
      ) : null}
      {!mirror && <SkipCopies />}
    </>
  );
}

/**
 * A box for something clicked in the 3D view (Onshape style): what's chosen, by
 * name, with ✕ to clear it — or, when nothing is, what to click. Clicking the
 * box makes it the one the next click in the view goes to (it's outlined).
 */
function ReferenceBox({
  label,
  text,
  prompt,
  active,
  onActivate,
  onClear,
  hint,
  children,
}: {
  label: string;
  text: string | null;
  prompt: string;
  active: boolean;
  onActivate?: () => void;
  onClear: () => void;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <fieldset
      className={`param-group pick-slot reference-box${active ? " active" : ""}`}
      aria-label={label}
      onClick={() => !active && onActivate?.()}
      onFocus={() => !active && onActivate?.()}
    >
      <legend>{label}</legend>
      {text ? (
        <div className="reference-chip">
          <span>{text}</span>
          <button
            type="button"
            className="icon-button small"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            title="Clear"
            aria-label={`Clear the ${label.toLowerCase()}`}
          >
            <Icons.Cross size={14} />
          </button>
        </div>
      ) : (
        <p className={`dialog-hint pick-hint${active ? " attention" : ""}`}>{active ? prompt : `Click here, then ${prompt.charAt(0).toLowerCase()}${prompt.slice(1)}`}</p>
      )}
      {children}
      {hint && active && <p className="dialog-hint field-hint">{hint}</p>}
    </fieldset>
  );
}

/** A row of quick choices inside a ReferenceBox (the default planes, or X, Y and Z). */
function QuickChoices<T extends string>({ label, options, value, onChoose }: { label: string; options: [T, string, string][]; value: T | null; onChoose: (v: T) => void }) {
  return (
    <div className="segmented three reference-quick" role="radiogroup" aria-label={label}>
      {options.map(([v, text, hint]) => (
        <button
          type="button"
          key={v}
          role="radio"
          aria-checked={value === v}
          className={value === v ? "selected" : ""}
          title={hint}
          onClick={(e) => {
            e.stopPropagation();
            onChoose(v);
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

const AXIS_CHOICES: [Axis, string, string][] = [
  ["x", "X", "The red axis, left–right"],
  ["y", "Y", "The green axis, front–back"],
  ["z", "Z", "The blue axis, up–down"],
];

/** Linear and circular patterns: the direction (or axis) box, and a grid's rows box. */
function PatternDirectionBoxes() {
  const draft = useStore((s) => s.editing?.draft);
  const features = useStore(activeFeatures);
  const setDraftField = useStore((s) => s.setDraftField);
  if (!draft?.pattern || (draft.type !== "linearPattern" && draft.type !== "circularPattern")) return null;
  const { picking, ...pattern } = draft.pattern;
  const circular = draft.type === "circularPattern";
  const second = !circular && picking === "along2";
  const choose = (choice: DirectionChoice, rows = false) => setDraftField({ pattern: { ...setPatternDirection(pattern, choice, rows), ...(rows ? { picking: "along2" as const } : {}) } });
  const firstAxis = !pattern.unset && !pattern.along && !pattern.line ? pattern.axis : null;
  const rowsAxis = !pattern.along2 && !pattern.line2 ? pattern.axis2 ?? (pattern.axis === "y" ? "x" : "y") : null;
  return (
    <>
      <ReferenceBox
        label={circular ? "Axis" : "Direction"}
        text={patternReferenceText(pattern, features)}
        prompt={circular ? "Click a round face, an edge or a sketch line in the view" : "Click an edge, a flat face or a sketch line in the view"}
        active={!second && picking !== "items"}
        onActivate={() => setDraftField({ pattern })}
        onClear={() => setDraftField({ pattern: setPatternDirection(pattern, { kind: "none" }) })}
        hint={
          circular
            ? "Click a hole or boss (its middle is the axis), a round or straight edge, or a sketch line. Or pick X, Y or Z — through the point under Axis goes through, below."
            : "Click a straight edge or sketch line to go along it, or a flat face to go straight out of it."
        }
      >
        <QuickChoices label={circular ? "Default axes" : "Default directions"} options={AXIS_CHOICES} value={firstAxis} onChoose={(axis) => choose({ kind: "axis", axis })} />
        <label className="check-row" onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" checked={pattern.flip} onChange={(e) => setDraftField({ pattern: { ...draft.pattern!, flip: e.target.checked } })} />
          {circular ? "Turn the other way" : "Flip direction"}
        </label>
      </ReferenceBox>
      {!circular && (
        <ReferenceBox
          label="Rows go along (for a grid)"
          text={patternReferenceText(pattern, features, true)}
          prompt="Click an edge, a flat face or a sketch line in the view"
          active={second}
          onActivate={() => setDraftField({ pattern: { ...pattern, picking: "along2" } })}
          onClear={() => setDraftField({ pattern: setPatternDirection(pattern, { kind: "none" }, true) })}
          hint="Set Rows below to more than 1 for a grid."
        >
          <QuickChoices label="Rows' default directions" options={AXIS_CHOICES} value={rowsAxis} onChoose={(axis) => choose({ kind: "axis", axis }, true)} />
          <label className="check-row" onClick={(e) => e.stopPropagation()}>
            <input type="checkbox" checked={!!pattern.flip2} onChange={(e) => setDraftField({ pattern: { ...draft.pattern!, flip2: e.target.checked || undefined } })} />
            Flip the rows&apos; direction
          </label>
        </ReferenceBox>
      )}
    </>
  );
}

/**
 * Part and face patterns, and face mirrors: the parts or faces picked, in a box
 * that takes clicks in the 3D view (and, for parts, in the Parts list) while
 * it's the active one.
 */
function PatternItemsBox() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  if (!draft) return null;
  const mirror = draft.type === "mirror";
  const of = mirror ? draft.mirror?.of : draft.pattern?.of;
  if (!of) return null;
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? "(missing part)";
  const active = mirror ? draft.mirror?.picking === "faces" : draft.pattern?.picking === "items";
  const activate = () => {
    if (mirror && draft.mirror) setDraftField({ mirror: { ...draft.mirror, picking: "faces" } });
    else if (draft.pattern) setDraftField({ pattern: { ...draft.pattern, picking: "items" } });
  };
  // Finished picking: the copies are shown (while picking, the parts are shown as they were before this feature).
  const done = active ? (
    <button
      type="button"
      className="text-button small-text"
      onClick={(e) => {
        e.stopPropagation();
        if (mirror && draft.mirror) {
          const { picking: _p, ...rest } = draft.mirror;
          setDraftField({ mirror: rest });
        } else if (draft.pattern) {
          const { picking: _p, ...rest } = draft.pattern;
          setDraftField({ pattern: rest });
        }
      }}
      title="Stop picking and show the copies"
    >
      Done — show the copies
    </button>
  ) : (
    <p className="muted small field-note">Click this box to pick more (the parts are shown as they were before this feature while you pick).</p>
  );
  if (of === "part") {
    const ids = draft.pattern?.parts ?? [];
    return (
      <fieldset className={`param-group pick-slot reference-box${active ? " active" : ""}`} aria-label="Parts to repeat" onClick={() => !active && activate()}>
        <legend>Parts to repeat</legend>
        {ids.length ? (
          <ul className="pick-list" aria-label="Parts to repeat">
            {ids.map((id) => (
              <li key={id}>
                <span>{nameOf(id)}</span>
                <button
                  type="button"
                  className="icon-button small"
                  onClick={(e) => {
                    e.stopPropagation();
                    setDraftField({ pattern: { ...draft.pattern!, parts: ids.filter((x) => x !== id) } });
                  }}
                  title="Leave this part out"
                  aria-label={`Leave out ${nameOf(id)}`}
                >
                  <Icons.Cross size={14} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <p className="dialog-hint pick-hint">Click the parts to repeat, in the 3D view or the Parts list (click one again to leave it out). Each copy is a new part.</p>
        {done}
      </fieldset>
    );
  }
  const picks = draft.picks ?? [];
  const onParts: string[] = [...new Set(picks.map((p) => p.partId))];
  return (
    <fieldset className={`param-group pick-slot reference-box${active ? " active" : ""}`} aria-label={mirror ? "Faces to mirror" : "Faces to repeat"} onClick={() => !active && activate()}>
      <legend>{mirror ? "Faces to mirror" : "Faces to repeat"}</legend>
      {picks.length ? (
        <div className="reference-chip">
          <span>
            {picks.length === 1 ? "1 face" : `${picks.length} faces`} of {onParts.map(nameOf).join(", ")}
          </span>
          <button
            type="button"
            className="icon-button small"
            onClick={(e) => {
              e.stopPropagation();
              setDraftField({ picks: [] });
            }}
            title="Clear the faces"
            aria-label="Clear the faces"
          >
            <Icons.Cross size={14} />
          </button>
        </div>
      ) : null}
      <p className="dialog-hint pick-hint">
        Click every face of the boss, pocket or hole — its sides as well as its top or floor (click one again to leave it out). A boss's copies are added to the part; a pocket's or hole's are cut. It must sit on a flat face.
      </p>
      {done}
    </fieldset>
  );
}

/** Patterns: copies to leave out, by number (the original is 1). */
function SkipCopies() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const pattern = draft?.pattern;
  const saved = formatSkip(pattern?.skip);
  const [text, setText] = useState(saved);
  // Follow the feature when it changes from elsewhere (undo, another feature opened).
  const last = useRef(saved);
  useEffect(() => {
    if (saved !== last.current) setText(saved);
    last.current = saved;
  }, [saved]);
  if (!draft || !pattern) return null;
  const { values } = resolveParams(draft);
  const total = totalCopies(values.count ?? 1, draft.type === "linearPattern" ? (values.count2 ?? 1) : 1);
  const r = parseSkip(text, total);
  return (
    <fieldset className="param-group">
      <legend>Skip copies</legend>
      <div className={`param-field${"error" in r ? " invalid" : ""}`}>
        <label htmlFor="pattern-skip">Leave out copies (numbers)</label>
        <div className="param-input">
          <input
            id="pattern-skip"
            value={text}
            placeholder="none"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => {
              setText(e.target.value);
              const next = parseSkip(e.target.value, total);
              if ("skip" in next) {
                const { skip: _s, ...rest } = pattern;
                last.current = formatSkip(next.skip);
                setDraftField({ pattern: next.skip.length ? { ...rest, skip: next.skip } : rest });
              }
            }}
          />
        </div>
        {"error" in r && <div className="param-message error">{r.error}</div>}
      </div>
      <p className="dialog-hint field-hint">
        The original is copy 1; the others count on from it{draft.type === "linearPattern" ? ", row by row in a grid" : ""}. For example 3, 5 or 2-4.
      </p>
    </fieldset>
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

/** Chamfer: the same both ways, two distances, or a distance and an angle (and which face the first one runs along). */
function ChamferOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  if (draft?.type !== "chamfer") return null;
  const kind = draft.chamferType ?? "equal";
  return (
    <>
      <div className="segmented three" role="radiogroup" aria-label="Chamfer type">
        {(
          [
            ["equal", "Equal", "The same distance along both faces (a 45° bevel)"],
            ["twoDistances", "2 distances", "A different distance along each face"],
            ["distanceAngle", "Angle", "A distance along one face, at an angle to it"],
          ] as const
        ).map(([k, label, hint]) => (
          <button
            type="button"
            key={k}
            role="radio"
            aria-checked={kind === k}
            className={kind === k ? "selected" : ""}
            title={hint}
            onClick={() => setDraftField({ chamferType: k === "equal" ? undefined : k })}
          >
            {label}
          </button>
        ))}
      </div>
      {kind !== "equal" && (
        <>
          <label className="check-row">
            <input type="checkbox" checked={!!draft.flipSide} onChange={(e) => setDraftField({ flipSide: e.target.checked || undefined })} />
            Swap sides
          </label>
          <p className="dialog-hint field-hint">
            The first distance runs along the face you clicked — or, for an edge, the face beside it that faces most upwards. Tick Swap sides to measure it along the other face.
          </p>
        </>
      )}
    </>
  );
}

/** Fillet/chamfer/shell: the edges and faces picked so far. */
function PicksField() {
  const draft = useStore((s) => s.editing?.draft);
  const parts = useStore(studioParts);
  const toggleDraftPick = useStore((s) => s.toggleDraftPick);
  const setDraftField = useStore((s) => s.setDraftField);
  const faceTypes = ["thicken", "draft", "moveFace", "replaceFace", "deleteFace", "modifyFillet", "thread", "fullRound", "wrap", "enclose", "offsetSurface"];
  const flange = draft?.type === "flange" || draft?.type === "hem" || draft?.type === "cornerBreak" || draft?.type === "fill" || draft?.type === "extendSurface" || draft?.type === "ruled";
  if (!draft || !(isPickFeature(draft.type) || faceTypes.includes(draft.type) || flange)) return null;
  const picks = draft.picks ?? [];
  const multiPart = new Set(picks.map((p) => p.partId)).size > 1;
  const thicken = faceTypes.includes(draft.type);
  const shell = draft.type === "shell" || thicken;
  const verb = draft.type === "fillet" ? "round" : "bevel";

  const replacing = draft.type === "replaceFace" ? draft.replaceDef ?? { target: null } : null;
  if (draft.type === "shell") {
    const hollow = !!draft.hollow;
    return (
      <>
        <div className="segmented two" role="radiogroup" aria-label="Open or hollow">
          {(
            [
              [false, "Open", "Remove the faces you click, leaving walls behind — like a box with its lid off"],
              [true, "Hollow", "Keep every face and hollow the inside out, sealed — like a hollow ball"],
            ] as const
          ).map(([h, label, hint]) => (
            <button type="button" key={label} role="radio" aria-checked={hollow === h} className={hollow === h ? "selected" : ""} title={hint} onClick={() => setDraftField({ hollow: h || undefined })}>
              {label}
            </button>
          ))}
        </div>
        <label className="check-row" title="The walls go round the outside, and the part itself becomes the space inside — handy for a case or cover that fits round something">
          <input type="checkbox" checked={!!draft.flipSide} onChange={(e) => setDraftField({ flipSide: e.target.checked || undefined })} />
          Walls outside (the part becomes the space inside)
        </label>
        <fieldset className="param-group">
          <legend>{hollow ? "Part to hollow" : "Faces to remove"}</legend>
          {picks.length === 0 ? (
            <p className="dialog-hint pick-hint">
              {hollow ? "The latest part is hollowed out, sealed inside. Or click any face of another part to hollow that one instead." : "Click the face (or faces) to leave open — usually the top. The rest of the part becomes walls."}
            </p>
          ) : (
            <ul className="pick-list" aria-label="Picked faces">
              {picks.map((p, i) => (
                <li key={i}>
                  <span>
                    {hollow ? parts.find((x) => x.id === p.partId)?.name ?? "part" : describeRef(p.ref, true)}
                    {!hollow && multiPart && <span className="muted"> · {parts.find((x) => x.id === p.partId)?.name ?? "part"}</span>}
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
              <span className="muted small">{hollow ? "Click a face of a different part to hollow that one." : "Click more faces to add them, or click one again to remove it."}</span>
              <button type="button" className="link-button" onClick={() => setDraftField({ picks: [] })}>
                Clear
              </button>
            </div>
          )}
        </fieldset>
      </>
    );
  }
  const wholePart = (draft.type === "fillet" || (draft.type === "chamfer" && !draft.chamferType)) && (
    <label className="check-row" title="Like clicking the whole part in Onshape: every edge of the parts you've clicked on is done">
      <input type="checkbox" checked={!!draft.allEdges} onChange={(e) => setDraftField({ allEdges: e.target.checked || undefined })} />
      Every edge of the part
    </label>
  );
  return (
    <>
    {wholePart}
    <fieldset
      className={replacing ? `param-group pick-slot${replacing.picking !== "target" ? " active" : ""}` : "param-group"}
      onClick={() => replacing && replacing.picking === "target" && setDraftField({ replaceDef: { ...replacing, picking: "faces" } })}
    >
      <legend>
        {draft.type === "hem"
          ? "Edges to fold over"
          : draft.type === "cornerBreak"
          ? "Corners"
          : draft.type === "fill"
          ? "Edges round the opening"
          : draft.type === "extendSurface"
          ? "Edges to extend"
          : draft.type === "ruled"
          ? "Edges to sweep from"
          : draft.type === "enclose"
          ? "Surfaces to close up"
          : draft.type === "offsetSurface"
          ? "Surface to offset"
          : flange
          ? "Edges to bend off"
          : draft.type === "thread"
          ? "Round faces to thread"
          : draft.type === "fullRound"
          ? "Top faces to round over"
          : draft.type === "wrap"
          ? "Round face to wrap round"
          : draft.type === "thicken"
          ? "Faces to thicken"
          : draft.type === "modifyFillet"
          ? "Rounded faces to change"
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
            : draft.type === "cornerBreak"
            ? "Click the short edge that runs through the sheet at each outside corner to round off (zoom in close). Corners next to a bend can't be done."
            : draft.type === "fill"
            ? "Click every edge round the opening (on any parts, surfaces or solids). They must join up into one ring."
            : draft.type === "extendSurface"
            ? draft.extendTo
              ? "Click the free edges of a surface. Each is carried straight on, along the surface, until it meets the face or part."
              : "Click the free edges of a surface. Each is pushed straight on, along the surface, by the distance."
            : draft.type === "ruled"
            ? "Click edges on any parts or surfaces. A straight strip is swept from each, square to the plane chosen below."
            : draft.type === "enclose"
            ? "Click a face of each surface. Together they must close up with no gaps — Fill any openings first."
            : draft.type === "offsetSurface"
            ? "Click a face of the surface to offset."
            : flange
            ? "Click straight edges of a sheet metal part (on its top or bottom face). Each gets a flange; you can also click a flange's own edges."
            : draft.type === "thread"
            ? "Click the outside of a rod (for a bolt) or the inside of a hole (for a nut)."
            : draft.type === "fullRound"
            ? "Click the flat top face of a rib or wall (a long strip with straight, parallel sides)."
            : draft.type === "wrap"
            ? "Click the side of a rod or boss (or the inside of a hole). The sketch's shapes are wrapped round it, centred where you click."
            : draft.type === "thicken"
            ? "Click the flat faces to grow into a solid."
            : draft.type === "modifyFillet"
            ? "Click the rounded faces of fillets (on any part, imported ones too)."
            : draft.type === "draft"
            ? "Click the side faces to taper."
            : draft.type === "moveFace"
            ? "Click the flat faces to push out (or in, with a minus distance)."
            : draft.type === "replaceFace"
            ? "Click the flat faces to move."
            : draft.type === "deleteFace"
            ? "Click the faces to remove — all the faces of a fillet, hole or boss."
            : shell
            ? "Click the face (or faces) to leave open — usually the top. The rest of the part becomes walls. Or click none (or every face, as on a ball) to hollow it closed inside, with no opening."
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
    </>
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

/** Derived: which part, from which other Part Studio. */
function DerivedOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore((s) => s.parts);
  const doc = useStore((s) => s.history.present);
  const here = useStore(activeStudioId);
  if (draft?.type !== "derived") return null;
  const studios = studiosOf(doc).filter((st) => st.id !== here);
  const choice = draft.derived ? `${draft.derived.studioId}|${draft.derived.partId}` : "";
  return (
    <fieldset className="param-group">
      <legend>Part</legend>
      <select
        id="derived-part"
        aria-label="Part to bring in"
        className="full-select"
        value={choice}
        onChange={(e) => {
          const [studioId, partId] = e.target.value.split("|");
          if (studioId && partId) setDraftField({ derived: { studioId, partId } });
        }}
      >
        <option value="" disabled>
          Choose a part…
        </option>
        {studios.map((st) => {
          const list = parts.filter((p) => p.studioId === st.id && !p.configuration);
          return list.length ? (
            <optgroup key={st.id} label={st.name}>
              {list.map((p) => (
                <option key={p.id} value={`${st.id}|${p.id}`}>
                  {p.name}
                </option>
              ))}
            </optgroup>
          ) : null;
        })}
      </select>
      <p className="dialog-hint field-hint">It sits where it was made. Change the original in its own Part Studio and this updates.</p>
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

/** Composite part: the parts it groups into one. */
function CompositeOptions() {
  const draft = useStore((s) => s.editing?.draft);
  const setDraftField = useStore((s) => s.setDraftField);
  const parts = useStore(studioParts);
  if (draft?.type !== "composite") return null;
  const ids = draft.compositeParts ?? [];
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? "(missing part)";
  // Said at once (the composite isn't built while its parts are being picked).
  const problem = compositeProblem(ids, parts);
  return (
    <fieldset className="param-group">
      <legend>Parts in it</legend>
      {problem && (
        <p className="dialog-error" role="alert">
          {problem}
        </p>
      )}
      {ids.length ? (
        <ul className="pick-list" aria-label="Parts in the composite part">
          {ids.map((id) => (
            <li key={id}>
              <span>{nameOf(id)}</span>
              <button type="button" className="icon-button small" onClick={() => setDraftField({ compositeParts: ids.filter((x) => x !== id) })} title="Leave this part out" aria-label={`Leave out ${nameOf(id)}`}>
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="dialog-hint pick-hint">
        Click two or more parts, in the 3D view or the Parts list (click one again to leave it out). They become one part — picked, coloured, exported and put in assemblies together — but stay separate pieces inside.
      </p>
      <p className="muted small field-note">
        Assemblies, drawings and later features that use these parts on their own will need the composite part instead (the parts aren&apos;t there separately any more).
      </p>
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
  const buildWarning = useStore((s) => (s.editing ? s.featureWarnings[s.editing.draft.id] : undefined));
  const buildNote = useStore((s) => (s.editing ? s.featureNotes[s.editing.draft.id] : undefined));
  const busy = useStore((s) => s.rebuildBusy);
  // Move / copy's triad being dragged: its boxes follow it live.
  const live = useStore((s) => s.transformLive);
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    // Sketches handle Esc themselves (it leaves the current tool, not the sketch).
    if (!editing || editing.draft.type === "sketch") return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        // Dragging Move / copy's triad: Esc takes back just the drag.
        if (escapeTriadDrag()) return;
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
  // A mirror or pattern with no plane, axis or direction chosen yet can't be accepted (its box says what to click).
  const needsRef = draft.type === "mirror" ? !!draft.mirror?.unset : (draft.type === "circularPattern" || draft.type === "linearPattern") && !!draft.pattern?.unset;
  const refHint = draft.type === "mirror" ? "Choose the mirror plane first" : draft.type === "circularPattern" ? "Choose the axis first" : "Choose the direction first";
  const groups: { title: string; params: ParamDef[] }[] = [
    { title: draft.type === "plane" ? "Placement" : draft.type === "extrude" ? "Depth" : draft.type === "revolve" ? "How far round" : draft.type === "shell" ? "Walls" : isPatternFeature(draft.type) ? "Copies" : draft.type === "transform" ? "Turn" : "Size", params: def.params.filter((p) => p.group === "size") },
    { title: draft.type === "transform" ? "Move" : draft.type === "circularPattern" ? "Axis goes through" : "Position", params: def.params.filter((p) => p.group === "position") },
  ];

  return (
    <form
      ref={ref}
      className="feature-dialog"
      aria-label={`${def.label} feature`}
      onSubmit={(e) => {
        e.preventDefault();
        if (!needsRef) commitDraft();
      }}
    >
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">{draft.type === "curve" ? curveKindInfo(draft.curve?.kind).label : def.label}</span>
        <span className="feature-dialog-actions">
          <button
            type="submit"
            className="dialog-ok"
            disabled={hasErrors || needsRef}
            title={hasErrors ? "Fix the highlighted values first" : needsRef ? refHint : "Accept (Enter)"}
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

        {!isPickFeature(draft.type) && !isPatternFeature(draft.type) && draft.type !== "hole" && draft.type !== "transform" && draft.type !== "plane" && draft.type !== "mateConnector" && draft.type !== "curve" && draft.type !== "boolean" && draft.type !== "deletePart" && draft.type !== "composite" && draft.type !== "simplify" && draft.type !== "fastener" && draft.type !== "split" && draft.type !== "rib" && draft.type !== "draft" && draft.type !== "moveFace" && draft.type !== "replaceFace" && draft.type !== "deleteFace" && draft.type !== "modifyFillet" && draft.type !== "frame" && draft.type !== "trimFrame" && draft.type !== "gusset" && draft.type !== "sheetMetal" && draft.type !== "flange" && draft.type !== "hem" && draft.type !== "cornerBreak" && draft.type !== "tab" && draft.type !== "bend" && draft.type !== "jog" && draft.type !== "fullRound" && draft.type !== "thread" && draft.type !== "wrap" && draft.type !== "fill" && draft.type !== "enclose" && draft.type !== "offsetSurface" && draft.type !== "extendSurface" && draft.type !== "ruled" && !draft.surface && (
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

        {(draft.type === "extrude" || draft.type === "revolve" || draft.type === "sweep" || draft.type === "loft") && (
          <label className="check-row" title="A thin skin with no inside, made from the sketch's lines and curves (open or closed). Thicken it, or Enclose several surfaces, to get a solid">
            <input
              type="checkbox"
              checked={!!draft.surface}
              onChange={(e) => setDraftField(e.target.checked ? { surface: true, operation: "new", thin: undefined } : { surface: undefined })}
            />
            Surface (a skin with no inside)
          </label>
        )}
        <ThinOptions />
        <PlaneDefOptions />
        <MateConnectorOptions />
        <CurveOptions />
        <BooleanOptionsField />
        <DeletePartOptions />
        <CompositeOptions />
        <FrameOptions />
        <TrimFrameOptions />
        <GussetOptions />
        <SimplifyPartOptions />
        <FastenerOptions />
        <DerivedOptions />
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
        <PartEffect />
        <TransformOptions />
        <ImportOptions />
        <ChamferOptions />
        <PicksField />
        <SurfaceOptions />
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
                def={
                  draft.type === "chamfer" && draft.chamferType && p.key === "distance"
                    ? { ...p, label: "First distance" }
                    : draft.type === "cornerBreak" && p.key === "size"
                      ? { ...p, label: draft.breakStyle === "chamfer" ? "Distance back along each edge" : "Radius" }
                      : p
                }
                value={(draft.type === "transform" ? live?.[p.key] : undefined) ?? draft.params[p.key] ?? p.defaultValue}
                autoFocus={mode === "create" && gi === 0 && pi === 0 && draft.type !== "transform"}
              />
            ))}
          </fieldset>
        ))}

        {buildError && !hasErrors && !needsRef && (
          <div className="dialog-error" role="alert">
            <Icons.Warning size={16} /> {buildError}
          </div>
        )}
        {buildError && draft.type === "deleteFace" && <DeleteFaceHelp error={buildError} />}
        {!buildError && buildWarning && (
          <div className="dialog-warning" role="status">
            <Icons.Warning size={16} /> {buildWarning}
          </div>
        )}
        {!buildError && buildNote && (
          <div className="dialog-note" role="status">
            {buildNote}
          </div>
        )}
        <p className="dialog-hint">
          {busy ? (draft.simplify ? "Tidying into real faces… (a big file can take a minute)" : "Updating preview…") : def.params.length ? "Tip: you can type maths, units and variables, e.g. 10 + 2, 1 in or wall * 2." : null}
        </p>
      </div>
    </form>
  );
}
