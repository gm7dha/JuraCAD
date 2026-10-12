import type { ReactNode } from "react";

import { useStore } from "../model/store";
import type { FeatureType } from "../model/types";
import { planeForFace, viewportApi } from "../viewport/Viewport";
import { Icons } from "./icons";

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

/** Tools that arrive in later phases, shown greyed out so the roadmap is visible. */
const COMING: { label: string; icon: ReactNode; phase: string }[] = [
  { label: "Revolve", icon: <Icons.Revolve />, phase: "Phase 3" },
  { label: "Shell", icon: <Icons.Shell />, phase: "Phase 3" },
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
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const mod = isMac ? "⌘" : "Ctrl+";

  return (
    <div className="toolbar" role="toolbar" aria-label="Tools">
      <div className="tool-group">
        <ToolButton label="Undo" icon={<Icons.Undo />} onClick={undo} disabled={!canUndo} title={editing ? "Finish or cancel the open feature first" : `Undo (${mod}Z)`} />
        <ToolButton label="Redo" icon={<Icons.Redo />} onClick={redo} disabled={!canRedo} title={editing ? "Finish or cancel the open feature first" : `Redo (${mod}Y)`} />
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
      </div>
      <div className="tool-divider" />
      <div className="tool-group coming">
        {COMING.map((c) => (
          <ToolButton key={c.label} label={c.label} icon={c.icon} disabled title={`${c.label} — coming in ${c.phase}`} />
        ))}
      </div>
      <div className="toolbar-spacer" />
      <div className="tool-group">
        <ToolButton label="Fit" icon={<Icons.Fit />} onClick={() => viewportApi.current?.fit()} title="Zoom to fit (F)" />
      </div>
    </div>
  );
}
