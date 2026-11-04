/**
 * More laser designs: a living-hinge panel (rows of short cuts that let
 * plywood bend), an involute gear and a layered picture frame.
 */
import { lit, minus, over, plus, times, type Ex } from "../ex";
import type { Pt } from "../fingers";
import { addLines } from "../laserKit";
import { extrudeFeature, moveFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import type { Feature } from "../../model/types";
import { mm, num, varsOf } from "./common";

const TOP = { kind: "default", name: "Top" } as const;
type P2 = [number, number];
const thickness = (def: number) => ({ key: "thickness", label: "Material thickness", kind: "length" as const, default: def, min: 0.5, max: 25, variable: true, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." });

// ---------------------------------------------------------------------------
// Living hinge

/** The hinge's cuts: upright lines in columns `spacing` apart across the bending zone, every other column offset half a step. */
export function hingeCuts(v: DesignValues): [P2, P2][] {
  const [h, zone, cut, gap, spacing] = ["depth", "zone", "cut", "gap", "spacing"].map((k) => num(v, k));
  const n = Math.floor(zone / spacing + 1e-9) + 1;
  const bottom = -h / 2 + gap;
  const top = h / 2 - gap;
  const step = cut + gap;
  const out: [P2, P2][] = [];
  for (let i = 0; i < n; i++) {
    const x = Math.round((-((n - 1) / 2) * spacing + i * spacing) * 1e6) / 1e6;
    const shift = i % 2 ? step / 2 : 0;
    for (let y = bottom - shift; y < top; y += step) {
      const a = Math.max(bottom, y);
      const b = Math.min(top, y + cut);
      if (b - a >= Math.min(2, cut / 3)) out.push([[x, Math.round(a * 1e6) / 1e6], [x, Math.round(b * 1e6) / 1e6]]);
    }
  }
  return out;
}

export const MAX_HINGE_CUTS = 3000;

export const livingHinge: LibraryDesign = {
  id: "living-hinge",
  name: "Living hinge panel",
  group: "Workshop",
  description:
    "A flat panel with rows of short cuts across its middle, so plywood or MDF bends there — for curved box corners, book covers and lamp shades. The cuts are blue (cut through). Export for laser: pick \"Panel sketch\". Thinner sheet and closer rows bend further.",
  category: "laser",
  prefix: "lhinge",
  icon: '<rect x="4" y="12" width="40" height="24" rx="1"/><path d="M18 15v8M18 27v6M22 12v0M22 19v10M26 15v8M26 27v6M30 19v10" />',
  inputs: [
    { key: "width", label: "Panel width", kind: "length", default: 150, min: 20, max: 580 },
    { key: "depth", label: "Panel height", kind: "length", default: 80, min: 15, max: 580, help: "Along the cuts." },
    { key: "zone", label: "Bending zone width", kind: "length", default: 40, min: 2, max: 580, help: "How wide the cut area is, in the middle of the panel." },
    { key: "cut", label: "Cut length", kind: "length", default: 20, min: 3, max: 300 },
    { key: "gap", label: "Gap between cuts", kind: "length", default: 3, min: 0.5, max: 50, help: "The uncut bits in each row; smaller bends more easily but is weaker." },
    { key: "spacing", label: "Row spacing", kind: "length", default: 1.6, min: 0.5, max: 20, help: "Between rows of cuts: about half your sheet's thickness is a good start." },
    thickness(3),
  ],
  problems: (v) => {
    const out: string[] = [];
    if (num(v, "zone") > num(v, "width") - 10) out.push(`The bending zone must be at least 10 mm narrower than the panel (at most ${mm(num(v, "width") - 10)}).`);
    if (num(v, "cut") > num(v, "depth") - 2 * num(v, "gap")) out.push(`The cuts are longer than the panel allows: at most ${mm(num(v, "depth") - 2 * num(v, "gap"))}.`);
    if (!out.length && hingeCuts(v).length > MAX_HINGE_CUTS) out.push(`That's over ${MAX_HINGE_CUTS} cuts: make the zone narrower or the rows further apart.`);
    return out;
  },
  summary: (v) => `${hingeCuts(v).length} cuts in ${Math.floor(num(v, "zone") / num(v, "spacing") + 1e-9) + 1} rows.`,
  make: (ctx) => {
    const [w, h] = [num(ctx.values, "width"), num(ctx.values, "depth")];
    const s = addLines(
      shapesSketch([{ type: "rectangle", center: [0, 0], width: w, height: h }], ctx.scope),
      hingeCuts(ctx.values).map(([a, b]) => ({ points: [a, b] })),
    );
    const panel = ctx.id("panel");
    return {
      features: [sketchFeature(ctx.id("sketch"), "Panel sketch", TOP, s), extrudeFeature(panel, "Panel", ctx.id("sketch"), { depth: ctx.vars.thickness, operation: "new" })],
      partNames: { [panel]: ctx.name },
    };
  },
  preview: (v) => {
    const [w, h] = [num(v, "width"), num(v, "depth")];
    return [
      { kind: "poly", closed: true, points: [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]] },
      ...hingeCuts(v).map(([a, b]): PreviewShape => ({ kind: "poly", points: [a, b] })),
    ];
  },
};

// ---------------------------------------------------------------------------
// Gear

const inv = (a: number) => Math.tan(a) - a;

export interface GearSizes {
  pitch: number;
  base: number;
  outside: number;
  root: number;
}

/** A spur gear's circles (radii, mm): pitch m·z/2, base (× cos pressure angle), outside (+ m), root (− 1.25 m). */
export function gearSizes(teeth: number, module: number, pressure: number): GearSizes {
  const pitch = (module * teeth) / 2;
  return { pitch, base: pitch * Math.cos((pressure * Math.PI) / 180), outside: pitch + module, root: pitch - 1.25 * module };
}

/** Half a tooth's angle at radius r (on the involute; r ≥ the base circle). */
function halfAngle(teeth: number, pressure: number, s: GearSizes, r: number): number {
  return Math.PI / (2 * teeth) + inv((pressure * Math.PI) / 180) - inv(Math.acos(Math.min(1, s.base / r)));
}

/** The gear's outline: involute flanks, flat-ish tips and roots as short straight pieces, anticlockwise. */
export function gearOutline(teeth: number, module: number, pressure: number, flankPoints = 6): P2[] {
  const s = gearSizes(teeth, module, pressure);
  const from = Math.max(s.base, s.root);
  const at = (r: number, a: number): P2 => [Math.round(r * Math.cos(a) * 1e6) / 1e6, Math.round(r * Math.sin(a) * 1e6) / 1e6];
  const out: P2[] = [];
  const rs = Array.from({ length: flankPoints }, (_, i) => from + ((s.outside - from) * i) / (flankPoints - 1));
  const tip = halfAngle(teeth, pressure, s, s.outside);
  const low = halfAngle(teeth, pressure, s, from);
  for (let k = 0; k < teeth; k++) {
    const c = (2 * Math.PI * k) / teeth;
    if (s.root < from) out.push(at(s.root, c - low));
    for (const r of rs) out.push(at(r, c - halfAngle(teeth, pressure, s, r)));
    out.push(at(s.outside, c - tip / 3), at(s.outside, c + tip / 3));
    for (const r of [...rs].reverse()) out.push(at(r, c + halfAngle(teeth, pressure, s, r)));
    if (s.root < from) out.push(at(s.root, c + low));
    // The root, across to the next tooth.
    const next = c + (2 * Math.PI) / teeth - low;
    for (const t of [1 / 3, 2 / 3]) out.push(at(s.root, c + low + (next - c - low) * t));
  }
  return out;
}

export const gear: LibraryDesign = {
  id: "gear",
  name: "Gear",
  group: "Workshop",
  description:
    "A spur gear with proper involute teeth, set by its number of teeth and module (tooth size: two gears mesh when their modules match; their centres are module × (teeth + teeth) ÷ 2 apart). Cut it from plywood or acrylic, or 3D print it — it's a flat plate.",
  category: "laser",
  prefix: "gear",
  icon: '<path d="M24 6l3 5 5-2 1 5 5 1-2 5 5 3-5 3 2 5-5 1-1 5-5-2-3 5-3-5-5 2-1-5-5-1 2-5-5-3 5-3-2-5 5-1 1-5 5 2z"/><circle cx="24" cy="24" r="4"/>',
  inputs: [
    { key: "teeth", label: "Teeth", kind: "count", default: 24, min: 8, max: 100 },
    { key: "module", label: "Module (tooth size)", kind: "length", default: 2, min: 0.5, max: 10, help: "Gears that mesh need the same module. 2 mm suits 3 mm plywood." },
    { key: "pressure", label: "Pressure angle", kind: "choice", default: "20", choices: [
      { value: "20", label: "20° (usual)" },
      { value: "14.5", label: "14.5° (older gears)" },
    ] },
    { key: "bore", label: "Middle hole", kind: "length", default: 6, min: 0, max: 200, help: "0 for none." },
    thickness(3),
  ],
  problems: (v) => {
    const s = gearSizes(num(v, "teeth"), num(v, "module"), Number(v.pressure));
    if (num(v, "bore") > 0 && num(v, "bore") > 2 * s.root - 2 * num(v, "module")) return [`The middle hole is too big: at most ${mm(2 * s.root - 2 * num(v, "module"))}.`];
    if (halfAngle(num(v, "teeth"), Number(v.pressure), s, s.outside) <= 0) return ["The teeth come to a point: use more teeth."];
    return [];
  },
  summary: (v) => {
    const s = gearSizes(num(v, "teeth"), num(v, "module"), Number(v.pressure));
    return `Pitch circle ${mm(2 * s.pitch)}, outside ${mm(2 * s.outside)}.`;
  },
  make: (ctx) => {
    const v = ctx.values;
    const bore = num(v, "bore");
    const base = bore > 0 ? shapesSketch([{ type: "circle", center: [0, 0], diameter: bore }], ctx.scope) : { points: [], curves: [], constraints: [] };
    const s = addLines(base, [{ points: gearOutline(num(v, "teeth"), num(v, "module"), Number(v.pressure)), closed: true }]);
    const id = ctx.id("gear");
    return { features: [sketchFeature(ctx.id("sketch"), "Gear sketch", TOP, s), extrudeFeature(id, "Gear", ctx.id("sketch"), { depth: ctx.vars.thickness, operation: "new" })], partNames: { [id]: ctx.name } };
  },
  preview: (v) => [
    { kind: "poly", closed: true, points: gearOutline(num(v, "teeth"), num(v, "module"), Number(v.pressure), 4) },
    ...(num(v, "bore") > 0 ? [{ kind: "circle", c: [0, 0], r: num(v, "bore") / 2 } as PreviewShape] : []),
  ],
};

// ---------------------------------------------------------------------------
// Picture frame

const FRAME_VARS = ["photoWidth", "photoHeight", "border", "overlap", "thickness"];
/** Room round the photo in the middle layer (mm each side), so it slides in. */
const SLIDE = 0.5;

function frameShapes(v: DesignValues, vars: Record<string, Ex> = varsOf(v, FRAME_VARS)) {
  const { photoWidth: pw, photoHeight: ph, border: b, overlap } = vars;
  const W = plus(pw, times(b, 2));
  const H = plus(ph, times(b, 2));
  const hw = over(W, 2);
  const hh = over(H, 2);
  const sw = plus(over(pw, 2), lit(SLIDE));
  const sh = plus(over(ph, 2), lit(SLIDE));
  const rect = (w: Ex, h: Ex): Pt[] => [
    [minus(lit(0), w), minus(lit(0), h)],
    [w, minus(lit(0), h)],
    [w, h],
    [minus(lit(0), w), h],
  ];
  // The middle layer: a U, open at the top, so the photo (and a clear sheet) slides in from above.
  const middle: Pt[] = [
    [minus(lit(0), hw), minus(lit(0), hh)],
    [hw, minus(lit(0), hh)],
    [hw, hh],
    [sw, hh],
    [sw, minus(lit(0), sh)],
    [minus(lit(0), sw), minus(lit(0), sh)],
    [minus(lit(0), sw), hh],
    [minus(lit(0), hw), hh],
  ];
  return { outer: rect(hw, hh), window: rect(minus(over(pw, 2), overlap), minus(over(ph, 2), overlap)), middle, W, H, hangAt: minus(hh, over(b, 2)) };
}

export const pictureFrame: LibraryDesign = {
  id: "picture-frame",
  name: "Picture frame",
  group: "Home",
  description:
    "A frame of three layers to glue together: the front with a window, a middle layer the photo slides into from the top, and a solid back with a hole to hang it on a nail. Shown stacked; Export for laser lays them out flat.",
  category: "laser",
  prefix: "frame",
  icon: '<rect x="8" y="6" width="32" height="36" rx="1"/><rect x="14" y="12" width="20" height="24"/><path d="M17 31l5-6 4 4 3-3 3 5" opacity=".6"/>',
  inputs: [
    { key: "photoWidth", label: "Photo width", kind: "length", default: 102, min: 20, max: 500, variable: true, help: "A 6 × 4 inch photo is 152 × 102 mm." },
    { key: "photoHeight", label: "Photo height", kind: "length", default: 152, min: 20, max: 500, variable: true },
    { key: "border", label: "Frame width", kind: "length", default: 20, min: 6, max: 150, variable: true, help: "How wide the frame is round the photo." },
    { key: "overlap", label: "Overlap", kind: "length", default: 4, min: 1, max: 30, variable: true, help: "How far the front covers the photo's edges." },
    { key: "hang", label: "Hanging hole", kind: "toggle", default: true },
    thickness(3),
  ],
  problems: (v) => {
    const out: string[] = [];
    if (num(v, "overlap") >= Math.min(num(v, "photoWidth"), num(v, "photoHeight")) / 3) out.push("The overlap is too big for the photo: the window would be tiny.");
    if (num(v, "overlap") >= num(v, "border")) out.push("The overlap must be less than the frame width.");
    return out;
  },
  summary: (v) => {
    const s = frameShapes(v);
    return `3 layers, ${mm(s.W.v)} × ${mm(s.H.v)} outside.`;
  },
  make: (ctx) => {
    const s = frameShapes(ctx.values, ctx.vars);
    const t = ctx.vars.thickness;
    const [back, middle, front] = ["back", "middle", "front"].map(ctx.id);
    let backSketch = outlineSketch(s.outer, ctx.scope);
    if (ctx.values.hang !== false) backSketch = joinOf(backSketch, shapesSketch([{ type: "circle", center: ["0", s.hangAt.t], diameter: 5 }], ctx.scope));
    const frontSketch = joinOf(outlineSketch(s.outer, ctx.scope), outlineSketch(s.window, ctx.scope));
    const features: Feature[] = [
      sketchFeature(ctx.id("back-sketch"), "Back sketch", TOP, backSketch),
      extrudeFeature(back, "Back", ctx.id("back-sketch"), { depth: t, operation: "new" }),
      sketchFeature(ctx.id("middle-sketch"), "Middle sketch", TOP, outlineSketch(s.middle, ctx.scope)),
      extrudeFeature(middle, "Middle", ctx.id("middle-sketch"), { depth: t, operation: "new" }),
      moveFeature(ctx.id("middle-up"), "Middle on the back", middle, { dz: t }),
      sketchFeature(ctx.id("front-sketch"), "Front sketch", TOP, frontSketch),
      extrudeFeature(front, "Front", ctx.id("front-sketch"), { depth: t, operation: "new" }),
      moveFeature(ctx.id("front-up"), "Front on top", front, { dz: times(t, 2) }),
    ];
    return { features, partNames: { [back]: `${ctx.name} back`, [middle]: `${ctx.name} middle`, [front]: `${ctx.name} front` } };
  },
  preview: (v) => {
    const s = frameShapes(v);
    const pts = (p: Pt[], dx: number) => p.map(([x, y]) => [x.v + dx, y.v] as P2);
    const gap = s.W.v + 10;
    return [
      { kind: "poly", closed: true, points: pts(s.outer, 0) },
      { kind: "poly", closed: true, points: pts(s.window, 0) },
      { kind: "text", at: [0, -s.H.v / 2 - 8], text: "front" },
      { kind: "poly", closed: true, points: pts(s.middle, gap) },
      { kind: "text", at: [gap, -s.H.v / 2 - 8], text: "middle" },
      { kind: "poly", closed: true, points: pts(s.outer, 2 * gap) },
      ...(v.hang !== false ? [{ kind: "circle", c: [2 * gap, s.hangAt.v], r: 2.5 } as PreviewShape] : []),
      { kind: "text", at: [2 * gap, -s.H.v / 2 - 8], text: "back" },
    ];
  },
};

function joinOf(a: { points: unknown[]; curves: unknown[]; constraints: unknown[] }, b: typeof a) {
  return { ...a, points: [...a.points, ...b.points], curves: [...a.curves, ...b.curves], constraints: [...a.constraints, ...b.constraints] } as ReturnType<typeof outlineSketch>;
}

/** For tests. */
export const frameShapesOf = (v: DesignValues) => frameShapes(v);
