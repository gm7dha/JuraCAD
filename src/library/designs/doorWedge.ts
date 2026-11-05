/**
 * Two small handy prints: a door wedge and a cable tie anchor.
 *
 * Door wedge: the side view (x along it from the thin nose, y up) drawn on Top and made `width` up, so it prints on
 * its side with nothing overhanging; small V grooves across the bottom grip the floor, and a hole near the thick end
 * hangs it on a hook. The shape's sizes are Edit design sizes (the grooves follow the length); the width is a variable.
 *
 * Cable tie anchor: a block with a tunnel through it for a zip tie, screwed down through the middle — the screw's
 * countersunk head sits in the tunnel's floor, reached through a hole in the roof, and the tie runs over it. It prints
 * as it stands: the tunnel's roof bridges the tie's width.
 */
import { lit } from "../ex";
import { countersunkHoleFeature, extrudeFeature, outlineSketch, shapesSketch, sketchFeature } from "../sketchKit";
import { levelPlane } from "../printKit";
import type { Feature } from "../../model/types";
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { fastenerSize } from "../../model/fasteners";
import { circleBand, countersunkHoleVolume, mm, num, polygonArea } from "./common";
import { circleShape, rectShape, type P2 } from "./printShapes";

const TOP = { kind: "default", name: "Top" } as const;
const RIGHT = { kind: "default", name: "Right" } as const;

// ---------------------------------------------------------------------------------------------------------------
// Door wedge

/** Grip grooves: how far apart, how deep, and how far from each end they stop. */
export const GROOVE = { pitch: 4, depth: 0.8, from: 8 };
/** The hang hole: across, and how far its middle is from the thick end. */
export const HANG = { d: 6, in: 10 };

export function wedgePlan(v: DesignValues) {
  const length = num(v, "length");
  const height = num(v, "height");
  const nose = num(v, "nose");
  const grooves = v.grip === false ? 0 : Math.max(0, Math.floor((length - 2 * GROOVE.from) / GROOVE.pitch));
  const heightAt = (x: number) => nose + ((height - nose) * x) / length;
  const hole = v.hang !== false ? { x: length - HANG.in, y: heightAt(length - HANG.in) / 2 } : null;
  return { length, height, nose, grooves, hole, heightAt, slope: (Math.atan((height - nose) / length) * 180) / Math.PI };
}

/** The wedge's side view, anticlockwise from the nose's bottom corner, with its grooves along the bottom. */
export function wedgeOutline(v: DesignValues): P2[] {
  const p = wedgePlan(v);
  const pts: P2[] = [[0, 0]];
  const start = (p.length - p.grooves * GROOVE.pitch) / 2;
  for (let i = 0; i < p.grooves; i++) {
    const x = start + i * GROOVE.pitch;
    pts.push([x, 0], [x + GROOVE.pitch / 2, GROOVE.depth]);
  }
  if (p.grooves) pts.push([start + p.grooves * GROOVE.pitch, 0]);
  pts.push([p.length, 0], [p.length, p.height], [0, p.nose]);
  return pts;
}

export const doorWedge: LibraryDesign = {
  id: "door-wedge",
  name: "Door wedge",
  description:
    "A door wedge (door stop) with grooves underneath that grip the floor, and a hole to hang it on a hook when it's not in use. Make it as wide and as tall as your door's gap needs. It prints lying on its side, so it's strong and needs no supports; PETG or TPU grips best.",
  category: "print",
  group: "Household",
  prefix: "wedge",
  icon: '<path d="M4 40h40V20L4 37z"/><circle cx="37" cy="31" r="2.5" opacity=".5"/>',
  inputs: [
    { key: "length", label: "Length", kind: "length", default: 120, min: 50, max: 250 },
    { key: "height", label: "Height at the thick end", kind: "length", default: 30, min: 10, max: 80, help: "A little more than the gap under your door." },
    { key: "nose", label: "Height at the thin end", kind: "length", default: 2, min: 1, max: 10, help: "The tip that slides under the door." },
    { key: "width", label: "Width", kind: "length", default: 40, min: 15, max: 120, variable: true },
    { key: "grip", label: "Grip grooves", kind: "toggle", default: true },
    { key: "hang", label: "Hang hole", kind: "toggle", default: true },
  ],
  problems: (v) => {
    const p = wedgePlan(v);
    const out: string[] = [];
    if (p.nose >= p.height) out.push("The thin end must be lower than the thick end.");
    if (p.nose <= GROOVE.depth + 0.5 && p.grooves) out.push(`With grip grooves the thin end must be at least ${mm(GROOVE.depth + 0.6)} high.`);
    if (p.hole && p.heightAt(p.length - HANG.in) < HANG.d + 6) out.push(`There's no room for the hang hole: make the thick end at least ${mm(Math.ceil(HANG.d + 6 + 1))} high, or turn the hole off.`);
    return out;
  },
  summary: (v) => {
    const p = wedgePlan(v);
    return `1 part, ${mm(p.length)} long, sloping ${Math.round(p.slope * 10) / 10}°${p.grooves ? `, ${p.grooves} grip grooves` : ""}.`;
  },
  make: (ctx) => {
    const p = wedgePlan(ctx.values);
    const id = ctx.id("wedge");
    const features: Feature[] = [
      sketchFeature(ctx.id("side"), "Wedge side", TOP, outlineSketch(wedgeOutline(ctx.values).map(([x, y]) => [lit(x), lit(y)]), ctx.scope)),
      extrudeFeature(id, "Wedge", ctx.id("side"), { depth: ctx.vars.width, operation: "new" }),
    ];
    if (p.hole)
      features.push(
        sketchFeature(ctx.id("hang-sketch"), "Hang hole sketch", TOP, shapesSketch([circleShape(p.hole.x, p.hole.y, HANG.d)], ctx.scope)),
        extrudeFeature(ctx.id("hang"), "Hang hole", ctx.id("hang-sketch"), { operation: "remove", end: "throughAll" }),
      );
    return { features, partNames: { [id]: ctx.name } };
  },
  preview: (v) => {
    const p = wedgePlan(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: wedgeOutline(v) }];
    if (p.hole) out.push({ kind: "circle", c: [p.hole.x, p.hole.y], r: HANG.d / 2 });
    return out;
  },
};

/** For tests: its volume (mm³). */
export function wedgeVolume(v: DesignValues): number {
  const p = wedgePlan(v);
  return (polygonArea(wedgeOutline(v)) - (p.hole ? (Math.PI * HANG.d * HANG.d) / 4 : 0)) * num(v, "width");
}

// ---------------------------------------------------------------------------------------------------------------
// Cable tie anchor

/** How much roof the tie must have over it each side of the screw's access hole (mm). */
export const TIE_ROOF = 4;

/** Screws from the fastener table (ISO 10642 countersunk heads): clearance hole and countersink for each. */
export function tieScrew(v: DesignValues): { d: number; head: number } | null {
  if (v.screw === "none") return null;
  const s = fastenerSize(String(v.screw)) ?? fastenerSize("M4")!;
  // Medium clearance holes (ISO 273): M3 3.4, M4 4.5; the countersink a little bigger than the head.
  return { d: s.d === 3 ? 3.4 : 4.5, head: s.countersunk.dk + 0.4 };
}

export function tiePlan(v: DesignValues) {
  const size = num(v, "size");
  const tie = num(v, "tie");
  const slot = num(v, "slot");
  const base = num(v, "base");
  const roof = num(v, "roof");
  const screw = tieScrew(v);
  /** The hole in the roof that the screw's head goes down through. */
  const access = screw ? screw.head + 0.6 : 0;
  return { size, tie, slot, base, roof, screw, access, height: base + slot + roof };
}

export const tieAnchor: LibraryDesign = {
  id: "tie-anchor",
  name: "Cable tie anchor",
  description:
    "A small block that screws to a desk, wall or shelf and holds cables with a zip tie: thread the tie through the tunnel, round the cables and pull tight. The screw goes in through the hole on top (its head sits flat in the tunnel's floor, under the tie), or leave the hole out and stick it down with double-sided tape. Prints as it stands, no supports.",
  category: "print",
  group: "Desk",
  prefix: "tie",
  icon: '<rect x="8" y="18" width="32" height="20" rx="2"/><path d="M4 26h40v6H4z" opacity=".5"/><circle cx="24" cy="23" r="3" opacity=".7"/>',
  inputs: [
    { key: "size", label: "Size", kind: "length", default: 20, min: 12, max: 40, help: "The square block's side." },
    { key: "tie", label: "Tie width", kind: "length", default: 5.5, min: 2.5, max: 10, help: "A little wider than your zip ties (most are 2.5, 3.6 or 4.8 mm)." },
    { key: "slot", label: "Tunnel height", kind: "length", default: 2, min: 1.2, max: 4, help: "A little more than the tie's thickness." },
    { key: "base", label: "Base thickness", kind: "length", default: 3, min: 2, max: 8 },
    { key: "roof", label: "Roof thickness", kind: "length", default: 2.4, min: 1.2, max: 6 },
    {
      key: "screw",
      label: "Screw",
      kind: "choice",
      default: "M4",
      choices: [
        { value: "M4", label: "4 mm countersunk" },
        { value: "M3", label: "3 mm countersunk" },
        { value: "none", label: "None (tape it down)" },
      ],
    },
  ],
  problems: (v) => {
    const p = tiePlan(v);
    const out: string[] = [];
    if (p.screw && p.base < (p.screw.head - p.screw.d) / 2 + 0.6) out.push(`The base must be at least ${mm((p.screw.head - p.screw.d) / 2 + 0.6)} thick for the screw's countersink.`);
    if (p.screw && (p.size - p.access) / 2 < TIE_ROOF) out.push(`Make it at least ${mm(p.access + 2 * TIE_ROOF)} across, so the tie runs under ${mm(TIE_ROOF)} of roof each side of the screw hole.`);
    if (p.tie > p.size - 4) out.push(`Make it at least ${mm(p.tie + 4)} across, wider than the tie.`);
    return out;
  },
  summary: (v) => {
    const p = tiePlan(v);
    return `1 part, ${mm(p.size)} square and ${mm(p.height)} high, with a ${mm(p.tie)} × ${mm(p.slot)} tunnel for the tie${p.screw ? ` and a hole for a ${v.screw} countersunk screw` : ""}.`;
  },
  make: (ctx) => {
    const p = tiePlan(ctx.values);
    const id = ctx.id("anchor");
    const features: Feature[] = [
      sketchFeature(ctx.id("block-sketch"), "Block sketch", TOP, shapesSketch([rectShape(-p.size / 2, -p.size / 2, p.size, p.size)], ctx.scope)),
      extrudeFeature(id, "Block", ctx.id("block-sketch"), { depth: lit(p.height), operation: "new" }),
      // Seen from the side (y across, z up), through the block along x.
      sketchFeature(ctx.id("tunnel-sketch"), "Tunnel sketch", RIGHT, shapesSketch([rectShape(-p.tie / 2, p.base, p.tie, p.slot)], ctx.scope)),
      extrudeFeature(ctx.id("tunnel"), "Tunnel", ctx.id("tunnel-sketch"), { depth: lit(p.size + 2), end: "symmetric", operation: "remove" }),
    ];
    if (p.screw) {
      const floor = levelPlane(`${mm(p.base)} up`, p.base);
      features.push(
        sketchFeature(ctx.id("access-sketch"), "Screw access sketch", floor, shapesSketch([circleShape(0, 0, p.access)], ctx.scope)),
        extrudeFeature(ctx.id("access"), "Screw access", ctx.id("access-sketch"), { depth: lit(p.slot + p.roof + 1), operation: "remove" }),
        sketchFeature(ctx.id("screw-sketch"), "Screw hole sketch", floor, shapesSketch([circleShape(0, 0, p.screw.d)], ctx.scope)),
        countersunkHoleFeature(ctx.id("screw"), "Screw hole", ctx.id("screw-sketch"), lit(p.screw.d), lit(p.screw.head)),
      );
    }
    return { features, partNames: { [id]: ctx.name } };
  },
  preview: (v) => {
    const p = tiePlan(v);
    const s = p.size / 2;
    const out: PreviewShape[] = [
      { kind: "poly", closed: true, points: [[-s, -s], [s, -s], [s, s], [-s, s]] },
      { kind: "poly", closed: true, faint: true, points: [[-s, -p.tie / 2], [s, -p.tie / 2], [s, p.tie / 2], [-s, p.tie / 2]] },
    ];
    if (p.screw) out.push({ kind: "circle", c: [0, 0], r: p.access / 2 }, { kind: "circle", c: [0, 0], r: p.screw.d / 2 });
    return out;
  },
};

/** For tests: its volume (mm³). */
export function tieAnchorVolume(v: DesignValues): number {
  const p = tiePlan(v);
  let vol = p.size * p.size * p.height - p.tie * p.slot * p.size;
  if (p.screw) {
    const r = p.access / 2;
    // The access hole, less the part of it already in the tunnel.
    const inTunnel = p.tie / 2 >= r ? Math.PI * r * r : 2 * circleBand(r, p.tie / 2);
    vol -= Math.PI * r * r * (p.slot + p.roof) - inTunnel * p.slot;
    vol -= countersunkHoleVolume(p.screw.d, p.screw.head, p.base);
  }
  return vol;
}
