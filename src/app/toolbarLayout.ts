/**
 * Which tool goes where on the Part Studio and sketch toolbars (pure data, no React, so it can be tested).
 *
 * Tools are grouped as in Onshape, so a Part Studio's toolbar fits a 1280 px window without scrolling: a slot with
 * one tool is a plain button, a slot with several is a ▾ group button (`ToolGroupButton`) showing the tool used last
 * from it (remembered under `partsmith.toolGroup.<id>`), the first tool until then. `breaks` start a new section in
 * the group's list (a thin line above that tool). Every tool appears exactly once (tests/toolbarLayout).
 */
import { CURVE_KINDS } from "../model/curves";
import type { SketchTool } from "../model/store";
import type { CurveKind } from "../model/types";
import type { RelationTool } from "../sketch/ops";

export interface ToolbarSlot {
  /** Remembers the last tool used from a group; keep an id when the group keeps its meaning. */
  id: string;
  /** Used in "More <name> tools" on the ▾. */
  name: string;
  tools: readonly string[];
  breaks?: readonly string[];
}

/** A slot, a divider ("|") or the gap pushing what follows to the right ("~"). */
export type ToolbarEntry = ToolbarSlot | "|" | "~";

const CURVE_TOOLS: `curve:${CurveKind}`[] = CURVE_KINDS.map((k) => `curve:${k.kind}` as const);

/** Every Part Studio toolbar tool, by key (curve features are "curve:<kind>"). */
export const STUDIO_TOOLS = [
  "undo",
  "redo",
  "sketch",
  "extrude",
  "revolve",
  "sweep",
  "loft",
  "fillet",
  "chamfer",
  "fullRound",
  "faceBlend",
  "hole",
  "thread",
  "shell",
  "hollow",
  "rib",
  "draft",
  "moveFace",
  "replaceFace",
  "deleteFace",
  "modifyFillet",
  "transform",
  "linearPattern",
  "circularPattern",
  "curvePattern",
  "mirror",
  "boolean",
  "split",
  "composite",
  "simplify",
  "deletePart",
  "plane",
  "mateConnector",
  ...CURVE_TOOLS,
  "fill",
  "boundary",
  "thicken",
  "enclose",
  "extendSurface",
  "ruled",
  "offsetSurface",
  "frame",
  "trimFrame",
  "gusset",
  "cutList",
  "sheetMetal",
  "flange",
  "tab",
  "bend",
  "jog",
  "hem",
  "cornerBreak",
  "unfold",
  "flatPattern",
  "box",
  "cylinder",
  "sphere",
  "coil",
  "fastener",
  "text",
  "wrap",
  "library",
  "import",
  "derived",
  "variables",
  "configurations",
  "printCheck",
  "printBed",
  "laser",
  "picture",
  "section",
  "fit",
  "namedViews",
  "selectFilter",
] as const;

export type StudioTool = (typeof STUDIO_TOOLS)[number];

const one = (tool: StudioTool): ToolbarSlot => ({ id: tool, name: tool, tools: [tool] });

export const STUDIO_TOOLBAR: readonly ToolbarEntry[] = [
  one("undo"),
  one("redo"),
  "|",
  one("sketch"),
  one("extrude"),
  { id: "sweeps", name: "solid", tools: ["revolve", "sweep", "loft"] },
  { id: "edges", name: "edge", tools: ["fillet", "chamfer", "fullRound", "faceBlend"] },
  { id: "holes", name: "hole", tools: ["hole", "thread"] },
  {
    id: "shell",
    name: "shell and face",
    tools: ["shell", "hollow", "rib", "draft", "moveFace", "replaceFace", "deleteFace", "modifyFillet"],
    breaks: ["moveFace"],
  },
  "|",
  { id: "move", name: "move and pattern", tools: ["transform", "linearPattern", "circularPattern", "curvePattern", "mirror"], breaks: ["linearPattern"] },
  { id: "parts", name: "part", tools: ["boolean", "split", "composite", "simplify", "deletePart"] },
  "|",
  { id: "planes", name: "plane and curve", tools: ["plane", "mateConnector", ...CURVE_TOOLS], breaks: [CURVE_TOOLS[0]] },
  { id: "surfaces", name: "surface", tools: ["fill", "boundary", "thicken", "enclose", "extendSurface", "ruled", "offsetSurface"] },
  { id: "frames", name: "frame", tools: ["frame", "trimFrame", "gusset", "cutList"] },
  {
    id: "sheet-metal",
    name: "sheet metal",
    tools: ["sheetMetal", "flange", "tab", "bend", "jog", "hem", "cornerBreak", "unfold", "flatPattern"],
    breaks: ["unfold"],
  },
  "|",
  { id: "solids", name: "shape", tools: ["box", "cylinder", "sphere", "coil", "fastener", "text", "wrap"], breaks: ["fastener", "text"] },
  { id: "insert", name: "insert", tools: ["library", "import", "derived"] },
  { id: "settings-tables", name: "table", tools: ["variables", "configurations"] },
  "~",
  { id: "output", name: "print and export", tools: ["printCheck", "printBed", "laser", "picture"] },
  one("section"),
  one("fit"),
  one("namedViews"),
  one("selectFilter"),
];

/**
 * A layout with some groups joined into one ▾ (each joined group's first tool starts a new section of its list), and
 * the joined groups' other places dropped. Every tool stays exactly once.
 */
export function joinedSlots(layout: readonly ToolbarEntry[], joins: readonly { id: string; name: string; ids: readonly string[] }[]): ToolbarEntry[] {
  const out: ToolbarEntry[] = [];
  const slotOf = new Map(layout.filter((e): e is ToolbarSlot => typeof e !== "string").map((e) => [e.id, e]));
  for (const e of layout) {
    if (typeof e === "string") {
      // No two dividers in a row (a joined group's own divider goes).
      if (!(e === "|" && out[out.length - 1] === "|")) out.push(e);
      continue;
    }
    const join = joins.find((j) => j.ids.includes(e.id));
    if (!join) out.push(e);
    else if (join.ids[0] === e.id) {
      const parts = join.ids.map((id) => slotOf.get(id)).filter((x): x is ToolbarSlot => !!x);
      out.push({
        id: join.id,
        name: join.name,
        tools: parts.flatMap((p) => p.tools),
        breaks: parts.flatMap((p, i) => [...(i > 0 ? [p.tools[0]] : []), ...(p.breaks ?? [])]),
      });
    }
  }
  return out;
}

/**
 * The Part Studio's toolbar on a touch screen up to 1300 px wide (an iPad held sideways is 1180): the buttons show just
 * their icons (styles.css) and the rarer groups share a ▾, so it fits without scrolling. Upright (820 px) it scrolls.
 */
export const STUDIO_TOUCH_TOOLBAR: readonly ToolbarEntry[] = joinedSlots(STUDIO_TOOLBAR, [
  { id: "touch-surface-frame-sheet", name: "surface, frame and sheet metal", ids: ["surfaces", "frames", "sheet-metal"] },
  { id: "touch-insert-tables", name: "insert and table", ids: ["insert", "settings-tables"] },
]);

/** The tools in a toolbar layout, in order (a tool listed twice shows twice). */
export function toolsIn(layout: readonly ToolbarEntry[]): string[] {
  return layout.flatMap((e) => (typeof e === "string" ? [] : e.tools));
}

/** Sketch tools shown as one ▾ button (the first until another is used), like Onshape's sketch toolbar. */
export const SKETCH_FAMILIES: readonly { name: string; tools: readonly SketchTool[] }[] = [
  { name: "line", tools: ["line", "midpointLine"] },
  { name: "rectangle", tools: ["rectangle", "centreRectangle", "alignedRectangle", "slot", "polygon", "slotAlong"] },
  { name: "circle", tools: ["circle", "circle3", "ellipse"] },
  { name: "arc", tools: ["arc", "centreArc", "tangentArc", "ellipticalArc"] },
  { name: "spline", tools: ["spline", "conic", "point"] },
  { name: "round", tools: ["sketchFillet", "sketchChamfer"] },
  { name: "trim", tools: ["trim", "extend", "split", "offset"] },
  { name: "copy", tools: ["mirror", "sketchPattern", "sketchTransform"] },
  { name: "use", tools: ["useEdge", "intersect"] },
];

/** Sketch relations always on the toolbar; the rest are under "More relations ▾". */
export const MAIN_RELATIONS: readonly RelationTool[] = ["coincident", "horizontal", "vertical", "parallel", "equal"];
export const MORE_RELATIONS: readonly RelationTool[] = ["perpendicular", "tangent", "fix", "concentric", "midpoint", "symmetric", "normal", "curvature", "pierce"];

/** Sketch tools with a button of their own (every other drawing tool is in a family or the insert group). */
export const SKETCH_SINGLE_TOOLS: readonly SketchTool[] = ["select", "dimension"];

/**
 * Every drawing tool on the sketch toolbar (SketchToolbar.tsx's TOOLS), each in exactly one place (tests/toolbarLayout).
 * The toolbar fits a 1280 px window with room to spare: Copy / Paste / Delete share one ▾, Extrude / Revolve another,
 * Construction is just its icon, and the rarer relations are under "More relations ▾".
 */
export const SKETCH_TOOLBAR_TOOLS: readonly SketchTool[] = [
  "select",
  "line",
  "midpointLine",
  "rectangle",
  "centreRectangle",
  "alignedRectangle",
  "circle",
  "circle3",
  "arc",
  "centreArc",
  "tangentArc",
  "spline",
  "conic",
  "ellipse",
  "slot",
  "polygon",
  "point",
  "dimension",
  "sketchFillet",
  "extend",
  "split",
  "trim",
  "offset",
  "mirror",
  "sketchTransform",
  "sketchPattern",
  "useEdge",
  "intersect",
  "text",
  "sketchChamfer",
  "slotAlong",
  "ellipticalArc",
];

/** The sketch tools that go with Insert DXF / Insert image in the sketch toolbar's "insert" group. */
export const SKETCH_INSERT_TOOLS: readonly SketchTool[] = ["text"];
