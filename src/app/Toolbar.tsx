import type { ReactNode } from "react";

import { activeFeatures, studioParts, useStore } from "../model/store";
import type { FeatureType } from "../model/types";
import { planeForFace, viewportApi } from "../viewport/Viewport";
import { Icons } from "./icons";
import { ToolGroupButton } from "./ToolGroupButton";
import { detectPlatform, shortcut } from "./platform";
import { startSection } from "./SectionPanel";
import { chooseImportFile } from "./fileActions";

function ToolButton({
  label,
  icon,
  onClick,
  disabled,
  active,
  title,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
}) {
  return (
    <button
      className={`tool-button${active ? " active" : ""}`}
      onClick={onClick}
      disabled={disabled}
      title={title ?? label}
      aria-label={label}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

const SOLIDS: { type: FeatureType; label: string; icon: ReactNode }[] = [
  { type: "box", label: "Box", icon: <Icons.Box /> },
  { type: "cylinder", label: "Cylinder", icon: <Icons.Cylinder /> },
  { type: "sphere", label: "Sphere", icon: <Icons.Sphere /> },
  { type: "coil", label: "Coil", icon: <Icons.Coil /> },
];


/** Start a sketch on the selected plane or flat face (or ask for one). */
export function startSketchFromSelection() {
  const s = useStore.getState();
  const faces = s.selection.filter((x) => x.kind === "face");
  if (faces.length === 1 && !s.selectedPlane) {
    const plane = planeForFace(faces[0]);
    if (plane) return s.startSketch(plane);
    s.showToast("That face is curved — sketches need a flat face or a plane.", "error");
    return s.startSketch(null);
  }
  s.startCreate("sketch");
}

/** Plane: from the selected flat face, plane or Plane feature (or Top, to change in the dialog). */
export function startPlaneFromSelection() {
  const s = useStore.getState();
  const faces = s.selection.filter((x) => x.kind === "face");
  const face = faces.length === 1 && !s.selectedPlane ? planeForFace(faces[0]) : null;
  s.startCreate("plane");
  const draft = useStore.getState().editing?.draft;
  if (face && draft?.planeDef) useStore.getState().setDraftField({ planeDef: { ...draft.planeDef, ref: face } });
}

export function Toolbar() {
  const editing = useStore((s) => s.editing !== null);
  const canUndo = useStore((s) => s.history.past.length > 0) && !editing;
  const canRedo = useStore((s) => s.history.future.length > 0) && !editing;
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const startCreate = useStore((s) => s.startCreate);
  const editingType = useStore((s) => (s.editing?.mode === "create" ? s.editing.draft.type : null));
  const ready = useStore((s) => s.kernelStatus === "ready");
  const hasSketch = useStore((s) => activeFeatures(s).some((f) => f.type === "sketch"));
  const sketchCount = useStore((s) => activeFeatures(s).filter((f) => f.type === "sketch").length);
  const hasPart = useStore((s) => studioParts(s).length > 0);
  const hasSheet = useStore((s) => studioParts(s).some((p) => !!p.flat));
  const showFlat = useStore((s) => s.showFlat);
  const partCount = useStore((s) => studioParts(s).length);
  const sectionOn = useStore((s) => s.section !== null);
  const platform = detectPlatform();

  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      <div className="tool-group">
        <ToolButton label="Undo" icon={<Icons.Undo />} onClick={undo} disabled={!canUndo} title={editing ? "Finish or cancel the open feature first" : `Undo (${shortcut(platform, "Z")})`} />
        <ToolButton label="Redo" icon={<Icons.Redo />} onClick={redo} disabled={!canRedo} title={editing ? "Finish or cancel the open feature first" : `Redo (${shortcut(platform, platform === "mac" ? "Z" : "Y", { shift: platform === "mac" })})`} />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolGroupButton
          id="solids"
          name="shape"
          items={SOLIDS.map((x) => ({
            key: x.type,
            label: x.label,
            icon: x.icon,
            title: `Add a ${x.label.toLowerCase()}`,
            onClick: () => startCreate(x.type),
            disabled: !ready,
            active: editingType === x.type,
          }))}
        />
        <ToolButton
          label="Import"
          icon={<Icons.Import />}
          onClick={() => chooseImportFile()}
          disabled={!ready || editing}
          active={editingType === "import"}
          title={editing ? "Finish or cancel the open feature first" : "Import — bring in a STEP or STL file from another program as a part"}
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolButton
          label="Sketch"
          icon={<Icons.Sketch />}
          onClick={startSketchFromSelection}
          disabled={!ready}
          title="Sketch (Shift+S) — select a plane or flat face first, or pick one after"
        />
        <ToolButton
          label="Plane"
          icon={<Icons.Plane />}
          onClick={startPlaneFromSelection}
          disabled={!ready}
          active={editingType === "plane"}
          title="Plane — a construction plane to sketch on: a distance from a plane or flat face, tilted, or halfway between two faces"
        />
        <ToolButton
          label="Extrude"
          icon={<Icons.Extrude />}
          onClick={() => startCreate("extrude")}
          disabled={!ready || !hasSketch}
          active={editingType === "extrude"}
          title={hasSketch ? "Extrude (Shift+E) — turn a sketch's closed shapes into a solid" : "Draw a sketch first, then extrude it"}
        />
        <ToolButton
          label="Revolve"
          icon={<Icons.Revolve />}
          onClick={() => startCreate("revolve")}
          disabled={!ready || !hasSketch}
          active={editingType === "revolve"}
          title={hasSketch ? "Revolve — spin a sketch's closed shapes around a line, for round parts" : "Draw a sketch first, then revolve it"}
        />
        <ToolGroupButton
          id="sweeps"
          name="sweep"
          items={[
            {
              key: "sweep",
              label: "Sweep",
              icon: <Icons.Sweep />,
              onClick: () => startCreate("sweep"),
              disabled: !ready || sketchCount < 2,
              active: editingType === "sweep",
              title: sketchCount >= 2 ? "Sweep — carry a sketch's shape along a path drawn in another sketch (pipes, handles, rails)" : "Draw two sketches first: the shape, and the path for it to follow",
            },
            {
              key: "loft",
              label: "Loft",
              icon: <Icons.Loft />,
              onClick: () => startCreate("loft"),
              disabled: !ready || sketchCount < 2,
              active: editingType === "loft",
              title: sketchCount >= 2 ? "Loft — a smooth solid joining shapes on different sketches" : "Draw shapes on two or more sketches (on different planes) first",
            },
          ]}
        />
        <ToolButton
          label="Text"
          icon={<Icons.Text />}
          onClick={() => startCreate("text")}
          disabled={!ready}
          active={editingType === "text"}
          title="Text — raised or engraved lettering on a plane or flat face"
        />
        <ToolGroupButton
          id="thicken"
          name="wall"
          items={[
            {
              key: "thicken",
              label: "Thicken",
              icon: <Icons.Thicken />,
              onClick: () => startCreate("thicken"),
              disabled: !ready || !hasPart,
              active: editingType === "thicken",
              title: hasPart ? "Thicken — grow flat faces into a solid of a set thickness" : "Make a part first",
            },
            {
              key: "rib",
              label: "Rib",
              icon: <Icons.Rib />,
              onClick: () => startCreate("rib"),
              disabled: !ready || !hasPart || !hasSketch,
              active: editingType === "rib",
              title: hasPart && hasSketch ? "Rib — a thin strengthening wall along a sketch's lines, filling the space up to the part" : "Make a part, then sketch the rib's line(s)",
            },
          ]}
        />
        <ToolGroupButton
          id="sheet-metal"
          name="sheet metal"
          items={[
            {
              key: "sheetMetal",
              label: "Sheet metal",
              icon: <Icons.SheetMetal />,
              onClick: () => startCreate("sheetMetal"),
              disabled: !ready || !hasSketch,
              active: editingType === "sheetMetal",
              title: hasSketch ? "Sheet metal — a flat sheet of one thickness from a closed sketch, ready to bend flanges off" : "Sketch the sheet's shape first (a closed outline)",
            },
            {
              key: "flange",
              label: "Flange",
              icon: <Icons.Flange />,
              onClick: () => startCreate("flange"),
              disabled: !ready || !hasPart,
              active: editingType === "flange",
              title: hasPart ? "Flange — bend a wall up (or down) off straight edges of a sheet metal part" : "Make a sheet metal part first",
            },
            {
              key: "tab",
              label: "Tab",
              icon: <Icons.Tab />,
              onClick: () => startCreate("tab"),
              disabled: !ready || !hasSheet || !hasSketch,
              active: editingType === "tab",
              title: hasSheet ? "Tab — join flat shapes onto a sheet metal wall: sketch them on its face, overlapping its edge" : "Make a sheet metal part first",
            },
            {
              key: "hem",
              label: "Hem",
              icon: <Icons.Hem />,
              onClick: () => startCreate("hem"),
              disabled: !ready || !hasSheet,
              active: editingType === "hem",
              title: hasSheet ? "Hem — fold straight edges of a sheet metal part back on themselves, for a safe, stiff edge" : "Make a sheet metal part first",
            },
            {
              key: "unfold",
              label: "Unfold",
              icon: <Icons.Unfold />,
              onClick: () => useStore.getState().setShowFlat(!showFlat),
              disabled: !hasSheet,
              active: showFlat,
              title: hasSheet ? "Unfold — show the sheet metal parts laid out flat in the 3D view (click again to fold them back up)" : "Make a sheet metal part first",
            },
            {
              key: "flatPattern",
              label: "Flat pattern",
              icon: <Icons.FlatPattern />,
              onClick: () => useStore.getState().openDialog("flatPattern"),
              disabled: !hasSheet,
              title: hasSheet ? "Flat pattern — see the sheet metal part laid out flat, and save it as DXF for laser cutting" : "Make a sheet metal part first",
            },
          ]}
        />
        <ToolGroupButton
          id="parts"
          name="part"
          items={[
            {
              key: "boolean",
              label: "Boolean",
              icon: <Icons.Boolean />,
              onClick: () => startCreate("boolean"),
              disabled: !ready || partCount < 2,
              active: editingType === "boolean",
              title: partCount >= 2 ? "Boolean — join parts into one, cut parts with others, or keep just where they overlap" : "Make at least two parts first",
            },
            {
              key: "split",
              label: "Split",
              icon: <Icons.Split />,
              onClick: () => startCreate("split"),
              disabled: !ready || !hasPart,
              active: editingType === "split",
              title: hasPart ? "Split — cut a part in two along a plane or flat face" : "Make a part first",
            },
            {
              key: "deletePart",
              label: "Delete part",
              icon: <Icons.Trash />,
              onClick: () => startCreate("deletePart"),
              disabled: !ready || partCount < 1,
              active: editingType === "deletePart",
              title: partCount ? "Delete part — remove whole parts from here on (select them in the Parts list first, or click them)" : "Make a part first",
            },
          ]}
        />
        <ToolButton
          label="Fastener"
          icon={<Icons.Bolt />}
          onClick={() => startCreate("fastener")}
          disabled={!ready}
          active={editingType === "fastener"}
          title="Fastener — a standard hex bolt, nut or washer (M3–M12) as a new part, optionally with its thread"
        />
        <ToolGroupButton
          id="holes"
          name="hole"
          items={[
            {
              key: "hole",
              label: "Hole",
              icon: <Icons.Hole />,
              onClick: () => startCreate("hole"),
              disabled: !ready || !hasSketch || !hasPart,
              active: editingType === "hole",
              title: hasSketch && hasPart
              ? "Hole — drill plain, counterbored, countersunk or tapped holes at a sketch's points"
              : "Make a part, then sketch points on it where the holes go",
            },
            {
              key: "thread",
              label: "Thread",
              icon: <Icons.Thread />,
              onClick: () => startCreate("thread"),
              disabled: !ready || !hasPart,
              active: editingType === "thread",
              title: hasPart ? "Thread — cut a screw thread round a rod (bolt) or inside a hole (nut)" : "Make a part first",
            },
          ]}
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolGroupButton
          id="edges"
          name="edge"
          items={[
            {
              key: "fillet",
              label: "Fillet",
              icon: <Icons.Fillet />,
              onClick: () => startCreate("fillet"),
              disabled: !ready || !hasPart,
              active: editingType === "fillet",
              title: hasPart ? "Fillet (Shift+F) — round off edges. Select edges first, or pick them after" : "Make a part first, then round its edges",
            },
            {
              key: "chamfer",
              label: "Chamfer",
              icon: <Icons.Chamfer />,
              onClick: () => startCreate("chamfer"),
              disabled: !ready || !hasPart,
              active: editingType === "chamfer",
              title: hasPart ? "Chamfer — bevel edges with a flat cut. Select edges first, or pick them after" : "Make a part first, then bevel its edges",
            },
            {
              key: "fullRound",
              label: "Full round",
              icon: <Icons.FullRound />,
              onClick: () => startCreate("fullRound"),
              disabled: !ready || !hasPart,
              active: editingType === "fullRound",
              title: hasPart ? "Full round — round the top of a rib or wall right over, from side to side: click its flat top face" : "Make a part first",
            },
          ]}
        />
        <ToolButton
          label="Shell"
          icon={<Icons.Shell />}
          onClick={() => startCreate("shell")}
          disabled={!ready || !hasPart}
          active={editingType === "shell"}
          title={hasPart ? "Shell — hollow out a part. Click the face to leave open (usually the top)" : "Make a part first, then hollow it out"}
        />
        <ToolGroupButton
          id="faces"
          name="face"
          items={[
            {
              key: "moveFace",
              label: "Move face",
              icon: <Icons.MoveFace />,
              onClick: () => startCreate("moveFace"),
              disabled: !ready || !hasPart,
              active: editingType === "moveFace",
              title: hasPart ? "Move face — push flat faces out or in by a distance" : "Make a part first",
            },
            {
              key: "replaceFace",
              label: "Replace face",
              icon: <Icons.ReplaceFace />,
              onClick: () => startCreate("replaceFace"),
              disabled: !ready || !hasPart,
              active: editingType === "replaceFace",
              title: hasPart ? "Replace face — move flat faces onto another face or plane parallel to them (to line parts up)" : "Make a part first",
            },
            {
              key: "deleteFace",
              label: "Delete face",
              icon: <Icons.DeleteFace />,
              onClick: () => startCreate("deleteFace"),
              disabled: !ready || !hasPart,
              active: editingType === "deleteFace",
              title: hasPart ? "Delete face — remove fillets, chamfers, holes or bosses and close the gap" : "Make a part first",
            },
            {
              key: "draft",
              label: "Draft",
              icon: <Icons.Draft />,
              onClick: () => startCreate("draft"),
              disabled: !ready || !hasPart,
              active: editingType === "draft",
              title: hasPart ? "Draft — taper faces so the part pulls out of a mould" : "Make a part first",
            },
          ]}
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolButton
          label="Move"
          icon={<Icons.Move />}
          onClick={() => startCreate("transform")}
          disabled={!ready || !hasPart}
          active={editingType === "transform"}
          title={hasPart ? "Move / copy — move or turn a part, or a copy of it. Select the part first, or pick it after" : "Make a part first, then move it"}
        />
        <ToolGroupButton
          id="patterns"
          name="pattern"
          items={[
            {
              key: "linearPattern",
              label: "Pattern",
              icon: <Icons.LinearPattern />,
              onClick: () => startCreate("linearPattern"),
              disabled: !ready || !hasPart,
              active: editingType === "linearPattern",
              title: hasPart ? "Linear pattern — repeat features in a row, evenly spaced" : "Make a part first, then repeat its features",
            },
            {
              key: "circularPattern",
              label: "Circular",
              icon: <Icons.CircularPattern />,
              onClick: () => startCreate("circularPattern"),
              disabled: !ready || !hasPart,
              active: editingType === "circularPattern",
              title: hasPart ? "Circular pattern — repeat features around an axis, e.g. a ring of holes" : "Make a part first, then repeat its features",
            },
            {
              key: "curvePattern",
              label: "Curve",
              icon: <Icons.CurvePattern />,
              onClick: () => startCreate("curvePattern"),
              disabled: !ready || !hasPart || !hasSketch,
              active: editingType === "curvePattern",
              title: hasPart && hasSketch ? "Curve pattern — repeat features along a path drawn in a sketch" : "Make a part and sketch a path first",
            },
            {
              key: "mirror",
              label: "Mirror",
              icon: <Icons.Mirror />,
              onClick: () => startCreate("mirror"),
              disabled: !ready || !hasPart,
              active: editingType === "mirror",
              title: hasPart ? "Mirror — copy features to the other side of a plane" : "Make a part first, then mirror its features",
            },
          ]}
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolGroupButton
          id="settings-tables"
          name="table"
          items={[
            {
              key: "variables",
              label: "Variables",
              icon: <Icons.Variables />,
              onClick: () => useStore.getState().openDialog("variables"),
              disabled: editing,
              active: false,
              title: editing ? "Finish or cancel the open feature first" : "Variables — name sizes (like wall = 2) and use them in any box",
            },
            {
              key: "configurations",
              label: "Configurations",
              icon: <Icons.Configurations />,
              onClick: () => useStore.getState().openDialog("configurations"),
              disabled: editing,
              active: false,
              title: editing ? "Finish or cancel the open feature first" : "Configurations — keep different versions of the design (e.g. Small and Large) and switch between them",
            },
          ]}
        />
      </div>
      <div className="toolbar-spacer" />
      <div className="tool-group">
        <ToolButton
          label="Section"
          icon={<Icons.Section />}
          onClick={() => (useStore.getState().section ? useStore.getState().setSection(null) : startSection())}
          disabled={!hasPart}
          active={sectionOn}
          title="Section view — slice the view open to see inside (doesn't change the part)"
        />
      </div>
      <div className="tool-group">
        <ToolButton label="Fit" icon={<Icons.Fit />} onClick={() => viewportApi.current?.fit()} title="Zoom to fit (F)" />
      </div>
    </div>
  );
}
