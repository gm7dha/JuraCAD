/**
 * A cable chain (drag chain): links that snap together on pins and bend in one direction only, to guide the cables
 * of a printer's moving head, a CNC machine or a sliding desk. A set of links is laid out side by side, ready to print.
 *
 * One link, seen from the side (x along the chain, z up), its back joint at x = 0 and its front joint at x = pitch,
 * both at mid-height (z = R, R = half the link's height):
 *   - the middle (x = a … pitch − a) is the full width, with the cable channel cut through it between a bottom and a
 *     top bar;
 *   - behind it (back to the slanted back edge) only the *outer* layer of each side wall carries on, with a hole for
 *     the next link's pin;
 *   - in front only the *inner* layer carries on, ending in a half circle round the front joint, with a pin standing
 *     out of each side that has a 45° tip; the next link's outer layer has a lead-in ramp cut into its inside face
 *     (`reach` deep at its back edge, nothing at the hole), so pushing the links together slides the pins up the ramps,
 *     bends both layers apart (about half the reach each) and lets each pin click into its hole.
 * The two layers are `t` thick with the clearance c between them. The next link's outer layer turns round the pin,
 * clear of everything, until the top of its slanted back edge meets the end of this link's middle (the bend stop, at
 * `bend` degrees); its bottom corner sits just c behind it when the chain is straight, so it won't bend the other way.
 * With a = R + 4 the turning parts never meet anything else (checked by turning two links in engineLibraryPrint4).
 *
 * The links stand on the bed as they're used (bottom bar down); the top bar bridges the channel, the pins print
 * sideways, and the round front ends' undersides curve down to the bed like a cylinder lying on its side — a slight
 * overhang right at the bed that prints without supports. Sizes aren't variables: change them with Edit design sizes (the pins sit on fixed sketch planes).
 */
import { lit, type Ex } from "../ex";
import { copyFeature, extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import { fixedPlane, revolveFeature } from "../printKit";
import { joinSketches } from "../laserKit";
import type { Feature } from "../../model/types";
import type { Pt } from "../fingers";
import type { DesignValues, LibraryDesign, MakeContext, PreviewShape } from "../types";
import { mm, num, polygonArea, sixPlaces } from "./common";

const TOP = { kind: "default", name: "Top" } as const;
const FRONT = { kind: "default", name: "Front" } as const;
/** How far past the joint's radius the middle starts (mm). */
export const JOINT_ROOM = 4;
/** The middle's length, along the chain (mm). */
export const MIDDLE = 6;
/** The space between links as they're laid out (mm). */
export const LINK_GAP = 4;

const deg = Math.PI / 180;
const six = sixPlaces;

/** Every number a link is made from. */
export function chainPlan(v: DesignValues) {
  const [W, Hin, t, tb, c, bend] = ["width", "height", "wall", "bars", "clearance", "bend"].map((k) => num(v, k));
  const Ho = Hin + 2 * tb;
  const R = Ho / 2;
  const a = R + JOINT_ROOM;
  const pitch = 2 * a + MIDDLE;
  const pin = six(Math.min(6, Math.max(3, Ho * 0.3)));
  /** How far the pin reaches into the outer layer, and its 45° tip. */
  const reach = six(Math.min(t - 0.4, 1));
  const tip = six(reach / 3);
  const th = bend * deg;
  // The back edge's top is set so it meets the middle's end (x = −a from the joint) exactly at `bend`; its bottom
  // sits the clearance behind it.
  const backTop = six((a - R * Math.sin(th)) / Math.cos(th));
  const backBottom = six(a - c);
  const total = W + 4 * t + 2 * c;
  const base = { W, Hin, t, tb, c, bend, Ho, R, a, pitch, pin, reach, tip, backTop, backBottom, total, count: Math.max(1, Math.round(num(v, "count"))) };
  return { ...base, ramp: rampOf(base) };
}

/**
 * The lead-in ramp cut into each outer layer's inside face (the usual drag-chain snap): as wide as the pin's hole
 * (up and down, round the joint's height), `reach` deep where it meets the back edge and running out to nothing at the
 * hole's edge — so as the links are pushed together each pin slides up it, the layers bend apart a little at a time,
 * and the pin drops into its hole. `edge` is the back edge's x across the ramp's top (the slanted edge's furthest
 * forward there), `start` 1 mm behind it (the triangle is drawn on past the edge so the cut runs out cleanly).
 */
function rampOf(p: { R: number; pin: number; c: number; reach: number; backTop: number; backBottom: number; Ho: number }) {
  const half = p.pin / 2 + p.c;
  const z0 = p.R - half;
  const z1 = p.R + half;
  const edge = -p.backBottom + ((p.backBottom - p.backTop) * z1) / p.Ho;
  const hole = -half;
  const start = edge - 1;
  /** How deep the ramp is at x (from the joint, along the chain): `reach` at the edge, 0 at the hole. */
  const depthAt = (x: number) => Math.max(0, (p.reach * (hole - x)) / (hole - edge));
  return { z0: six(z0), height: six(2 * half), edge: six(edge), hole: six(hole), start: six(start), startDepth: six(depthAt(start)), depthAt };
}

/**
 * How far the next link can bend the wrong way before its back edge's bottom corner meets this link's middle
 * (degrees, negative: a couple of degrees of sag at most).
 */
export function sagAngle(p: ReturnType<typeof chainPlan>): number {
  const [x, z] = [p.backBottom, p.R];
  const rho = Math.hypot(x, z);
  return -(Math.atan2(z, x) - Math.acos(p.a / rho)) / deg;
}

/**
 * How far the side walls stretch as the links are pushed together and the outer layer rides over a pin: the outer
 * layer bends out and the inner layer in — two equal cantilevers `a` long and `t` thick, each taking half the pin's
 * reach — so 3 t (reach / 2) / 2 a² at their roots.
 */
export function snapStrain(p: ReturnType<typeof chainPlan>): number {
  return (3 * p.t * (p.reach / 2)) / (2 * p.a * p.a);
}

/** The tightest bend the chain makes (mm, to the middle of the links): the pitch over 2 tan(bend / 2). */
export const bendRadius = (p: ReturnType<typeof chainPlan>) => p.pitch / (2 * Math.tan((p.bend * deg) / 2));

/** The outer layer's outline behind the middle (x along, z up), reaching 0.5 into the middle. */
export function outerOutline(p: ReturnType<typeof chainPlan>): [number, number][] {
  return [
    [-p.backBottom, 0],
    [p.a + 0.5, 0],
    [p.a + 0.5, p.Ho],
    [-p.backTop, p.Ho],
  ];
}

const pts = (list: [number, number][]): Pt[] => list.map(([x, y]) => [lit(six(x)), lit(six(y))] as [Ex, Ex]);

function makeLink(ctx: MakeContext): { features: Feature[]; first: string } {
  const p = chainPlan(ctx.values);
  const id = ctx.id("link");
  const half = p.W / 2;
  const middle = p.pitch - 2 * p.a;
  const sk = (role: string, name: string, plane: Parameters<typeof sketchFeature>[2], data: Parameters<typeof sketchFeature>[3]) => sketchFeature(ctx.id(role), name, plane, data);
  // Side planes at y = `y`, looking along +y (sketch x = world x, sketch y = world z); extruding goes towards −y.
  const side = (label: string, y: number) => fixedPlane(label, [0, y, 0], [1, 0, 0], [0, 0, 1]);
  const outer = joinSketches(outlineSketch(pts(outerOutline(p)), ctx.scope), shapesSketch([{ type: "circle", center: ["0", String(six(p.R))], diameter: String(six(p.pin + 2 * p.c)) }], ctx.scope));
  const innerRect = () => shapesSketch([{ type: "rectangle", corner: [String(six(p.pitch - p.a - 0.5)), "0"], width: String(six(p.a + 0.5)), height: String(six(p.Ho)) }], ctx.scope);
  const innerEnd = () => shapesSketch([{ type: "circle", center: [String(six(p.pitch)), String(six(p.R))], diameter: String(six(p.Ho)) }], ctx.scope);
  const t = lit(p.t);
  // The ramps: triangles on a level plane at the ramp's bottom, cut up through the outer layer's inside face.
  const rampPlane = fixedPlane("Lead-in ramps", [0, 0, p.ramp.z0], [1, 0, 0], [0, 1, 0]);
  const face = half + p.t + p.c;
  // Drawn from 0.2 inside the gap, so the cut starts cleanly at the face; its slope meets the face exactly at the hole.
  const rampOutline = (s: 1 | -1): [number, number][] => [
    [p.ramp.start, s * (face - 0.2)],
    [p.ramp.hole, s * (face - 0.2)],
    [p.ramp.hole, s * face],
    [p.ramp.start, s * (face + p.ramp.startDepth)],
  ];
  const features: Feature[] = [
    sk("middle-sketch", "Middle sketch", TOP, shapesSketch([{ type: "rectangle", corner: [String(six(p.a)), String(six(-p.total / 2))], width: String(six(middle)), height: String(six(p.total)) }], ctx.scope)),
    extrudeFeature(id, "Link middle", ctx.id("middle-sketch"), { depth: lit(six(p.Ho)), operation: "new" }),
    sk("channel-sketch", "Cable channel sketch", FRONT, shapesSketch([{ type: "rectangle", corner: [String(six(p.a - 1)), String(six(p.tb))], width: String(six(middle + 2)), height: String(six(p.Hin)) }], ctx.scope)),
    extrudeFeature(ctx.id("channel"), "Cable channel", ctx.id("channel-sketch"), { depth: lit(six(p.W)), operation: "remove", end: "symmetric" }),
  ];
  for (const [s, name] of [[1, "left"], [-1, "right"]] as const) {
    // Outer layer (behind): from y = ±(W/2 + t + c) to ±(W/2 + 2t + c). Inner layer (in front): ±W/2 to ±(W/2 + t).
    const outerFace = s > 0 ? half + 2 * p.t + p.c : -(half + p.t + p.c);
    const innerFace = s > 0 ? half + p.t : -half;
    features.push(
      sk(`outer-${name}-sketch`, `Back of ${name} side sketch`, side(`Link ${name} outer`, six(outerFace)), outer),
      extrudeFeature(ctx.id(`outer-${name}`), `Back of ${name} side`, ctx.id(`outer-${name}-sketch`), { depth: t, operation: "add" }),
      sk(`ramp-${name}-sketch`, `Lead-in ramp, ${name} side sketch`, rampPlane, outlineSketch(pts(rampOutline(s)), ctx.scope)),
      extrudeFeature(ctx.id(`ramp-${name}`), `Lead-in ramp, ${name} side`, ctx.id(`ramp-${name}-sketch`), { depth: lit(p.ramp.height), operation: "remove" }),
      sk(`inner-${name}-sketch`, `Front of ${name} side sketch`, side(`Link ${name} inner`, six(innerFace)), innerRect()),
      extrudeFeature(ctx.id(`inner-${name}`), `Front of ${name} side`, ctx.id(`inner-${name}-sketch`), { depth: t, operation: "add" }),
      sk(`end-${name}-sketch`, `Round front of ${name} side sketch`, side(`Link ${name} inner`, six(innerFace)), innerEnd()),
      extrudeFeature(ctx.id(`end-${name}`), `Round front of ${name} side`, ctx.id(`end-${name}-sketch`), { depth: t, operation: "add" }),
    );
  }
  // The pins: spun round their own axis (the front joint, along y), on a plane through it.
  const r = p.pin / 2;
  const y0 = half + p.t - 0.5;
  const y2 = half + p.t + p.c + p.reach;
  const pin = (s: 1 | -1): [number, number][] => [
    [0, s * y0],
    [r, s * y0],
    [r, s * (y2 - p.tip)],
    [r - p.tip, s * y2],
    [0, s * y2],
  ];
  features.push(
    sk("pins-sketch", "Pins sketch", fixedPlane("Front joint", [six(p.pitch), 0, six(p.R)], [1, 0, 0], [0, 1, 0]), joinSketches(outlineSketch(pts(pin(1)), ctx.scope), outlineSketch(pts(pin(-1)), ctx.scope))),
    revolveFeature(ctx.id("pins"), "Pins", ctx.id("pins-sketch"), "add"),
  );
  return { features, first: id };
}

export const cableChain: LibraryDesign = {
  id: "cable-chain",
  name: "Cable chain (drag chain)",
  description:
    "A set of snap-together links for a cable chain, to guide the cables of a 3D printer's moving parts, a CNC machine or a sliding desk drawer. Choose the space inside for your cables and how many links; push each link onto the next: a ramp inside each side guides the pins until they click into their holes. The chain bends one way only, up to the angle you choose at each link, and stays straight the other way. The links print standing as they're used with no supports (the round front ends rest on the bed like a cylinder on its side) — PETG is a little springier than PLA for clicking them together.",
  category: "print",
  group: "Workshop",
  prefix: "chain",
  icon: '<path d="M4 30h10l4-4h12l4 4h10" opacity=".55"/><rect x="4" y="18" width="12" height="12" rx="6"/><rect x="18" y="18" width="12" height="12" rx="6"/><rect x="32" y="18" width="12" height="12" rx="6"/><circle cx="10" cy="24" r="1.6"/><circle cx="24" cy="24" r="1.6"/><circle cx="38" cy="24" r="1.6"/>',
  inputs: [
    { key: "width", label: "Inside width", kind: "length", default: 15, min: 5, max: 100, help: "The cable channel, across." },
    { key: "height", label: "Inside height", kind: "length", default: 10, min: 5, max: 60, help: "The cable channel, up and down." },
    { key: "count", label: "Links", kind: "count", default: 8, min: 2, max: 40 },
    { key: "bend", label: "Bend at each link", kind: "count", default: 30, min: 10, max: 45, help: "Degrees. Less bend = a gentler curve: the chain's tightest bend is shown below." },
    { key: "wall", label: "Side wall layers", kind: "length", default: 2, min: 1.6, max: 5, help: "Each side is two layers this thick (one from each link)." },
    { key: "bars", label: "Top and bottom bars", kind: "length", default: 2, min: 1.2, max: 6 },
    { key: "clearance", label: "Clearance", kind: "length", default: 0.3, min: 0.15, max: 0.8, help: "Between the links' layers, and round the pins." },
  ],
  problems: (v) => {
    const p = chainPlan(v);
    const out: string[] = [];
    if (snapStrain(p) > 0.02) out.push(`The side walls would have to bend too far to click over the pins: make the links taller or the walls thinner.`);
    if (p.R - (p.pin / 2 + p.c) < 1.5) out.push(`The links are too low for their pins: make the inside at least ${mm(2 * (p.pin / 2 + p.c + 1.5) - 2 * p.tb)} high.`);
    if (p.backTop < p.pin / 2 + p.c + 1.2) out.push(`At ${p.bend}° the back of each link would reach the pin hole: choose a smaller bend.`);
    if (p.count * (p.total + LINK_GAP) > 600) out.push("That many links won't fit side by side on a bed: make fewer at a time.");
    return out;
  },
  summary: (v) => {
    const p = chainPlan(v);
    return `${p.count} links, each ${mm(p.pitch)} from pin to pin and ${mm(p.total)} × ${mm(p.Ho)} outside. The chain bends up to ${p.bend}° a link (it curves no tighter than ${mm(Math.round(bendRadius(p)))} radius) and sags at most ${Math.round(-sagAngle(p) * 10) / 10}° the other way.`;
  },
  make: (ctx) => {
    const p = chainPlan(ctx.values);
    const { features, first } = makeLink(ctx);
    const partNames: Record<string, string> = { [first]: `${ctx.name}: link 1` };
    for (let i = 1; i < p.count; i++) {
      const id = ctx.id(`link${i + 1}`);
      features.push(copyFeature(id, `Link ${i + 1}`, first, { dy: lit(six(-i * (p.total + LINK_GAP))) }));
      partNames[id] = `${ctx.name}: link ${i + 1}`;
    }
    return { features, partNames };
  },
  preview: (v) => {
    // Two links from the side, joined, the second bent to its stop.
    const p = chainPlan(v);
    const out: PreviewShape[] = [];
    const link = (x0: number, th: number, faint: boolean) => {
      const rot = ([x, z]: [number, number]): [number, number] => [x0 + x * Math.cos(th) - (z - p.R) * Math.sin(th), p.R + x * Math.sin(th) + (z - p.R) * Math.cos(th)];
      const side: [number, number][] = [outerOutline(p)[0], [p.pitch - p.a, 0], [p.pitch, 0], [p.pitch, p.Ho], [p.pitch - p.a, p.Ho], outerOutline(p)[3]];
      out.push({ kind: "poly", closed: true, faint, points: side.map(rot) });
      out.push({ kind: "circle", c: rot([0, p.R]), r: p.pin / 2 });
    };
    link(0, 0, false);
    link(p.pitch, p.bend * deg, true);
    out.push({ kind: "text", at: [p.pitch / 2, -6], text: `${p.bend}° a link` });
    return out;
  },
};

/**
 * What one ramp takes out of its outer layer (mm³): at each height z across the ramp, the triangle from the slanted
 * back edge to the hole, depth reach × (hole − x) / (hole − edge) — quadratic in z, so Simpson's rule is exact.
 */
export function rampVolume(p: ReturnType<typeof chainPlan>): number {
  const r = p.ramp;
  const back = (z: number) => -p.backBottom + ((p.backBottom - p.backTop) * z) / p.Ho;
  const slice = (z: number) => (p.reach * (r.hole - back(z)) ** 2) / (2 * (r.hole - r.edge));
  const [z0, z1] = [r.z0, r.z0 + r.height];
  return ((z1 - z0) / 6) * (slice(z0) + 4 * slice((z0 + z1) / 2) + slice(z1));
}

/** For tests: one link's volume (mm³). */
export function linkVolume(v: DesignValues): number {
  const p = chainPlan(v);
  const middle = p.pitch - 2 * p.a;
  const r = p.pin / 2;
  const outer = polygonArea(outerOutline(p)) - 0.5 * p.Ho - Math.PI * (r + p.c) ** 2;
  const inner = p.a * p.Ho + (Math.PI * p.R * p.R) / 2;
  const cone = (Math.PI * p.tip * (r * r + r * (r - p.tip) + (r - p.tip) ** 2)) / 3;
  const pin = Math.PI * r * r * (p.c + p.reach - p.tip) + cone;
  return middle * p.total * p.Ho - middle * p.W * p.Hin + 2 * p.t * (outer + inner) + 2 * pin - 2 * rampVolume(p);
}
