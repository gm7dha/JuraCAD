import type { ReactNode } from "react";

import { useStore, type SketchTool } from "../model/store";
import { RELATION_HINTS, RELATION_LABELS, type RelationTool } from "../sketch/ops";
import { RELATION_SYMBOLS } from "../sketch/layout";
import { Icons } from "./icons";
import { detectPlatform, shortcut } from "./platform";
import { applySketchRelation, deleteSketchSelection, setSketchTool, toggleSketchConstruction } from "./sketchActions";

const TOOLS: { tool: SketchTool; label: string; key: string; icon: ReactNode; hint: string }[] = [
  { tool: "select", label: "Select", key: "Esc", icon: <Icons.Select />, hint: "Click to select, drag to move" },
  { tool: "line", label: "Line", key: "L", icon: <Icons.Line />, hint: "Click to start, keep clicking to chain lines, Esc to stop" },
  { tool: "rectangle", label: "Rectangle", key: "R", icon: <Icons.Rectangle />, hint: "Click two opposite corners" },
  { tool: "circle", label: "Circle", key: "C", icon: <Icons.Circle />, hint: "Click the centre, then a point on the edge" },
  { tool: "arc", label: "Arc", key: "A", icon: <Icons.Arc />, hint: "Click both ends, then a point the arc passes through" },
  { tool: "slot", label: "Slot", key: "S", icon: <Icons.Slot />, hint: "Click both end centres, then move out to set the width" },
  { tool: "polygon", label: "Polygon", key: "G", icon: <Icons.Polygon />, hint: "Click the centre, then a corner (set the number of sides in the sketch panel)" },
  { tool: "point", label: "Point", key: "P", icon: <Icons.Point />, hint: "Click to place a point" },
  { tool: "dimension", label: "Dimension", key: "D", icon: <Icons.Dimension />, hint: "Click a line or circle (or two things), then where the value goes" },
  { tool: "sketchFillet", label: "Round", key: "", icon: <Icons.CornerRound />, hint: "Click a corner where two lines meet to round it (set the radius in the sketch panel)" },
  { tool: "trim", label: "Trim", key: "T", icon: <Icons.Trim />, hint: "Click a piece of a line, arc or circle to cut it away up to where other lines cross it" },
  { tool: "offset", label: "Offset", key: "O", icon: <Icons.Offset />, hint: "Click a shape's edge on the side to offset towards — a copy that far away (set the distance in the sketch panel)" },
  { tool: "mirror", label: "Mirror", key: "M", icon: <Icons.Mirror />, hint: "Click the line to mirror about, then the shapes to copy across (or select the shapes first). The copies follow the originals" },
  { tool: "useEdge", label: "Use", key: "U", icon: <Icons.UseEdge />, hint: "Click edges of a part to copy them into the sketch (they stay fixed where they are)" },
];

const RELATIONS: RelationTool[] = [
  "coincident",
  "horizontal",
  "vertical",
  "parallel",
  "perpendicular",
  "equal",
  "tangent",
  "concentric",
  "midpoint",
  "symmetric",
  "fix",
];

/** Replaces the main toolbar while a sketch is open, like Onshape's sketch toolbar. */
export function SketchToolbar() {
  const tool = useStore((s) => s.sketch?.tool ?? "select");
  const construction = useStore((s) => s.sketch?.construction ?? false);
  const canUndo = useStore((s) => (s.sketch?.past.length ?? 0) > 0);
  const canRedo = useStore((s) => (s.sketch?.future.length ?? 0) > 0);
  const hasSelection = useStore((s) => (s.sketch?.selection.length ?? 0) > 0);
  const hasPlane = useStore((s) => !!s.editing?.draft.sketch?.plane);
  const sketchUndo = useStore((s) => s.sketchUndo);
  const sketchRedo = useStore((s) => s.sketchRedo);
  const platform = detectPlatform();

  return (
    <div className="toolbar sketch-toolbar" role="toolbar" aria-label="Sketch tools">
      <div className="tool-group">
        <ToolBtn label="Undo" icon={<Icons.Undo />} onClick={sketchUndo} disabled={!canUndo} title={`Undo in this sketch (${shortcut(platform, "Z")})`} />
        <ToolBtn label="Redo" icon={<Icons.Redo />} onClick={sketchRedo} disabled={!canRedo} title={`Redo in this sketch (${shortcut(platform, platform === "mac" ? "Z" : "Y", { shift: platform === "mac" })})`} />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        {TOOLS.map((t) => (
          <ToolBtn
            key={t.tool}
            label={t.label}
            icon={t.icon}
            active={tool === t.tool}
            disabled={!hasPlane}
            onClick={() => setSketchTool(t.tool)}
            title={`${t.label}${t.key ? ` (${t.key})` : ""} — ${t.hint}`}
          />
        ))}
        <ToolBtn
          label="Construction"
          icon={<Icons.Construction />}
          active={construction}
          disabled={!hasPlane}
          onClick={toggleSketchConstruction}
          title="Construction (Q) — dashed helper geometry that isn't extruded. Toggles the selection, or new shapes if nothing is selected."
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group relations">
        {RELATIONS.map((r) => (
          <button
            key={r}
            className="relation-button"
            disabled={!hasPlane}
            onClick={() => applySketchRelation(r)}
            title={`${RELATION_LABELS[r]} — ${RELATION_HINTS[r]}`}
            aria-label={RELATION_LABELS[r]}
          >
            <span className="relation-symbol">{RELATION_SYMBOLS[r]}</span>
            <span>{RELATION_LABELS[r]}</span>
          </button>
        ))}
      </div>
      <div className="toolbar-spacer" />
      <div className="tool-group">
        <ToolBtn label="Delete" icon={<Icons.Trash />} onClick={deleteSketchSelection} disabled={!hasSelection} title="Delete the selection (Delete)" />
      </div>
    </div>
  );
}

function ToolBtn({
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
    <button className={`tool-button${active ? " active" : ""}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-label={label} aria-pressed={active}>
      {icon}
      <span>{label}</span>
    </button>
  );
}
