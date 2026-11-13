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

/** The tools in a toolbar layout, in order (a tool listed twice shows twice). */
export function toolsIn(layout: readonly ToolbarEntry[]): string[] {
  return layout.flatMap((e) => (typeof e === "string" ? [] : e.tools));
}

/** Sketch tools shown as one ▾ button (the first until another is used), like Onshape's sketch toolbar. */
export const SKETCH_FAMILIES: readonly { name: string; tools: readonly SketchTool[] }[] = [
  { name: "rectangle", tools: ["rectangle", "centreRectangle", "alignedRectangle", "slot", "polygon"] },
  { name: "circle", tools: ["circle", "circle3", "ellipse"] },
  { name: "arc", tools: ["arc", "centreArc", "tangentArc"] },
  { name: "spline", tools: ["spline", "conic"] },
  { name: "trim", tools: ["trim", "extend", "split", "offset", "sketchFillet"] },
  { name: "copy", tools: ["mirror", "sketchPattern", "sketchTransform"] },
  { name: "use", tools: ["useEdge", "intersect"] },
];

/** Sketch relations always on the toolbar; the rest are under "More relations ▾". */
export const MAIN_RELATIONS: readonly RelationTool[] = ["coincident", "horizontal", "vertical", "parallel", "perpendicular", "equal", "tangent", "fix"];
export const MORE_RELATIONS: readonly RelationTool[] = ["concentric", "midpoint", "symmetric", "normal", "curvature", "pierce"];

/** The sketch tools that go with Insert DXF / Insert image in the sketch toolbar's "insert" group. */
export const SKETCH_INSERT_TOOLS: readonly SketchTool[] = ["text"];
