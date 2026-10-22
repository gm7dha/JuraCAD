/**
 * The JuraCAD tools Claude uses to build parts: their names, descriptions
 * and input shapes (for the MCP server), and what each one does. Each tool is
 * a plain function of a Session and its input, so they're tested without any
 * MCP plumbing (tests/mcpTools.test.ts).
 */
import { createFeature, emptyDocument, removeFeature, renamePart, replaceFeature, addFeature, newId } from "../model/document";
import { readDocumentFile, serializeDocument, nameFromFileName, FILE_EXTENSION, OLD_FILE_EXTENSION } from "../model/fileFormat";
import { applyVariables, resolveVariables, checkName, type Variable } from "../model/variables";
import { describeHole } from "../model/holes";
import type { Feature, JuraCADDocument } from "../model/types";
import { planeFrame, planeLabel } from "../sketch/planes";
import { holePositionsIn } from "../sketch/holePositions";
import { evaluate } from "../model/expr";
import { analyzeSketch } from "../sketch/solver";
import { DIMENSION_TYPES } from "../sketch/types";
import type { PartMesh } from "../kernel/protocol";
import { InputError, list, MAX_LENGTH, noExtras, object, oneOf, text, type Obj } from "./args";
import { applyFeature, applySketch, describePlane, FEATURE_KINDS, KIND_OF, limitProblems, type FeatureKind, type SpecContext } from "./featureSpec";
import { describeEdge, describeFace, edgeList, faceList, facing, PICK_HELP } from "./picks";
import { renderViews, RENDER_VIEWS, type RenderView } from "./render";
import type { Session } from "./session";
import { SHAPE_HELP } from "./sketchShapes";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Only looks; changes nothing. */
  readOnly?: boolean;
  /** Can replace a file, or drop the design being worked on. */
  destructive?: boolean;
  run: (s: Session, a: Obj) => ToolResult | Promise<ToolResult>;
}

/** A file name made from the design's name, safe on every computer. */
export function fileNameFor(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
  if (!cleaned || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned)) return "design";
  return cleaned;
}

const say = (...lines: (string | false | null | undefined)[]): ToolResult => ({ content: [{ type: "text", text: lines.filter((l) => l !== false && l !== null && l !== undefined).join("\n") }] });

const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
const r1 = (v: number) => Math.round(v * 10) / 10 || 0;

export const FORMAT_GUIDE = `JuraCAD conventions (the same as Onshape):
- Units: millimetres for every length, degrees for angles. Any number may instead be maths or a variable as text: "w / 2", "1 in", "thickness * 2".
- Axes: Z is up. The Top plane is XY (seen from above), Front is XZ (seen from −Y, so +X is right and +Z up), Right is YZ (seen from +X).
- Building a part: add_sketch (2D shapes on a plane or on a flat face of a part) → add_feature "extrude" (or "revolve") to make a solid → then holes, fillets, chamfers, shells, patterns, mirrors. Features build in order; later ones change the result of earlier ones, and every size stays editable in the app.
- Sketches: on the Top plane sketch x/y are world X/Y. On Front, sketch x = X and sketch y = Z. On Right, sketch x = Y and sketch y = Z. On a face, add_sketch says where its axes point. Shapes are fully dimensioned from the sketch origin automatically.
- Sketching on a face ("on_face"): the sketch origin is where the world origin lands on that face, and its axes are — top face: x = +X, y = +Y; bottom: x = −X, y = +Y; front: x = +X, y = +Z; back: x = −X, y = +Z; right: x = +Y, y = +Z; left: x = −Y, y = +Z. add_sketch also says where they point. "top" (and "front"…) means the outermost flat face facing that way; for another face use its number from list_faces (F3) or {"near": [x, y, z]}.
- Extrude goes along the sketch plane's normal: up (+Z) from Top, towards −Y from Front, towards +X from Right; "flip": true goes the other way. "operation": "new" makes a separate part, "add" joins the latest part, "remove" cuts it, "intersect" keeps the overlap. The first solid is new; later ones default to add.
- Cuts: "operation": "remove" on a sketch drawn on a face of the part goes into the part by default. "end": "through_all" cuts right through, both ways from the sketch. A cut or hole that misses the part (or a fillet that changes nothing) is refused with advice — usually to flip it or draw it on the right face. Every change reports how each part's volume changed.
- Holes: draw the points (or circles) on the face the holes start from (add_sketch with "on_face"), then add_feature "hole" with a screw "size" ("M4"…) and "fit" ("clearance" for the screw to pass through, "tapped" for a thread). Holes drill into the face (against the sketch's normal).
- Limits: sizes and positions up to 10 000 mm; patterns up to 100 copies each way (400 in all); sketches up to 100 shapes, outlines up to 100 points.
- Picking faces and edges: ${PICK_HELP.faces} ${PICK_HELP.edges} Numbers (F3, E5) change when the part changes, so list them again after changes.
- A sketch on a face stays where that face was when it was drawn. If an earlier change moves the face (say, a thicker plate), put the sketch back with edit_feature {"feature": "Sketch 2", "on_face": "top"}.
- Check your work: describe_design (volumes, sizes, validity, problems) and get_views (a picture). If something went wrong, edit_feature or undo.
- Save with save_design; the owner opens the .juracad file in JuraCAD (https://gm7dha.github.io/JuraCAD/) with Open, where every feature and dimension can be changed.
- Live with Claude: if the user clicks "Connect to Claude" in JuraCAD's top bar (Chrome or Edge), the tools work on the design open in their JuraCAD tab instead — the Part Studio on show — and each change appears there straight away, as one step in its undo list. The user can keep editing and undoing; if they change something at the same moment, your change is refused with nothing lost, so look again (describe_design) and retry. Ask them to finish any dialog they have open if a change is refused as busy. live_status says whether you're connected. new_design and open_design then replace what's open in their tab (they can undo it), so only use them when asked. save_design still saves a .juracad file.`;

/** One line about a feature, for lists. */
export function summarize(f: Feature, doc: JuraCADDocument): string {
  const nameOf = (id?: string) => doc.features.find((x) => x.id === id)?.name ?? "(missing)";
  const p = f.params;
  const op = f.operation === "new" ? "new part" : f.operation === "add" ? "added to the part" : f.operation === "remove" ? "cut from the part" : "intersected";
  const mm = (v?: string) => (v === undefined ? "?" : /^-?[\d.]+$/.test(v) ? `${v} mm` : `"${v}"`);
  switch (f.type) {
    case "sketch": {
      const d = f.sketch!.data;
      const free = analyzeSketch(d).freedom;
      const dims = d.constraints.filter((c) => DIMENSION_TYPES.has(c.type)).length;
      return `sketch on ${f.sketch!.plane ? planeLabel(f.sketch!.plane) : "no plane"}: ${d.curves.filter((c) => !c.construction).length} curves, ${d.points.filter((x) => x.standalone).length} points, ${dims} dimensions, ${free === 0 ? "fully defined" : `${free} ways still free`}`;
    }
    case "extrude": {
      const e = f.extrude!;
      const how = e.end === "throughAll" ? "through all" : e.end === "upToFace" ? "up to a face" : e.end === "symmetric" ? `${mm(p.depth)} (half each way)` : `${mm(p.depth)}${e.second ? ` + ${mm(p.depth2)} the other way` : ""}`;
      return `extrude ${nameOf(f.sketchRef)} ${how}${e.flip ? ", flipped" : ""}${p.draft && p.draft !== "0" ? `, draft ${p.draft}°` : ""}, ${op}`;
    }
    case "revolve":
      return `revolve ${nameOf(f.sketchRef)} ${p.angle ?? 360}° about ${f.revolve?.axis === "vertical" || f.revolve?.axis === "horizontal" ? `the sketch's ${f.revolve.axis} axis` : "a sketch line"}, ${op}`;
    case "hole": {
      const h = f.hole!;
      return `${describeHole(h)}${h.standard === "Custom" ? ` ⌀${p.diameter}` : ""}, ${h.end === "throughAll" ? "through all" : `${mm(p.depth)} deep`}, at the points of ${nameOf(h.sketchRef)}`;
    }
    case "fillet":
      return `fillet radius ${mm(p.radius)} on ${f.picks?.length ?? 0} edge/face pick(s)`;
    case "chamfer":
      return `chamfer ${mm(p.distance)} on ${f.picks?.length ?? 0} edge/face pick(s)`;
    case "shell":
      return `shell, walls ${mm(p.thickness)}, ${f.picks?.length ? `${f.picks.length} face(s) left open` : "closed inside"}`;
    case "linearPattern":
      return `linear pattern of ${(f.pattern?.sources ?? []).map(nameOf).join(", ")}: ${p.count} along ${f.pattern?.axis.toUpperCase()}, ${mm(p.spacing)} apart${Number(p.count2 ?? 1) > 1 ? `, ${p.count2} rows along ${f.pattern?.axis2?.toUpperCase()} ${mm(p.spacing2)} apart` : ""}`;
    case "circularPattern":
      return `circular pattern of ${(f.pattern?.sources ?? []).map(nameOf).join(", ")}: ${p.count} round ${f.pattern?.axis.toUpperCase()} over ${p.angle ?? 360}°`;
    case "mirror":
      return f.mirror?.part ? `mirror of a whole part across ${planeLabel(f.mirror.plane)}${f.mirror.join ? ", joined on" : ""}` : `mirror of ${(f.mirror?.sources ?? []).map(nameOf).join(", ")} across ${f.mirror ? planeLabel(f.mirror.plane) : "?"}`;
    case "boolean":
      return `boolean ${f.booleanDef?.op}`;
    case "box":
      return `box ${p.width} × ${p.depth} × ${p.height} mm at (${p.x}, ${p.y}, ${p.z}), ${op}`;
    case "cylinder":
      return `cylinder ⌀${p.diameter} × ${p.height} mm at (${p.x}, ${p.y}, ${p.z}), ${op}`;
    case "sphere":
      return `sphere ⌀${p.diameter} mm at (${p.x}, ${p.y}, ${p.z}), ${op}`;
    default:
      return `${f.type} (made in the app)`;
  }
}

function bounds(p: PartMesh): [number[], number[]] {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.vertices.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], p.vertices[i + k]);
      max[k] = Math.max(max[k], p.vertices[i + k]);
    }
  }
  return [min, max];
}

/** One line per part: its size and volume. */
export function partLine(p: PartMesh): string {
  const [min, max] = bounds(p);
  const size = max.map((v, k) => r2(v - min[k]));
  return `${p.name}${p.surface ? " (a surface)" : ""}: ${p.surface ? "" : `volume ${r2(p.volume ?? 0)} mm³, `}size ${size.join(" × ")} mm (X × Y × Z), from (${min.map(r2).join(", ")}) to (${max.map(r2).join(", ")}), ${p.faceRefs.length} faces, ${p.edgeRefs.length} edges`;
}

function problems(s: Session, errors: Record<string, string>): string[] {
  return Object.entries(errors).map(([id, e]) => `- ${s.doc.features.find((f) => f.id === id)?.name ?? id}: ${e}`);
}

function partsReport(s: Session): string[] {
  const b = s.build();
  return [
    b.parts.length ? `Parts now:\n${b.parts.map((p) => `- ${partLine(p)}`).join("\n")}` : "There are no parts yet.",
    ...(Object.keys(b.errors).length ? ["Problems:", ...problems(s, b.errors)] : []),
  ];
}

/** Errors that are new in `after` (or changed), compared with `before`. */
function newErrors(before: Record<string, string>, after: Record<string, string>): string[] {
  return Object.keys(after).filter((id) => before[id] !== after[id]);
}

/** Solid volume of each part, by id. */
function volumes(parts: PartMesh[]): Map<string, { name: string; volume: number }> {
  return new Map(parts.filter((p) => !p.surface).map((p) => [p.id, { name: p.name, volume: p.volume ?? 0 }]));
}

const total = (v: Map<string, { volume: number }>) => [...v.values()].reduce((n, p) => n + p.volume, 0);

/** "Part 1: 7200 → 7009.17 mm³ (−190.83)" for each part whose volume changed. */
function volumeChange(before: ReturnType<typeof volumes>, after: ReturnType<typeof volumes>): string | null {
  const lines: string[] = [];
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) lines.push(`${a.name}: new, ${r2(a.volume)} mm³`);
    else if (Math.abs(a.volume - b.volume) > 1e-6) lines.push(`${a.name}: ${r2(b.volume)} → ${r2(a.volume)} mm³ (${a.volume > b.volume ? "+" : "−"}${r2(Math.abs(a.volume - b.volume))})`);
  }
  for (const [id, b] of before) if (!after.has(id)) lines.push(`${b.name}: gone (was ${r2(b.volume)} mm³)`);
  return lines.length ? `Volume change: ${lines.join("; ")}.` : "Volume change: none.";
}

/** Which way a sketch-based feature goes, in words ("+Z"). */
function directionOf(f: Feature, doc: JuraCADDocument): string | null {
  const sk = doc.features.find((x) => x.id === (f.sketchRef ?? f.hole?.sketchRef))?.sketch?.plane;
  if (!sk || f.type === "revolve") return null;
  const n = planeFrame(sk).n;
  const sign = f.type === "hole" ? (f.hole?.flip ? 1 : -1) : f.extrude?.flip ? -1 : 1;
  return facing([n[0] * sign, n[1] * sign, n[2] * sign]).replace(/ \(.*\)$/, "");
}

/**
 * Did the feature do something? A cut or hole that misses the part (or only
 * grazes it), or a rounding that changes nothing, is almost always a mistake
 * (usually the wrong direction), so it's refused with advice.
 */
function effectProblem(s: Session, f: Feature, doc: JuraCADDocument, before: ReturnType<typeof volumes>, after: ReturnType<typeof volumes>, toolVolume: number | null, notes: string[]): string | null {
  if (f.suppressed) return null;
  const change = total(after) - total(before);
  const dir = directionOf(f, doc);
  const going = dir ? ` It goes towards ${dir} from its sketch.` : "";
  if (f.type === "hole") {
    const sketch = doc.features.find((x) => x.id === f.hole?.sketchRef)?.sketch;
    const n = sketch ? holePositionsIn(sketch.data).length : 0;
    const d = evaluate(f.params.diameter ?? "0", s.scope(doc));
    if (!n || !d.ok) return null;
    // At least 0.2 mm deep on average at every hole.
    const least = n * Math.PI * (d.value / 2) ** 2 * 0.2;
    if (-change < least) {
      return `${f.name} would remove only ${r2(Math.max(0, -change))} mm³ — the holes miss the part (or barely touch it).${going} Draw the hole points on the face the holes start from (add_sketch with "on_face", e.g. "top"), or use "flip": true to drill the other way.`;
    }
    return null;
  }
  if (["extrude", "revolve", "box", "cylinder", "sphere"].includes(f.type)) {
    const tool = toolVolume ?? 0;
    const through = f.type === "extrude" && f.extrude?.end === "throughAll";
    if (f.operation === "remove") {
      // Nothing at all removed: it misses. A little (under 2% of the cutting shape) may be a trim, so it's kept with a note.
      if (-change < 1e-3) {
        return `${f.name} would cut nothing from the part — it misses it.${going} ${f.type === "extrude" ? 'Try "flip": true to go the other way, or end "through_all" (which cuts both ways).' : "Check its position against the part (describe_design gives the part's size and position)."}`;
      }
      if (!through && tool > 0 && -change < 0.02 * tool) {
        notes.push(`This cut removed only ${r2(-change)} mm³ (${r2((100 * -change) / tool)}% of the cutting shape)${dir ? `, going towards ${dir}` : ""}; if you meant to cut more, check its direction and position.`);
      }
    } else if (f.operation === "add" && tool > 1e-6 && change < 1e-3) {
      return `${f.name} would add nothing: it's entirely inside the part already.${going} ${f.type === "extrude" ? 'Try "flip": true to go the other way.' : "Check its position."}`;
    } else if (f.operation === "intersect" && Math.abs(change) < 1e-3) {
      return `${f.name} would change nothing: the part is already entirely inside it.`;
    }
    return null;
  }
  if ((f.type === "fillet" || f.type === "chamfer" || f.type === "shell") && Math.abs(change) < 1e-4) {
    return `${f.name} would change nothing. Check the ${f.type === "shell" ? "faces" : "edges"} chosen (list_${f.type === "shell" ? "faces" : "edges"} shows them).`;
  }
  return null;
}

/**
 * Try a changed design: keep it if it builds without new problems and the
 * feature does something, otherwise explain and change nothing. Returns the
 * report of the parts, starting with how their volumes changed.
 */
function tryChange(s: Session, next: JuraCADDocument, featureId: string | null, verb: string): string[] {
  const before = s.build().errors;
  const beforeVolumes = volumes(s.build().parts);
  // Sizes and pattern counts, worked out with the new values (variables can change them too), before any slow build.
  const limitsBefore = limitProblems(s.doc, s.scope());
  const overLimits = [...limitProblems(next, s.scope(next))].filter(([id, why]) => limitsBefore.get(id) !== why);
  if (overLimits.length) {
    throw new InputError(`Couldn't ${verb} — ${overLimits.map(([id, why]) => `${next.features.find((x) => x.id === id)?.name ?? id}: ${why}`).join("; ")}. Nothing was changed.`);
  }
  const after = s.build(next.features, next).errors;
  const fresh = newErrors(before, after);
  const refuse = (why: string) => {
    s.build();
    throw new InputError(`Couldn't ${verb}${why}\nNothing was changed. Adjust the settings and try again${featureId && s.doc.features.some((f) => f.id === featureId) ? " (or delete_feature it)" : ""}.`);
  };
  if (fresh.length) {
    const lines = fresh.map((id) => {
      const name = next.features.find((f) => f.id === id)?.name ?? s.doc.features.find((f) => f.id === id)?.name ?? id;
      return `- ${id === featureId ? `${name} (this one)` : name}: ${after[id]}`;
    });
    refuse(` — it wouldn't build:\n${lines.join("\n")}`);
  }
  const notes: string[] = [];
  const afterVolumes = volumes(s.build(next.features, next).parts);
  const f = featureId ? next.features.find((x) => x.id === featureId) : undefined;
  if (f) {
    // What this feature itself does: the parts just before it, and just after.
    const at = next.features.indexOf(f);
    const isLast = at === next.features.length - 1 && next.features.slice(0, at).every((x, i) => x === s.doc.features[i]) && s.doc.features.length === at;
    const pre = isLast ? beforeVolumes : volumes(s.build(next.features.slice(0, at), next).parts);
    const post = isLast ? afterVolumes : volumes(s.build(next.features.slice(0, at + 1), next).parts);
    // The solid it added or cut, from the build just made.
    const toolVolume = s.engineAsBuilt((e) => e.featureToolVolume(f.id));
    if (!isLast) s.build(next.features, next);
    const problem = effectProblem(s, f, next, pre, post, toolVolume, notes);
    if (problem) refuse(`: ${problem}`);
  }
  s.commit(next);
  return [...notes.map((n) => `Note: ${n}`), volumeChange(beforeVolumes, afterVolumes)!, ...partsReport(s)];
}

function context(s: Session, before: Feature[] | null, editing: boolean): SpecContext {
  const features = before ?? s.doc.features;
  return { session: s, doc: s.doc, parts: s.build(features).parts, scope: s.scope(), editing };
}

const featureLine = (f: Feature, doc: JuraCADDocument, errors: Record<string, string>) =>
  `- ${f.name} [id ${f.id}]${f.suppressed ? " (suppressed)" : ""}: ${summarize(f, doc)}${errors[f.id] ? ` — PROBLEM: ${errors[f.id]}` : ""}`;

const SHAPES_SCHEMA = {
  type: "array",
  description: `The shapes to draw (in the sketch's own x, y, in mm). Shapes that touch are joined. Kinds:\n${SHAPE_HELP.join("\n")}`,
  items: {
    type: "object",
    properties: { type: { type: "string", enum: ["rectangle", "circle", "line", "arc", "slot", "polygon", "outline", "point"] } },
    required: ["type"],
    additionalProperties: true,
  },
};

const KIND_HELP: Record<FeatureKind, string> = {
  extrude: 'extrude: sketch (name; default the latest), depth, end ("blind" default | "symmetric" | "through_all" (right through, both ways) | "up_to_face" with up_to_face, up_to_part), flip (a "remove" cut on a face sketch goes into the part unless flip is given), second_depth (also extrude the other way), draft (°), areas ([[x,y],…] points inside the sketch areas to use; default every closed shape), operation',
  revolve: 'revolve: sketch, axis ("vertical" | "horizontal" — the sketch\'s axes through its origin — or {"from":[x,y],"to":[x,y]} naming a line drawn in the sketch), angle (° default 360), symmetric, flip, areas, operation',
  hole: 'hole: sketch (whose points and circle centres mark the holes — draw it on the face the holes start from, with add_sketch "on_face"), size ("M2"…"M12") with fit ("clearance" default | "tapped"), or diameter for a custom hole; style ("simple" | "counterbore" | "countersink"), end ("through_all" default | "blind" with depth), flip. Custom holes may set counterbore_diameter/counterbore_depth/countersink_diameter/countersink_angle',
  fillet: "fillet: edges (see edge choices), radius, end_radius (optional, a radius growing along the edge), part (default the latest)",
  chamfer: "chamfer: edges, distance, and optionally second_distance or angle (°), flip_side, part",
  shell: "shell: faces to leave open (empty list = hollow inside, closed), thickness, outside (walls grow outwards), part",
  linear_pattern: 'linear_pattern: features (names/ids of solid features such as an extrude cut or hole), direction ("x"|"y"|"z"), count (including the original), spacing, flip; for a grid also direction2, count2, spacing2, flip2',
  circular_pattern: 'circular_pattern: features, axis ("x"|"y"|"z", default "z"), count, angle (° spread over, default 360), center ([x,y,z] a point on the axis)',
  mirror: 'mirror: features (to copy across) or part (a whole part), plane ("Top"|"Front"|"Right"), offset (moves the plane along its normal), join (part only: join the copy on)',
  boolean: 'boolean: op ("union"|"subtract"|"intersect"), parts, tools (subtract: the cutters), keep_tools',
  box: "box: width (X), depth (Y), height (Z), x, y, z (its corner), operation",
  cylinder: "cylinder: diameter, height (Z), x, y, z (centre of its base), operation",
  sphere: "sphere: diameter, x, y, z (its centre), operation",
};

export const TOOLS: ToolDef[] = [
  {
    name: "format_guide",
    title: "How JuraCAD designs work",
    description: "Read this first: JuraCAD's units, axes, planes, and how sketches, features and face/edge choices work.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: () => say(FORMAT_GUIDE),
  },
  {
    name: "live_status",
    title: "Live with JuraCAD?",
    description:
      "Is Claude connected live to the user's open JuraCAD tab (they click \"Connect to Claude\" in JuraCAD's top bar)? When connected, every tool works on the design open there and changes appear in it straight away; otherwise the tools work on Claude's own copy and save_design saves a file.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: (s, a) => {
      noExtras(a, [], "live_status");
      return say(s.live ? s.live.status().text : "Live: this copy of the extension has no live link; the tools work on Claude's own copy of the design.");
    },
  },
  {
    name: "new_design",
    title: "Start a new design",
    description: "Start a new, empty design (the current one is dropped, so save it first if it matters). When live, this replaces the design open in the user's JuraCAD tab (they can undo it there), so only do it when they ask.",
    destructive: true,
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'The design\'s name, e.g. "Mounting bracket". Also the default file name.' },
        units: { type: "string", enum: ["mm", "in"], description: "Units the app shows (the tools always take millimetres unless you write e.g. \"1 in\"). Default mm." },
      },
      required: ["name"],
    },
    run: (s, a) => {
      noExtras(a, ["name", "units"], "new_design");
      const name = text(a.name, "name").slice(0, 80);
      const units = oneOf(a.units, ["mm", "in"] as const, "units", "mm");
      const doc = emptyDocument(name);
      if (units === "in") doc.units = "in";
      const wasUnsaved = s.unsaved;
      s.reset(doc, null);
      return say(`Started a new design, "${name}" (${units === "in" ? "shown in inches; sizes here are still millimetres unless written like \"1 in\"" : "millimetres"}).`, wasUnsaved && "(The previous design had unsaved changes; they were dropped.)", "Next: add_sketch, then add_feature.");
    },
  },
  {
    name: "add_sketch",
    title: "Draw a sketch",
    description:
      'Draw a 2D sketch on a plane ("Top" = XY, "Front" = XZ, "Right" = YZ, optionally moved by "offset" mm along its normal) or on a flat face of a part ("on_face": "top" = the outermost face facing +Z, likewise "bottom", "front", "back", "left", "right"; or "F3" from list_faces, or {"near":[x,y,z]}; with "part"). On a face the sketch origin is where the world origin lands on it and its axes are: top x=+X y=+Y; bottom x=−X y=+Y; front x=+X y=+Z; back x=−X y=+Z; right x=+Y y=+Z; left x=−Y y=+Z. Shapes are placed in the sketch\'s own x, y (mm) and dimensioned from its origin, so the sketch is fully defined and editable in the app. Then use add_feature (extrude, revolve, hole). ' +
      SHAPE_HELP.join("; "),
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: 'Optional name, e.g. "Base outline".' },
        plane: { type: "string", enum: ["Top", "Front", "Right"], description: "Default Top." },
        offset: { description: "Move the plane this far along its normal (mm). Top +10 = 10 mm up." },
        on_face: { description: 'Sketch on a flat face of a part instead: "top", "front"… or "F3" (see list_faces), or {"near":[x,y,z]}.' },
        part: { type: "string", description: "The part whose face it's on (default the latest part)." },
        shapes: SHAPES_SCHEMA,
      },
      required: ["shapes"],
    },
    run: (s, a) => {
      const ctx = context(s, null, false);
      const f = createFeature(s.doc, "sketch");
      const r = applySketch(f, a, ctx);
      if (a.name !== undefined) f.name = text(a.name, "name").slice(0, 80);
      const report = tryChange(s, addFeature(s.doc, f), f.id, "add the sketch");
      const free = r?.freedom ?? 0;
      return say(
        `Added ${f.name} [id ${f.id}] on ${planeLabel(f.sketch!.plane!)}: ${f.sketch!.data.curves.filter((c) => !c.construction).length} curves, ${f.sketch!.data.points.filter((p) => p.standalone).length} points.`,
        r && !r.dimensioned
          ? "It has too many points to dimension them all, so it isn't fully defined (fine for building; the app shows it in blue)."
          : free === 0
            ? "It's fully defined (every size and position is dimensioned)."
            : `It has ${free} way(s) still free to move (fine for building, but the app shows it in blue).`,
        `On this plane ${describePlane(f.sketch!.plane!)}.`,
        ...report,
      );
    },
  },
  {
    name: "add_feature",
    title: "Add a feature",
    description:
      `Add a feature to the design (built in order after the existing ones). "type" is one of ${Object.keys(FEATURE_KINDS).join(", ")}. "name" is optional. Settings by type:\n${Object.values(KIND_HELP).join("\n")}\n` +
      `Edge choices: ${PICK_HELP.edges}\nFace choices: ${PICK_HELP.faces}\nIf the feature fails to build, nothing is added and the reason is given.`,
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: Object.keys(FEATURE_KINDS) },
        name: { type: "string" },
        operation: { type: "string", enum: ["new", "add", "remove", "intersect"] },
      },
      required: ["type"],
      additionalProperties: true,
    },
    run: (s, a) => {
      const kind = oneOf(a.type, Object.keys(FEATURE_KINDS) as FeatureKind[], "type");
      const ctx = context(s, null, false);
      const f = createFeature(s.doc, FEATURE_KINDS[kind], undefined);
      if ((kind === "box" || kind === "cylinder" || kind === "sphere") && a.operation === undefined) {
        f.operation = s.build().parts.some((p) => !p.surface) ? "add" : "new";
      }
      applyFeature(f, kind, a, ctx);
      const report = tryChange(s, addFeature(s.doc, f), f.id, `add the ${kind.replace("_", " ")}`);
      return say(`Added ${f.name} [id ${f.id}]: ${summarize(f, s.doc)}.`, ...report);
    },
  },
  {
    name: "edit_feature",
    title: "Change a feature",
    description:
      'Change settings of an existing feature, given by "feature" (its name or id). Pass only what changes, using the same settings as add_feature (or, for a sketch, add_sketch: a new "shapes" list replaces the drawing; "plane"/"on_face" move it). Also "name" to rename it and "suppressed": true/false to switch it off/on. Faces and edges are chosen on the part as it is just before this feature. If the change would break the design, nothing changes and the reason is given.',
    inputSchema: {
      type: "object",
      properties: { feature: { type: "string", description: "Name or id, e.g. \"Extrude 1\"." }, name: { type: "string" }, suppressed: { type: "boolean" } },
      required: ["feature"],
      additionalProperties: true,
    },
    run: (s, a) => {
      const old = s.feature(a.feature, "feature");
      const at = s.doc.features.indexOf(old);
      const ctx = context(s, s.doc.features.slice(0, at), true);
      const f: Feature = structuredClone(old);
      if (f.type === "sketch") {
        applySketch(f, a, ctx);
        if (a.name !== undefined) f.name = text(a.name, "name").slice(0, 80);
        if (a.suppressed !== undefined) f.suppressed = !!a.suppressed;
      } else {
        const kind = KIND_OF[f.type];
        if (!kind) {
          const allowed = ["feature", "name", "suppressed"];
          noExtras(a, allowed, `edit_feature (${old.name} is a ${old.type}, made in the app; only these can be changed here)`);
          if (a.name !== undefined) f.name = text(a.name, "name").slice(0, 80);
          if (a.suppressed !== undefined) f.suppressed = !!a.suppressed;
        } else applyFeature(f, kind, a, ctx);
      }
      if (JSON.stringify(f) === JSON.stringify(old)) return say(`${old.name} already has those settings; nothing changed.`);
      const report = tryChange(s, replaceFeature(s.doc, f), f.id, `change ${old.name}`);
      // Sketches on faces stay where the face was when they were drawn (as in the app).
      const onFaces = s.doc.features.slice(at + 1).filter((x) => x.type === "sketch" && x.sketch?.plane?.kind === "face" && !x.sketch.plane.planeRef && / face of /.test(x.sketch.plane.label));
      return say(
        `Changed ${f.name}: ${summarize(f, s.doc)}.`,
        f.type === "sketch" && f.sketch?.plane && `On its plane ${describePlane(f.sketch.plane)}.`,
        onFaces.length > 0 && f.type !== "sketch" && `Note: ${onFaces.map((x) => x.name).join(", ")} ${onFaces.length > 1 ? "are" : "is"} drawn where a face was. If this change moved that face, put the sketch back on it with edit_feature {"feature": "<sketch>", "on_face": …}.`,
        ...report,
      );
    },
  },
  {
    name: "delete_feature",
    title: "Delete a feature",
    description: 'Delete a feature (by name or id). Refused, with the reason, if later features depend on it (delete or change those first).',
    inputSchema: { type: "object", properties: { feature: { type: "string" } }, required: ["feature"] },
    run: (s, a) => {
      noExtras(a, ["feature"], "delete_feature");
      const f = s.feature(a.feature, "feature");
      const users = s.doc.features.filter((x) => x.sketchRef === f.id || x.hole?.sketchRef === f.id || x.pattern?.sources.includes(f.id) || x.mirror?.sources.includes(f.id));
      if (users.length) throw new InputError(`${f.name} is used by ${users.map((u) => u.name).join(", ")}. Delete ${users.length > 1 ? "those" : "that"} first (or change ${users.length > 1 ? "them" : "it"} to use something else). Nothing was changed.`);
      const report = tryChange(s, removeFeature(s.doc, f.id), null, `delete ${f.name}`);
      return say(`Deleted ${f.name}.`, ...report);
    },
  },
  {
    name: "undo",
    title: "Undo",
    description: "Undo your last change to the design (one step each time). When live, only your own changes since the user last edited in JuraCAD can be undone here; the user can undo anything in the app.",
    inputSchema: { type: "object", properties: {} },
    run: (s) => {
      if (s.undo()) return say("Undone. The design is back as it was before the last change.", ...partsReport(s));
      if (s.live?.status().connected) return say("There's nothing of yours to undo since the user last changed the design in JuraCAD. (They can undo anything there with Undo, Ctrl+Z / ⌘Z.)");
      return say("There's nothing to undo.");
    },
  },
  {
    name: "set_variables",
    title: "Set variables",
    description:
      'Create or change named sizes (variables), e.g. [{"name":"thickness","value":"3"}]. Use them in any size as text, e.g. "thickness * 2". Changing one updates everything that uses it. Values may use earlier variables.',
    inputSchema: {
      type: "object",
      properties: { variables: { type: "array", items: { type: "object", properties: { name: { type: "string" }, value: {} }, required: ["name", "value"] } } },
      required: ["variables"],
    },
    run: (s, a) => {
      noExtras(a, ["variables"], "set_variables");
      const vars: Variable[] = [...(s.doc.variables ?? [])];
      list(a.variables, "variables").forEach((raw, i) => {
        const o = object(raw, `variables[${i}]`);
        noExtras(o, ["name", "value"], `variables[${i}]`);
        const name = text(o.name, `variables[${i}].name`);
        const value = typeof o.value === "number" ? String(o.value) : text(o.value, `variables[${i}].value`);
        const at = vars.findIndex((v) => v.name === name);
        if (at >= 0) vars[at] = { ...vars[at], value };
        else {
          const bad = checkName(name, vars.map((v) => v.name));
          if (bad) throw new InputError(`variables[${i}].name "${name}": ${bad}.`);
          vars.push({ id: newId("v"), name, value });
        }
      });
      const { errors, values: worked } = resolveVariables(vars);
      const huge = vars.filter((v) => worked[v.name] !== undefined && Math.abs(worked[v.name]) > MAX_LENGTH);
      if (huge.length) throw new InputError(`${huge.map((v) => `${v.name} would be ${r2(worked[v.name])}`).join("; ")} — too big. Sizes are in millimetres and can be at most ${MAX_LENGTH} mm (10 m). Nothing was changed.`);
      const bad = Object.entries(errors).map(([id, e]) => `${vars.find((v) => v.id === id)?.name}: ${e}`);
      if (bad.length) throw new InputError(`Those variables don't work out: ${bad.join("; ")}. Nothing was changed.`);
      const next = applyVariables(s.doc, vars);
      const report = tryChange(s, next, null, "change the variables");
      const values = resolveVariables(vars).values;
      return say(`Variables: ${vars.map((v) => `${v.name} = ${v.value}${String(values[v.name]) !== v.value ? ` (${r2(values[v.name])})` : ""}`).join(", ")}.`, ...report);
    },
  },
  {
    name: "rename_part",
    title: "Name a part",
    description: 'Give a part a name (shown in the app and in exported files), e.g. {"part":"Part 1","name":"Bracket"}.',
    inputSchema: { type: "object", properties: { part: { type: "string" }, name: { type: "string" } }, required: ["name"] },
    run: (s, a) => {
      noExtras(a, ["part", "name"], "rename_part");
      const p = s.part(s.build().parts, a.part, "part");
      const name = text(a.name, "name");
      s.commit(renamePart(s.doc, p.id, p.name, name));
      return say(`${p.name} is now called "${name}".`);
    },
  },
  {
    name: "describe_design",
    title: "Describe the design",
    description: "The design as it is now (when live, the one open in the user's JuraCAD tab): every feature (with ids and any problems in plain English), the variables, and each part's volume, size, position, face and edge counts, and whether it's a sound, closed solid.",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: (s) => {
      const b = s.build();
      const doc = s.doc;
      const checks = b.parts.length ? s.withEngine((e) => e.check("coarse")) : { parts: [], overlaps: [] };
      const live = s.live?.status();
      const lines = [
        live?.connected
          ? `Design "${doc.name}", open live in the user's JuraCAD tab (the Part Studio on show there).`
          : `Design "${doc.name}"${s.file ? `, file ${s.file}` : ", not saved yet"}${s.unsaved && s.file ? " (unsaved changes)" : ""}.`,
        doc.variables?.length ? `Variables: ${doc.variables.map((v) => `${v.name} = ${v.value}`).join(", ")}.` : null,
        doc.features.length ? `Features, in build order:\n${doc.features.map((f) => featureLine(f, doc, b.errors)).join("\n")}` : "No features yet.",
        (s.outer ? s.outer.doc.partStudios?.length : doc.partStudios?.length) ? `(The design also has ${s.outer ? `${s.outer.doc.partStudios!.length + 1} Part Studios in all; these tools work on the one on show and leave the others` : `${doc.partStudios!.length} more Part Studio(s), which these tools leave`} as they are.)` : null,
        b.parts.length ? "Parts:" : "No parts yet.",
        ...b.parts.map((p) => {
          const c = checks.parts.find((x) => x.partId === p.id);
          const sound = c ? (c.geometryValid === false ? "INVALID geometry" : c.surface ? "a surface (no inside)" : c.mesh.watertight ? `valid closed solid${c.mesh.pieces > 1 ? `, but in ${c.mesh.pieces} separate pieces` : ""}` : "NOT closed (has gaps)") : "";
          return `- ${partLine(p)}; ${sound}${c?.thinnest ? `; thinnest wall about ${r2(c.thinnest.thickness)} mm` : ""}`;
        }),
        checks.overlaps?.length ? `Overlapping parts: ${checks.overlaps.map((o) => `${o.a} and ${o.b} (${r1(o.volume)} mm³)`).join("; ")}.` : null,
        Object.keys(b.errors).length ? `Problems:\n${problems(s, b.errors).join("\n")}` : "No problems.",
      ];
      return say(...lines);
    },
  },
  {
    name: "list_faces",
    title: "List a part's faces",
    description: "Every face of a part, numbered F1, F2… with its kind, which way it faces, centre and area — to choose faces for sketches, shells and extrudes. Numbers change when the part changes.",
    inputSchema: { type: "object", properties: { part: { type: "string", description: "Default the latest part." } } },
    readOnly: true,
    run: (s, a) => {
      noExtras(a, ["part"], "list_faces");
      const p = s.part(s.build().parts, a.part, "part");
      return say(`${p.name} has ${p.faceRefs.length} faces:`, ...faceList(p).map(describeFace));
    },
  },
  {
    name: "list_edges",
    title: "List a part's edges",
    description: 'Every edge of a part, numbered E1, E2… with its kind, ends and length — to choose edges for fillets and chamfers. Optionally only those along an axis ("along": "x"|"y"|"z") or round ones ("along": "round"). Numbers change when the part changes.',
    inputSchema: { type: "object", properties: { part: { type: "string" }, along: { type: "string", enum: ["x", "y", "z", "round"] } } },
    readOnly: true,
    run: (s, a) => {
      noExtras(a, ["part", "along"], "list_edges");
      const p = s.part(s.build().parts, a.part, "part");
      const along = a.along === undefined ? null : oneOf(a.along, ["x", "y", "z", "round"] as const, "along");
      const edges = edgeList(p).filter((e) => {
        if (!along) return true;
        if (along === "round") return e.kind === "circle" || e.kind === "arc";
        if (e.kind !== "straight") return false;
        const k = "xyz".indexOf(along);
        const d = [0, 1, 2].map((i) => e.ref.b[i] - e.ref.a[i]);
        return Math.abs(d[k]) / (Math.hypot(...d) || 1) > 0.999;
      });
      const shown = edges.slice(0, 300);
      return say(`${p.name} has ${p.edgeRefs.length} edges${along ? `; ${edges.length} ${along === "round" ? "round" : `along ${along.toUpperCase()}`}` : ""}:`, ...shown.map(describeEdge), edges.length > shown.length && `…and ${edges.length - shown.length} more.`);
    },
  },
  {
    name: "get_views",
    title: "Look at the part",
    description: `A picture (PNG) of the parts from several directions, shaded with edges, to check the shape. Views: ${RENDER_VIEWS.join(", ")} (default iso, top, front, right). Each view has small X (red), Y (green), Z (blue) arrows.`,
    inputSchema: {
      type: "object",
      properties: {
        views: { type: "array", items: { type: "string", enum: [...RENDER_VIEWS] } },
        part: { type: "string", description: "Only this part (default all)." },
        size: { type: "number", description: "Pixels per view, 200–600 (default 360)." },
      },
    },
    readOnly: true,
    run: (s, a) => {
      noExtras(a, ["views", "part", "size"], "get_views");
      const b = s.build();
      if (!b.parts.length) throw new InputError("There's nothing to look at yet: no parts. Add a sketch and extrude it first.");
      const views = (a.views === undefined ? ["iso", "top", "front", "right"] : list(a.views, "views")).map((v, i) => oneOf(v, RENDER_VIEWS, `views[${i}]`)) as RenderView[];
      if (views.length > 6) throw new InputError("Ask for at most 6 views at a time.");
      const size = a.size === undefined ? 360 : Math.round(Number(a.size));
      if (!(size >= 200 && size <= 600)) throw new InputError("size must be between 200 and 600 pixels.");
      const parts = a.part !== undefined ? [s.part(b.parts, a.part, "part")] : b.parts;
      const colours: [number, number, number][] = [[176, 196, 222], [222, 190, 150], [170, 210, 170], [215, 170, 200]];
      const img = renderViews(parts.map((p, i) => ({ vertices: p.vertices, triangles: p.triangles, lines: p.lines, colour: colours[i % colours.length] })), views, size);
      return {
        content: [
          { type: "image", data: Buffer.from(img.png).toString("base64"), mimeType: "image/png" },
          { type: "text", text: `Views: ${img.layout}. All views share one scale; exact sizes are in describe_design. ${parts.map((p) => p.name).join(", ")}.` },
        ],
      };
    },
  },
  {
    name: "list_designs",
    title: "List saved designs",
    description: "The .juracad designs in the JuraCAD folder (newest first).",
    inputSchema: { type: "object", properties: {} },
    readOnly: true,
    run: (s) => {
      const folder = needFolder(s);
      const files = folder.list([FILE_EXTENSION, OLD_FILE_EXTENSION]);
      return say(`Folder: ${folder.root}`, files.length ? files.map((f) => `- ${f.name} (${Math.max(1, Math.round(f.bytes / 1024))} KB, ${f.modified.toISOString().slice(0, 16).replace("T", " ")})`).join("\n") : "No designs saved there yet.");
    },
  },
  {
    name: "save_design",
    title: "Save the design",
    description: 'Save the design as a .juracad file in the JuraCAD folder (the owner opens it in JuraCAD with Open). "filename" defaults to the design\'s name. An existing file other than the one this design came from is only replaced with "overwrite": true.',
    destructive: true,
    inputSchema: { type: "object", properties: { filename: { type: "string" }, overwrite: { type: "boolean" } } },
    run: (s, a) => {
      noExtras(a, ["filename", "overwrite"], "save_design");
      const folder = needFolder(s);
      const name = a.filename === undefined ? fileNameFor(s.doc.name) : text(a.filename, "filename");
      const path = folder.pathFor(name, [FILE_EXTENSION], "file");
      if (folder.exists(path) && path !== s.file && a.overwrite !== true) {
        throw new InputError(`There's already a file called "${path.split(/[\\/]/).pop()}" in ${folder.root}. Choose another filename, or pass "overwrite": true to replace it.`);
      }
      const b = s.build();
      // When live, the whole design open in JuraCAD (every Part Studio), not just the one worked on.
      folder.write(path, serializeDocument(s.wholeDoc()));
      s.file = path;
      s.saved = s.doc;
      const errs = Object.keys(b.errors).length;
      return say(`Saved to ${path}.`, errs ? `Note: ${errs} feature(s) have problems (see describe_design); they're saved as they are and show in red in the app.` : null, "Open it in JuraCAD (https://gm7dha.github.io/JuraCAD/) with Open in the top bar; every feature and dimension can be changed there.");
    },
  },
  {
    name: "open_design",
    title: "Open a design",
    description: "Open a .juracad (or older .partsmith) design from the JuraCAD folder, to look at or change it. The current design is replaced (save it first if it matters). When live, it opens in the user's JuraCAD tab, replacing what's there (they can undo it).",
    destructive: true,
    inputSchema: { type: "object", properties: { filename: { type: "string" } }, required: ["filename"] },
    run: (s, a) => {
      noExtras(a, ["filename"], "open_design");
      const folder = needFolder(s);
      const raw = text(a.filename, "filename");
      let path = folder.pathFor(raw, [FILE_EXTENSION, OLD_FILE_EXTENSION], "file");
      if (!folder.exists(path) && !/\.(juracad|partsmith)$/i.test(raw)) {
        const old = folder.pathFor(raw, [OLD_FILE_EXTENSION], "file");
        if (folder.exists(old)) path = old;
      }
      const name = path.split(/[\\/]/).pop()!;
      const r = readDocumentFile(folder.read(path), name);
      if (!r.ok) throw new InputError(r.error);
      if (!r.doc.name) r.doc.name = nameFromFileName(name);
      s.reset(r.doc, path);
      const b = s.build();
      return say(`Opened ${name}: "${r.doc.name}", ${r.doc.features.length} features.`, `Features:\n${r.doc.features.map((f) => featureLine(f, r.doc, b.errors)).join("\n") || "(none)"}`, ...partsReport(s));
    },
  },
  {
    name: "export_model",
    title: "Export for printing or making",
    description: 'Export the parts to the JuraCAD folder: "stl" or "3mf" for 3D printing, "step" (exact shapes) for other CAD programs and manufacturers. Optionally only one "part".',
    destructive: true,
    inputSchema: {
      type: "object",
      properties: { format: { type: "string", enum: ["stl", "3mf", "step"] }, filename: { type: "string" }, part: { type: "string" }, overwrite: { type: "boolean" } },
      required: ["format"],
    },
    run: async (s, a) => {
      noExtras(a, ["format", "filename", "part", "overwrite"], "export_model");
      const folder = needFolder(s);
      const format = oneOf(a.format, ["stl", "3mf", "step"] as const, "format");
      const b = s.build();
      if (!b.parts.length) throw new InputError("There's nothing to export yet: no parts.");
      const ids = a.part !== undefined ? [s.part(b.parts, a.part, "part").id] : [];
      const ext = format === "step" ? ".step" : `.${format}`;
      const path = folder.pathFor(a.filename === undefined ? fileNameFor(s.doc.name) : text(a.filename, "filename"), [ext], "file");
      if (folder.exists(path) && a.overwrite !== true) throw new InputError(`There's already a file called "${path.split(/[\\/]/).pop()}". Choose another filename, or pass "overwrite": true.`);
      const bytes = await s.withEngine(async (e) => {
        if (format === "stl") return new Uint8Array(e.exportStl(ids, "normal").stl);
        if (format === "3mf") return new Uint8Array(e.export3mf(ids, "normal", s.doc.name, s.doc.appearance ?? {}).data);
        return new Uint8Array((await e.exportStep(ids, s.doc.appearance ?? {})).step);
      });
      folder.write(path, bytes);
      return say(`Exported ${ids.length ? "the part" : `${b.parts.length} part(s)`} to ${path} (${Math.max(1, Math.round(bytes.length / 1024))} KB).`);
    },
  },
];

function needFolder(s: Session) {
  if (!s.folder) throw new InputError("No folder for designs is set up. In Claude, open Settings › Extensions › JuraCAD and choose a folder.");
  return s.folder;
}

/** Run a tool by name: problems with the input come back as a plain-English error for Claude to fix. */
export async function callTool(s: Session, name: string, args: unknown): Promise<ToolResult> {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) return { content: [{ type: "text", text: `There's no tool called "${name}". The tools are: ${TOOLS.map((t) => t.name).join(", ")}.` }], isError: true };
  const run = async (): Promise<ToolResult> => {
    try {
      const a = args === undefined || args === null ? {} : object(args, "The input");
      return await tool.run(s, a);
    } catch (e) {
      if (e instanceof InputError) return { content: [{ type: "text", text: e.message }], isError: true };
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text", text: `Something went wrong inside JuraCAD (${msg}). The design wasn't changed by this. Try describe_design, or a different approach.` }], isError: true };
    }
  };
  // Live: on the design open in the user's JuraCAD tab, with any change sent back to it.
  return s.live ? s.live.call(s, name, run) : run();
}

