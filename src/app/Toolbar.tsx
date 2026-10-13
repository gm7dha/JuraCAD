import type { ReactNode } from "react";

import { useStore } from "../model/store";
import type { FeatureType } from "../model/types";
import { planeForFace, viewportApi } from "../viewport/Viewport";
import { Icons } from "./icons";
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

export function Toolbar() {
  const editing = useStore((s) => s.editing !== null);
  const canUndo = useStore((s) => s.history.past.length > 0) && !editing;
  const canRedo = useStore((s) => s.history.future.length > 0) && !editing;
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const startCreate = useStore((s) => s.startCreate);
  const editingType = useStore((s) => (s.editing?.mode === "create" ? s.editing.draft.type : null));
  const ready = useStore((s) => s.kernelStatus === "ready");
  const hasSketch = useStore((s) => s.history.present.features.some((f) => f.type === "sketch"));
  const hasPart = useStore((s) => s.parts.length > 0);
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
        {SOLIDS.map((s) => (
          <ToolButton
            key={s.type}
            label={s.label}
            icon={s.icon}
            onClick={() => startCreate(s.type)}
            disabled={!ready}
            active={editingType === s.type}
            title={`Add a ${s.label.toLowerCase()}`}
          />
        ))}
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
        <ToolButton
          label="Hole"
          icon={<Icons.Hole />}
          onClick={() => startCreate("hole")}
          disabled={!ready || !hasSketch || !hasPart}
          active={editingType === "hole"}
          title={
            hasSketch && hasPart
              ? "Hole — drill plain, counterbored, countersunk or tapped holes at a sketch's points"
              : "Make a part, then sketch points on it where the holes go"
          }
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolButton
          label="Fillet"
          icon={<Icons.Fillet />}
          onClick={() => startCreate("fillet")}
          disabled={!ready || !hasPart}
          active={editingType === "fillet"}
          title={hasPart ? "Fillet (Shift+F) — round off edges. Select edges first, or pick them after" : "Make a part first, then round its edges"}
        />
        <ToolButton
          label="Chamfer"
          icon={<Icons.Chamfer />}
          onClick={() => startCreate("chamfer")}
          disabled={!ready || !hasPart}
          active={editingType === "chamfer"}
          title={hasPart ? "Chamfer — bevel edges with a flat cut. Select edges first, or pick them after" : "Make a part first, then bevel its edges"}
        />
        <ToolButton
          label="Shell"
          icon={<Icons.Shell />}
          onClick={() => startCreate("shell")}
          disabled={!ready || !hasPart}
          active={editingType === "shell"}
          title={hasPart ? "Shell — hollow out a part. Click the face to leave open (usually the top)" : "Make a part first, then hollow it out"}
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
        <ToolButton
          label="Mirror"
          icon={<Icons.Mirror />}
          onClick={() => startCreate("mirror")}
          disabled={!ready || !hasPart}
          active={editingType === "mirror"}
          title={hasPart ? "Mirror — copy features to the other side of a plane" : "Make a part first, then mirror its features"}
        />
        <ToolButton
          label="Pattern"
          icon={<Icons.LinearPattern />}
          onClick={() => startCreate("linearPattern")}
          disabled={!ready || !hasPart}
          active={editingType === "linearPattern"}
          title={hasPart ? "Linear pattern — repeat features in a row, evenly spaced" : "Make a part first, then repeat its features"}
        />
        <ToolButton
          label="Circular"
          icon={<Icons.CircularPattern />}
          onClick={() => startCreate("circularPattern")}
          disabled={!ready || !hasPart}
          active={editingType === "circularPattern"}
          title={hasPart ? "Circular pattern — repeat features around an axis, e.g. a ring of holes" : "Make a part first, then repeat its features"}
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolButton
          label="Variables"
          icon={<Icons.Variables />}
          onClick={() => useStore.getState().openDialog("variables")}
          disabled={editing}
          title={editing ? "Finish or cancel the open feature first" : "Variables — name sizes (like wall = 2) and use them in any box"}
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
