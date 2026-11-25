import type { ReactNode } from "react";

import { useStore, type SketchTool } from "../model/store";
import { RELATION_HINTS, RELATION_LABELS, type RelationTool } from "../sketch/ops";
import { RELATION_SYMBOLS } from "../sketch/layout";
import { Icons } from "./icons";
import { ToolGroupButton } from "./ToolGroupButton";
import { EditToolIcons } from "./SketchEditOptions";
import { MAIN_RELATIONS, MORE_RELATIONS, SKETCH_FAMILIES as FAMILIES, SKETCH_INSERT_TOOLS } from "./toolbarLayout";
import { detectPlatform, shortcut } from "./platform";
import { copySketchSelection, pasteIntoSketch } from "./sketchClipboardApp";
import { finishSketchInto } from "./sketchMenuActions";
import { relationKey } from "../sketch/sketchView";
import { setSketchView, useSketchView } from "./sketchViewState";
import { toggleSketchConstructionShown } from "./sketchMenuActions";
import { applySketchRelation, deleteSketchSelection, insertImageFile, pickFile, setSketchTool, toggleSketchConstruction } from "./sketchActions";

const TOOLS: { tool: SketchTool; label: string; key: string; icon: ReactNode; hint: string }[] = [
  { tool: "select", label: "Select", key: "Esc", icon: <Icons.Select />, hint: "Click to select, drag to move" },
  { tool: "line", label: "Line", key: "L", icon: <Icons.Line />, hint: "Click to start, keep clicking to chain lines (or drag out one line), Esc to stop. Shift+A — or back onto the last end and away — carries on with an arc" },
  { tool: "midpointLine", label: "Midpoint line", key: "", icon: <Icons.MidpointLine />, hint: "Click the middle of the line, then one end — the other end goes as far the other way" },
  { tool: "rectangle", label: "Rectangle", key: "R", icon: <Icons.Rectangle />, hint: "Click two opposite corners" },
  { tool: "centreRectangle", label: "Centre rect", key: "", icon: <Icons.CentreRectangle />, hint: "Click the centre, then a corner" },
  { tool: "alignedRectangle", label: "Aligned rect", key: "", icon: <Icons.AlignedRectangle />, hint: "Click two corners along one side (at any angle), then move out to set the width" },
  { tool: "circle", label: "Circle", key: "C", icon: <Icons.Circle />, hint: "Click the centre, then a point on the edge" },
  { tool: "circle3", label: "3-point circle", key: "", icon: <Icons.Circle3 />, hint: "Click three points the circle passes through" },
  { tool: "arc", label: "Arc", key: "A", icon: <Icons.Arc />, hint: "Click both ends, then a point the arc passes through" },
  { tool: "centreArc", label: "Centre arc", key: "", icon: <Icons.CentreArc />, hint: "Click the centre, then where the arc starts, then where it ends" },
  { tool: "tangentArc", label: "Tangent arc", key: "", icon: <Icons.TangentArc />, hint: "Click the end of a line or arc, then where the arc should finish — it carries on smoothly" },
  { tool: "spline", label: "Spline", key: "", icon: <Icons.Spline />, hint: "Click points for a smooth curve to pass through. Click the first point again to close it, or Esc to finish. Afterwards, select it and drag the green handles at its points to reshape it" },
  { tool: "conic", label: "Conic", key: "", icon: <Icons.Conic />, hint: "Click both ends, then the corner the curve bends towards. Set how full it is (0.5 = a parabola) in the sketch panel" },
  { tool: "ellipse", label: "Ellipse", key: "", icon: <Icons.Ellipse />, hint: "Click the centre, then the end of its length, then how wide it is" },
  { tool: "slot", label: "Slot", key: "S", icon: <Icons.Slot />, hint: "Click both end centres, then move out to set the width" },
  { tool: "polygon", label: "Polygon", key: "G", icon: <Icons.Polygon />, hint: "Click the centre, then a corner (set the number of sides in the sketch panel)" },
  { tool: "point", label: "Point", key: "P or Shift+S", icon: <Icons.Point />, hint: "Click to place a point" },
  { tool: "dimension", label: "Dimension", key: "D", icon: <Icons.Dimension />, hint: "Click a line or circle (or two things), then where the value goes — where you put it picks across, up or straight" },
  { tool: "sketchFillet", label: "Round", key: "", icon: <Icons.CornerRound />, hint: "Click a corner where two lines or arcs meet to round it (set the radius in the sketch panel)" },
  { tool: "extend", label: "Extend", key: "X", icon: <Icons.Extend />, hint: "Click near the end of a line, arc, spline or part of an ellipse to lengthen it up to the next curve it meets" },
  { tool: "split", label: "Split", key: "", icon: <Icons.SplitLine />, hint: "Click a line, arc, spline or part of an ellipse where you want to break it into two (the pieces keep exactly the same shape)" },
  { tool: "trim", label: "Trim", key: "T", icon: <Icons.Trim />, hint: "Click a piece of a line, arc, circle, spline or ellipse to cut it away up to where other curves cross it" },
  { tool: "offset", label: "Offset", key: "O", icon: <Icons.Offset />, hint: "Click a shape's edge on the side to offset towards — a copy that far away that follows the original (set the distance in the sketch panel). Splines and ellipses too" },
  { tool: "mirror", label: "Mirror", key: "M", icon: <Icons.Mirror />, hint: "Click the line to mirror about, then the shapes to copy across (or select the shapes first). The copies follow the originals" },
  { tool: "sketchTransform", label: "Move / copy", key: "", icon: <Icons.Move />, hint: "Click shapes, then drag the handles on them to move, turn or scale them (or type amounts in the sketch panel). Tick Make a copy to leave the originals" },
  { tool: "sketchPattern", label: "Pattern", key: "", icon: <Icons.SketchPattern />, hint: "Click shapes to repeat them in a row or round a centre (set how many and how far apart in the sketch panel). The copies follow the originals" },
  { tool: "useEdge", label: "Use", key: "U", icon: <Icons.UseEdge />, hint: "Click edges of a part (or a face, for its whole outline), or another sketch's lines and curves, to copy them into the sketch (they follow the original if it changes)" },
  { tool: "intersect", label: "Intersect", key: "", icon: <Icons.Intersect />, hint: "Click a face of a part the sketch passes through: where the sketch cuts it comes in as dashed lines that follow the part" },
  { tool: "text", label: "Text", key: "", icon: <Icons.Text />, hint: "Type the words in the sketch panel, then click where they go. Their letters are shapes you can extrude" },
  { tool: "sketchChamfer", label: "Chamfer", key: "", icon: <EditToolIcons.Chamfer />, hint: "Click a corner where two lines meet, or two lines, to cut the corner off straight (set Equal, Two distances or Distance + angle in the sketch panel)" },
  { tool: "slotAlong", label: "Slot on a curve", key: "", icon: <EditToolIcons.SlotAlong />, hint: "Click a line, arc, circle, spline or ellipse to draw a slot along it that follows it (set the width in the sketch panel)" },
  { tool: "ellipticalArc", label: "Elliptical arc", key: "", icon: <EditToolIcons.EllipticalArc />, hint: "Click the centre, the end of the long axis, where the arc starts (this sets how wide it is), then where it ends" },
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
  const view = useSketchView();

  return (
    <div className="toolbar sketch-toolbar" role="toolbar" aria-label="Sketch tools">
      <div className="tool-group">
        <ToolBtn label="Undo" icon={<Icons.Undo />} onClick={sketchUndo} disabled={!canUndo} title={`Undo in this sketch (${shortcut(platform, "Z")})`} iconOnly />
        <ToolBtn label="Redo" icon={<Icons.Redo />} onClick={sketchRedo} disabled={!canRedo} title={`Redo in this sketch (${shortcut(platform, platform === "mac" ? "Z" : "Y", { shift: platform === "mac" })})`} iconOnly />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        {TOOLS.map((t) => {
          if (SKETCH_INSERT_TOOLS.includes(t.tool)) return null;
          const family = FAMILIES.find((f) => f.tools.includes(t.tool));
          if (family && family.tools[0] !== t.tool) return null;
          if (family)
            return (
              <ToolGroupButton
                key={family.name}
                id={`sketch-${family.name}`}
                name={family.name}
                items={family.tools.map((k) => {
                  const d = TOOLS.find((x) => x.tool === k)!;
                  return {
                    key: d.tool,
                    label: d.label,
                    icon: d.icon,
                    title: `${d.label}${d.key ? ` (${d.key})` : ""} — ${d.hint}`,
                    shortcut: d.key || undefined,
                    active: tool === d.tool,
                    disabled: !hasPlane,
                    onClick: () => setSketchTool(d.tool),
                  };
                })}
              />
            );
          return (
            <ToolBtn
              key={t.tool}
              label={t.label}
              icon={t.icon}
              active={tool === t.tool}
              disabled={!hasPlane}
              onClick={() => setSketchTool(t.tool)}
              title={`${t.label}${t.key ? ` (${t.key})` : ""} — ${t.hint}`}
            />
          );
        })}
        <ToolGroupButton
          id="sketch-text"
          name="text and insert"
          items={[
            ...TOOLS.filter((t) => SKETCH_INSERT_TOOLS.includes(t.tool)).map((d) => ({
              key: d.tool,
              label: d.label,
              icon: d.icon,
              title: `${d.label}${d.key ? ` (${d.key})` : ""} — ${d.hint}`,
              shortcut: d.key || undefined,
              active: tool === d.tool,
              disabled: !hasPlane,
              onClick: () => setSketchTool(d.tool),
            })),
            {
              divider: true,
              key: "dxf",
              label: "Insert DXF",
              icon: <Icons.InsertDxf />,
              title: "Insert DXF — bring a 2D drawing (DXF file) into this sketch as lines, arcs and circles you can edit",
              disabled: !hasPlane,
              onClick: () => useStore.getState().setSketchOptions({ dxfOpen: true }),
            },
            {
              key: "svg",
              label: "Insert SVG",
              icon: <Icons.InsertDxf />,
              title: "Insert SVG — bring a drawing from Inkscape, Illustrator or Cricut (SVG file) into this sketch at true size, as lines, arcs, circles and curves you can edit",
              disabled: !hasPlane,
              onClick: () => useStore.getState().setSketchOptions({ dxfOpen: true }),
            },
            {
              key: "image",
              label: "Insert image",
              icon: <Icons.Picture />,
              title: "Insert image — lay a picture on the sketch to trace over (it isn't part of the shape)",
              disabled: !hasPlane,
              onClick: () => pickFile("image/*", (f) => void insertImageFile(f)),
            },
          ]}
        />
        <ToolBtn
          label="Construction"
          icon={<Icons.Construction />}
          active={construction}
          disabled={!hasPlane}
          onClick={toggleSketchConstruction}
          title="Construction (Q) — dashed helper geometry that isn't extruded. Toggles the selection, or new shapes if nothing is selected. Shift+P hides or shows it all."
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group relations">
        {MAIN_RELATIONS.map((r) => (
          <button
            key={r}
            className="relation-button"
            disabled={!hasPlane}
            onClick={() => applySketchRelation(r)}
            title={relationTitle(r)}
            aria-label={RELATION_LABELS[r]}
          >
            <span className="relation-symbol">{relationSymbol(r)}</span>
            <span>{RELATION_LABELS[r]}</span>
          </button>
        ))}
        <ToolGroupButton
          id="sketch-more-relations"
          name="relation"
          compact
          items={MORE_RELATIONS.map((r) => ({
            key: r,
            label: RELATION_LABELS[r],
            icon: <span className="relation-symbol">{relationSymbol(r)}</span>,
            title: relationTitle(r),
            disabled: !hasPlane,
            onClick: () => applySketchRelation(r),
          }))}
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolGroupButton
          id="sketch-show"
          name="what the sketch shows"
          compact
          items={[
            {
              key: "constraints",
              label: view.constraints ? "Hide constraints" : "Show constraints",
              icon: <Icons.Eye />,
              title: "Show or hide the relation marks (parallel, equal…) beside the shapes. Hidden ones still hold. Remembered in this browser.",
              active: view.constraints,
              onClick: () => setSketchView({ constraints: !view.constraints }),
            },
            {
              key: "dimensions",
              label: view.dimensions ? "Hide dimensions" : "Show dimensions",
              icon: <Icons.Dimension />,
              title: "Show or hide the dimensions. Hidden ones still set the sizes. Remembered in this browser.",
              active: view.dimensions,
              onClick: () => setSketchView({ dimensions: !view.dimensions }),
            },
            {
              key: "expressions",
              label: view.expressions ? "Show numbers on dimensions" : "Show expressions",
              icon: <span className="relation-symbol">x</span>,
              title: "Dimensions typed as a variable or a sum show what was typed (like width / 2) instead of the number. Remembered in this browser.",
              active: view.expressions,
              onClick: () => setSketchView({ expressions: !view.expressions }),
            },
            {
              key: "construction",
              label: view.hideConstruction ? "Show construction geometry" : "Hide construction geometry",
              icon: <Icons.Construction />,
              title: "Hide or show the dashed construction geometry (Shift+P)",
              shortcut: "Shift+P",
              active: !view.hideConstruction,
              onClick: toggleSketchConstructionShown,
            },
          ]}
        />
      </div>
      <div className="toolbar-spacer" />
      <div className="tool-group">
        <ToolBtn
          label="Extrude"
          icon={<Icons.Extrude />}
          onClick={() => finishSketchInto("extrude")}
          disabled={!hasPlane}
          title="Extrude — finish the sketch and extrude its closed shapes (as Onshape's sketch toolbar does)"
        />
        <ToolBtn
          label="Revolve"
          icon={<Icons.Revolve />}
          onClick={() => finishSketchInto("revolve")}
          disabled={!hasPlane}
          title="Revolve — finish the sketch and turn its closed shapes round a line"
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolBtn
          label="Copy"
          icon={<Icons.Duplicate />}
          onClick={() => copySketchSelection()}
          disabled={!hasSelection}
          title="Copy the selection, with the relations and dimensions between them (Ctrl+C). Ctrl+D makes a copy straight away."
        />
        <ToolBtn label="Paste" icon={<Icons.Insert />} onClick={() => pasteIntoSketch()} disabled={!hasPlane} title="Paste what was copied: it follows the pointer until you click (Ctrl+V)" />
        <ToolBtn label="Delete" icon={<Icons.Trash />} onClick={deleteSketchSelection} disabled={!hasSelection} title="Delete the selection (Delete)" />
      </div>
    </div>
  );
}

/** A relation button's tooltip: its name, its key (if it has one) and what to select. */
function relationTitle(r: RelationTool): string {
  const key = relationKey(r);
  return `${RELATION_LABELS[r]}${key ? ` (${key})` : ""} — ${RELATION_HINTS[r]}`;
}

function relationSymbol(r: RelationTool): string {
  return r === "pierce" ? "⊗" : RELATION_SYMBOLS[r] ?? "";
}

function ToolBtn({
  label,
  icon,
  onClick,
  disabled,
  active,
  title,
  iconOnly,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  active?: boolean;
  title?: string;
  /** Just the icon (Undo, Redo), the name being in the tooltip. */
  iconOnly?: boolean;
}) {
  return (
    <button className={`tool-button${iconOnly ? " icon-only" : ""}${active ? " active" : ""}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-label={label} aria-pressed={active}>
      {icon}
      {!iconOnly && <span>{label}</span>}
    </button>
  );
}
