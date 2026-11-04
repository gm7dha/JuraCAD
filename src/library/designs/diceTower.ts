/**
 * A dice tower: drop dice in at the top; they tumble down sloping baffles inside, bouncing from one side to the other,
 * and roll out of an opening at the bottom of the front. Two side panels hold everything else — a back, a front (open
 * below), the baffles and a ramp at the bottom — by tabs through slots in the sides (sidePanels.ts).
 *
 * Seen side-on (x from the back to the front, z up): the back panel stands `m` in from the sides' back edge, the front
 * panel `m` in from their front edge, from just above the exit to the top. The ramp runs from the back panel down to
 * the front edge at RAMP_ANGLE; the baffles above it alternate — one from the front wall sloping down towards the
 * back, the next from the back sloping towards the front — each reaching across all but an opening a little wider
 * than the biggest die, so dice can't fall straight through. Each baffle's upper end just touches its wall at its
 * lower corner.
 */
import type { DesignValues, LibraryDesign, PreviewShape } from "../types";
import { assemblyFeatures, assemblyProblems, evenTabs, pieceFlat, sectionOf, sideSlots, type CrossPiece, type SideAssembly } from "../sidePanels";
import { r6, type P2 } from "../outlines";
import { mm, num } from "./common";

/** The exit ramp's slope (degrees): steep enough that dice roll out. */
export const RAMP_ANGLE = 25;
/** Openings (between a baffle's end and the wall, the exit) are this many times the biggest die. */
export const DIE_ROOM = 1.35;

const rad = (d: number) => (d * Math.PI) / 180;

export interface DiceTower {
  a: SideAssembly;
  /** The back and front panels' places (x of their inside faces), the depth inside, the front's bottom (z). */
  xa: number;
  xb: number;
  inside: number;
  exit: number;
  /** Each baffle's lowest free end (x, z of its top corner) and which way it slopes down (+1 = towards the front). */
  ends: { x: number; z: number; down: 1 | -1 }[];
}

/** A piece's cross-section from its top side's two ends (P higher, Q lower) — length, angle, middle. */
function fromTop(role: string, label: string, P: P2, Q: P2, t: number): CrossPiece {
  const [dx, dz] = [Q[0] - P[0], Q[1] - P[1]];
  const length = Math.hypot(dx, dz);
  // The angle of its length (any way along it; pieces are the same end to end), with its top side facing up.
  let angle = (Math.atan2(dz, dx) * 180) / Math.PI;
  if (angle > 90) angle -= 180;
  if (angle < -90) angle += 180;
  const n: P2 = [-Math.sin(rad(angle)), Math.cos(rad(angle))];
  const centre: P2 = [r6((P[0] + Q[0]) / 2 - (t / 2) * n[0]), r6((P[1] + Q[1]) / 2 - (t / 2) * n[1])];
  return { role, label, centre, angle: r6(angle), length: r6(length), tabs: evenTabs(length) };
}

export function diceTower(v: DesignValues): DiceTower {
  const [B, D, H, die, t, kerf] = ["width", "depth", "height", "die", "thickness", "kerf"].map((k) => num(v, k));
  const n = num(v, "baffles");
  const theta = num(v, "angle");
  const m = Math.max(5, t);
  const xa = m + t;
  const xb = D - m - t;
  const inside = xb - xa;
  const pieces: CrossPiece[] = [];
  pieces.push({ role: "back", label: "Back", centre: [r6(m + t / 2), r6(H / 2)], angle: 90, length: H, tabs: evenTabs(H) });
  // The ramp: its low end's top corner at the sides' front edge, the corner under it on the floor.
  const phi = rad(RAMP_ANGLE);
  const Q: P2 = [D - m, t * Math.cos(phi)];
  const Px = xa + t * Math.sin(phi);
  const P: P2 = [Px, Q[1] + (Q[0] - Px) * Math.tan(phi)];
  pieces.push(fromTop("ramp", "Ramp", P, Q, t));
  const rampTop = (x: number) => Q[1] + (Q[0] - x) * Math.tan(phi);
  const exit = r6(rampTop(xb) + DIE_ROOM * die);
  pieces.push({ role: "front", label: "Front", centre: [r6(xb + t / 2), r6((exit + H) / 2)], angle: 90, length: r6(H - exit), tabs: evenTabs(H - exit) });
  // The baffles, from the bottom up, their high ends evenly spaced between the ramp's and the top.
  const th = rad(theta);
  const reach = inside - DIE_ROOM * die;
  const top = H - 1.5 * die;
  const step = (top - P[1]) / n;
  const ends: DiceTower["ends"] = [];
  for (let i = 1; i <= n; i++) {
    const z = P[1] + i * step;
    const fromFront = i % 2 === 1;
    // Its high end's top corner, set so the corner under it just touches the wall; its low end reaching across.
    const hx = fromFront ? xb - t * Math.sin(th) : xa + t * Math.sin(th);
    const lx = fromFront ? xb - reach : xa + reach;
    const hi: P2 = [hx, z];
    const lo: P2 = [lx, z - Math.abs(hx - lx) * Math.tan(th)];
    pieces.push(fromTop(`baffle-${i}`, `Baffle ${i}`, hi, lo, t));
    ends.push({ x: lx, z: lo[1], down: fromFront ? -1 : 1 });
  }
  const side: P2[] = [
    [0, 0],
    [D, 0],
    [D, H],
    [0, H],
  ];
  return { a: { side, pieces, width: B, t, kerf }, xa, xb, inside, exit, ends };
}

/** The height of a piece's top side at x (null where it doesn't reach). */
function topAt(p: CrossPiece, t: number, x: number): number | null {
  const s = sectionOf(p, t);
  const [top0, top1] = [s[3], s[2]];
  const [x0, x1] = [Math.min(top0[0], top1[0]), Math.max(top0[0], top1[0])];
  if (x < x0 - 1e-9 || x > x1 + 1e-9 || Math.abs(top1[0] - top0[0]) < 1e-9) return null;
  return top0[1] + ((x - top0[0]) / (top1[0] - top0[0])) * (top1[1] - top0[1]);
}

export function towerProblems(v: DesignValues): string[] {
  const [B, die, t, kerf] = ["width", "die", "thickness", "kerf"].map((k) => num(v, k));
  if (kerf >= t / 2) return [`A kerf allowance of ${mm(kerf)} is a lot for ${mm(t)} sheet — lasers usually burn away 0.1–0.3 mm.`];
  if (B < die * 1.5) return [`Make the inside at least ${mm(Math.ceil(die * 1.5))} wide for dice that big.`];
  const d = diceTower(v);
  if (d.inside < 3 * die) return [`The tower isn't deep enough for dice that big: make it at least ${mm(Math.ceil(3 * die + 2 * Math.max(5, t) + 2 * t))} deep.`];
  // Room for a die to drop past every baffle's free end onto whatever is below.
  const below = d.a.pieces.filter((p) => p.role === "ramp" || p.role.startsWith("baffle"));
  for (let i = 0; i < d.ends.length; i++) {
    const end = d.ends[i];
    const under = below[i];
    const floor = topAt(under, t, end.x) ?? 0;
    const bottom = end.z - t / Math.cos(rad(num(v, "angle")));
    if (bottom - floor < DIE_ROOM * die) return [`The baffles are too close together for dice that big: make the tower taller, or use fewer baffles.`];
  }
  if (d.exit > num(v, "height") / 2) return ["The tower is too short: make it taller."];
  return assemblyProblems(d.a);
}

const thickness = { key: "thickness", label: "Material thickness", kind: "length" as const, default: 3, min: 1.5, max: 10, help: "Measure your sheet: 3 mm plywood is often 2.8–3.2 mm." };
const kerf = { key: "kerf", label: "Kerf allowance", kind: "length" as const, default: 0, min: 0, max: 1, help: "How much your laser burns away (often 0.1–0.2 mm). Pieces are drawn this much bigger and slots this much smaller, so the tabs fit snugly." };

export const diceTowerDesign: LibraryDesign = {
  id: "dice-tower",
  name: "Dice tower",
  group: "Toys and gifts",
  description:
    "Drop dice in at the top: they tumble down sloping baffles inside and roll out of the opening at the bottom of the front. Two sides hold the back, the front, the baffles and the ramp with tabs through slots — glue it, or leave it as a push-fit. Shown put together.",
  category: "laser",
  prefix: "dice",
  icon: '<path d="M14 4h20v40H14z"/><path d="M14 16l14 6M34 24l-14 6M14 34l20 8" opacity=".7"/><rect x="36" y="36" width="8" height="8" rx="1.5"/>',
  inputs: [
    { key: "width", label: "Inside width", kind: "length", default: 70, min: 30, max: 280, help: "Between the two sides." },
    { key: "depth", label: "Depth", kind: "length", default: 90, min: 50, max: 280, help: "Front to back, outside." },
    { key: "height", label: "Height", kind: "length", default: 200, min: 100, max: 580 },
    { key: "die", label: "Biggest die", kind: "length", default: 22, min: 8, max: 50, help: "A standard die is 16 mm; a D20 about 22 mm." },
    { key: "baffles", label: "Baffles", kind: "count", default: 2, min: 1, max: 5, help: "Slopes inside, besides the ramp at the bottom." },
    { key: "angle", label: "Baffle slope", kind: "count", default: 40, min: 30, max: 60, help: "Degrees from level." },
    thickness,
    kerf,
  ],
  problems: towerProblems,
  summary: (v) => {
    const d = diceTower(v);
    return `${d.a.pieces.length + 2} pieces: 2 sides, back, front, ramp and ${num(v, "baffles")} baffle${num(v, "baffles") === 1 ? "" : "s"}; the exit is ${mm(d.exit)} high.`;
  },
  make: (ctx) => assemblyFeatures(ctx, diceTower(ctx.values).a),
  preview: (v) => {
    if (towerProblems(v).length) return [];
    const d = diceTower(v);
    const out: PreviewShape[] = [{ kind: "poly", closed: true, points: d.a.side }];
    for (const p of d.a.pieces) out.push({ kind: "poly", closed: true, points: sectionOf(p, d.a.t), faint: true });
    for (const s of sideSlots(d.a)) out.push({ kind: "poly", closed: true, points: s });
    out.push({ kind: "text", at: [num(v, "depth") / 2, -10], text: "side" });
    // The pieces laid flat beside it.
    let y = 0;
    const x0 = num(v, "depth") + 20;
    for (const p of d.a.pieces) {
      const flat = pieceFlat(p, d.a);
      const w = d.a.width + 2 * d.a.t;
      out.push({ kind: "poly", closed: true, points: flat.map(([a, b]) => [x0 + w / 2 + b, y - p.length / 2 - a] as P2) });
      y -= p.length + 8;
    }
    return out;
  },
};
