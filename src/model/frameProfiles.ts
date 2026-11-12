/**
 * Frame profiles (pure): the built-in cross-sections for Frame — aluminium extrusion, box section, angle, round tube,
 * flat bar and planed timber — as outlines in mm, x across and y up, centred on the middle of their outline's box.
 *
 * The aluminium extrusions are simplified: the outside and the T-slots are drawn (a slot's opening, its lip, the
 * 45° sides of the V and the slot's floor), the inside cavities of the real extrusion are left solid, so the
 * outline stays a few dozen straight edges (booleans stay quick) while the slots line up with real T-nuts. Sizes
 * follow the usual metric extrusions (OpenBuilds V-slot / Misumi HFS 20-series: 20 × 20 with a 6.2 mm opening, a
 * 1.8 mm lip and a Ø4.2 bore for an M5 tap; 30-series slot 8: 8.2 mm opening, Ø6.8 bore for M8; 40-series slot 8).
 * Weights come out close to the makers' (2020 ≈ 0.56 kg/m here; real ≈ 0.5).
 */
import type { FrameProfile, FrameProfileKind } from "./frameTypes";

export type P2 = [number, number];
export type ProfileLoop = { kind: "poly"; pts: P2[] } | { kind: "circle"; c: P2; r: number };
export interface ProfileRegion {
  outer: ProfileLoop;
  holes: ProfileLoop[];
}
export interface ProfileShape {
  regions: ProfileRegion[];
  /** The outside it fills, when that isn't just its outlines (an extrusion's square, slots and all): what copes and trims meet. */
  outline?: ProfileLoop[];
  /** "2020 aluminium extrusion", "40 × 40 × 2 box section"… */
  label: string;
}

/** Sizes for the "custom" choice (the feature's width / height / wall boxes). */
export interface CustomSize {
  width: number;
  height: number;
  wall: number;
}

interface SlotSeries {
  /** Slot opening, lip thickness, the cavity's widest half-width, its depth from the face, its floor's half-width. */
  open: number;
  lip: number;
  half: number;
  depth: number;
  floorHalf: number;
  bore: number;
}

const SLOT_20: SlotSeries = { open: 6.2, lip: 1.8, half: 5.0, depth: 6.1, floorHalf: 2.6, bore: 4.2 };
const SLOT_30: SlotSeries = { open: 8.2, lip: 2.2, half: 7.0, depth: 9.0, floorHalf: 3.1, bore: 6.8 };
const SLOT_40: SlotSeries = { open: 8.2, lip: 4.3, half: 8.0, depth: 12.2, floorHalf: 4.0, bore: 6.8 };

export interface ProfileSize {
  key: string;
  label: string;
}

/** The families and their sizes, in the order the dialog lists them. */
export const PROFILE_KINDS: { kind: FrameProfileKind; label: string; sizes: ProfileSize[]; custom?: string }[] = [
  {
    kind: "extrusion",
    label: "Aluminium extrusion (T-slot)",
    sizes: [
      { key: "2020", label: "2020 (20 × 20)" },
      { key: "2040", label: "2040 (20 × 40)" },
      { key: "3030", label: "3030 (30 × 30)" },
      { key: "4040", label: "4040 (40 × 40)" },
    ],
  },
  {
    kind: "box",
    label: "Box section (square or rectangular tube)",
    sizes: ["20x20x2", "25x25x2", "30x30x2", "40x40x2", "40x40x3", "50x50x3", "50x25x2", "60x40x3", "80x40x3", "100x50x4"].map((k) => ({ key: k, label: times(k) })),
    custom: "Width × height × wall",
  },
  {
    kind: "angle",
    label: "Angle (L)",
    sizes: ["20x20x3", "25x25x3", "30x30x3", "40x40x4", "50x50x5", "50x30x5"].map((k) => ({ key: k, label: times(k) })),
    custom: "Width × height × thickness",
  },
  {
    kind: "tube",
    label: "Round tube",
    sizes: ["16x1.5", "20x2", "25x2", "32x2", "42.4x3.2"].map((k) => ({ key: k, label: `Ø${k.replace("x", " × ")}` })),
    custom: "Outside diameter × wall",
  },
  {
    kind: "flat",
    label: "Flat bar",
    sizes: ["20x3", "25x5", "30x5", "40x5", "50x6"].map((k) => ({ key: k, label: times(k) })),
    custom: "Width × thickness",
  },
  {
    kind: "timber",
    label: "Timber (planed)",
    sizes: ["18x44", "34x44", "44x44", "34x69", "44x69", "38x63", "44x94"].map((k) => ({ key: k, label: times(k) })),
    custom: "Width × height",
  },
];

function times(key: string): string {
  return key.split("x").join(" × ");
}

const KIND_WORD: Record<FrameProfileKind, string> = {
  extrusion: "aluminium extrusion",
  box: "box section",
  angle: "angle",
  tube: "round tube",
  flat: "flat bar",
  timber: "timber",
};

const nums = (key: string) => key.split("x").map(Number);

/** The sizes offered for a family, and whether it takes custom sizes. */
export const kindInfo = (kind: FrameProfileKind) => PROFILE_KINDS.find((k) => k.kind === kind)!;

/** A family's first size (the default when the family is chosen). */
export const firstSize = (kind: FrameProfileKind) => kindInfo(kind).sizes[0].key;

const rect = (w: number, h: number, cx = 0, cy = 0): ProfileLoop => ({
  kind: "poly",
  pts: [
    [cx - w / 2, cy - h / 2],
    [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2],
    [cx - w / 2, cy + h / 2],
  ],
});

/**
 * One slot cut into a face, as points going along the face (anticlockwise round the whole outline): `at` is the
 * slot's middle on the face, `out` the face's outward normal and `along` the direction the outline runs there.
 */
function slotPoints(s: SlotSeries, at: P2, out: P2, along: P2): P2[] {
  const pt = (u: number, d: number): P2 => [at[0] + along[0] * u - out[0] * d, at[1] + along[1] * u - out[1] * d];
  const o = s.open / 2;
  const v = s.lip + (s.half - o); // where the 45° V reaches its widest
  return [
    pt(-o, 0),
    pt(-o, s.lip),
    pt(-s.half, v),
    pt(-s.floorHalf, s.depth),
    pt(s.floorHalf, s.depth),
    pt(s.half, v),
    pt(o, s.lip),
    pt(o, 0),
  ];
}

/** A T-slot extrusion `cols` × 20/30/40 wide and one cell high: slots on every face, a bore in each cell. */
function extrusion(cell: number, cols: number, s: SlotSeries): ProfileRegion {
  const W = cell * cols;
  const H = cell;
  const pts: P2[] = [];
  const xs = Array.from({ length: cols }, (_, i) => -W / 2 + cell / 2 + i * cell);
  // Anticlockwise: bottom (left → right), right side (up), top (right → left), left side (down).
  pts.push([-W / 2, -H / 2]);
  for (const x of xs) pts.push(...slotPoints(s, [x, -H / 2], [0, -1], [1, 0]));
  pts.push([W / 2, -H / 2]);
  pts.push(...slotPoints(s, [W / 2, 0], [1, 0], [0, 1]));
  pts.push([W / 2, H / 2]);
  for (const x of [...xs].reverse()) pts.push(...slotPoints(s, [x, H / 2], [0, 1], [-1, 0]));
  pts.push([-W / 2, H / 2]);
  pts.push(...slotPoints(s, [-W / 2, 0], [-1, 0], [0, -1]));
  return { outer: { kind: "poly", pts }, holes: xs.map((x) => ({ kind: "circle", c: [x, 0] as P2, r: s.bore / 2 })) };
}

/** Why custom sizes can't make a profile, or null. */
export function customProblem(kind: FrameProfileKind, size: CustomSize): string | null {
  const { width: w, height: h, wall: t } = size;
  if (!(w > 0)) return "The width must be more than 0.";
  if (kind === "tube") {
    if (!(t > 0) || t * 2 >= w) return "The wall must be more than 0 and less than half the diameter.";
    return null;
  }
  if (!(h > 0)) return "The height must be more than 0.";
  if ((kind === "box" || kind === "angle") && (!(t > 0) || (kind === "box" ? t * 2 >= Math.min(w, h) : t >= Math.min(w, h)))) {
    return kind === "box" ? "The wall must be more than 0 and less than half the narrower side." : "The thickness must be more than 0 and less than the narrower leg.";
  }
  return null;
}

/** The profile's outline for a built-in size (custom sizes from `custom`), or a plain message. */
export function builtInProfile(kind: FrameProfileKind, sizeKey: string, custom?: CustomSize): ProfileShape | string {
  const info = kindInfo(kind);
  let dims: number[];
  if (sizeKey === "custom") {
    if (!info.custom || !custom) return "This kind of profile only comes in the sizes listed.";
    const bad = customProblem(kind, custom);
    if (bad) return bad;
    dims = kind === "tube" ? [custom.width, custom.wall] : kind === "flat" || kind === "timber" ? [custom.width, custom.height] : [custom.width, custom.height, custom.wall];
  } else {
    if (!info.sizes.some((s) => s.key === sizeKey)) return `There's no ${sizeKey} ${KIND_WORD[kind]} in the list. Pick a size.`;
    dims = kind === "extrusion" ? [] : nums(sizeKey);
  }
  const label = (txt: string) => `${txt} ${KIND_WORD[kind]}`;
  switch (kind) {
    case "extrusion": {
      const cell = sizeKey === "3030" ? 30 : sizeKey === "4040" ? 40 : 20;
      const series = cell === 30 ? SLOT_30 : cell === 40 ? SLOT_40 : SLOT_20;
      const cols = sizeKey === "2040" ? 2 : 1;
      return { regions: [extrusion(cell, cols, series)], outline: [rect(cell * cols, cell)], label: label(sizeKey) };
    }
    case "box": {
      const [w, h, t] = dims;
      return { regions: [{ outer: rect(w, h), holes: [rect(w - 2 * t, h - 2 * t)] }], label: label(`${fmt(w)} × ${fmt(h)} × ${fmt(t)}`) };
    }
    case "angle": {
      const [w, h, t] = dims;
      const x0 = -w / 2;
      const y0 = -h / 2;
      const pts: P2[] = [
        [x0, y0],
        [x0 + w, y0],
        [x0 + w, y0 + t],
        [x0 + t, y0 + t],
        [x0 + t, y0 + h],
        [x0, y0 + h],
      ];
      return { regions: [{ outer: { kind: "poly", pts }, holes: [] }], label: label(`${fmt(w)} × ${fmt(h)} × ${fmt(t)}`) };
    }
    case "tube": {
      const [d, t] = dims;
      return { regions: [{ outer: { kind: "circle", c: [0, 0], r: d / 2 }, holes: [{ kind: "circle", c: [0, 0], r: d / 2 - t }] }], label: label(`Ø${fmt(d)} × ${fmt(t)}`) };
    }
    case "flat":
    case "timber": {
      const [w, h] = dims;
      return { regions: [{ outer: rect(w, h), holes: [] }], label: label(`${fmt(w)} × ${fmt(h)}`) };
    }
  }
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

/** The profile a frame uses, as a key for grouping the cut list ("box:40x40x2", "sketch:<id>"). */
export function profileKey(p: FrameProfile, custom?: CustomSize): string {
  if (p.kind === "sketch") return `sketch:${p.sketch}`;
  if (p.size === "custom" && custom) return `${p.kind}:${fmt(custom.width)}x${fmt(custom.height)}x${fmt(custom.wall)}`;
  return `${p.kind}:${p.size}`;
}

/** Area of a loop (positive). */
export function loopArea(l: ProfileLoop): number {
  if (l.kind === "circle") return Math.PI * l.r * l.r;
  let a = 0;
  for (let i = 0; i < l.pts.length; i++) {
    const p = l.pts[i];
    const q = l.pts[(i + 1) % l.pts.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) / 2;
}

/** The profile's cross-section area (mm²): outlines less holes. */
export function profileArea(s: ProfileShape): number {
  return s.regions.reduce((sum, r) => sum + loopArea(r.outer) - r.holes.reduce((h, l) => h + loopArea(l), 0), 0);
}

/** Every outline point of the profile (circles sampled `n` round), for measuring. */
export function profilePoints(s: ProfileShape, n = 64): P2[] {
  const out: P2[] = [];
  for (const r of s.regions) {
    const l = r.outer;
    if (l.kind === "poly") out.push(...l.pts);
    else for (let i = 0; i < n; i++) out.push([l.c[0] + l.r * Math.cos((2 * Math.PI * i) / n), l.c[1] + l.r * Math.sin((2 * Math.PI * i) / n)]);
  }
  return out;
}

/** The furthest the profile reaches along (a, b) (not normalised): max of a·x + b·y over it (exact for circles). */
export function reachAlong(s: ProfileShape, a: number, b: number): number {
  let best = -Infinity;
  for (const r of s.regions) {
    const l = r.outer;
    if (l.kind === "circle") best = Math.max(best, a * l.c[0] + b * l.c[1] + l.r * Math.hypot(a, b));
    else for (const p of l.pts) best = Math.max(best, a * p[0] + b * p[1]);
  }
  return best;
}

/** The outline's box: [minX, minY, maxX, maxY]. */
export function profileBox(s: ProfileShape): [number, number, number, number] {
  return [-reachAlong(s, -1, 0), -reachAlong(s, 0, -1), reachAlong(s, 1, 0), reachAlong(s, 0, 1)];
}

function mapLoop(l: ProfileLoop, f: (p: P2) => P2, flip: boolean): ProfileLoop {
  if (l.kind === "circle") return { kind: "circle", c: f(l.c), r: l.r };
  const pts = l.pts.map(f);
  return { kind: "poly", pts: flip ? pts.reverse() : pts };
}

/** The profile as it's placed on the path: the anchor point moved to (0, 0), mirrored left to right, then turned `angleDeg`. */
export function placedProfile(s: ProfileShape, anchor: string | undefined, mirror: boolean, angleDeg: number): ProfileShape {
  const [x0, y0, x1, y1] = profileBox(s);
  const a = anchor ?? "centre";
  const ax = a.endsWith("eft") || a === "left" ? x0 : a.endsWith("ight") || a === "right" ? x1 : (x0 + x1) / 2;
  const ay = a.startsWith("top") ? y1 : a.startsWith("bottom") ? y0 : (y0 + y1) / 2;
  const c = Math.cos((angleDeg * Math.PI) / 180);
  const sn = Math.sin((angleDeg * Math.PI) / 180);
  const f = (p: P2): P2 => {
    const x = (p[0] - ax) * (mirror ? -1 : 1);
    const y = p[1] - ay;
    return [x * c - y * sn, x * sn + y * c];
  };
  return {
    label: s.label,
    regions: s.regions.map((r) => ({ outer: mapLoop(r.outer, f, mirror), holes: r.holes.map((h) => mapLoop(h, f, mirror)) })),
    ...(s.outline ? { outline: s.outline.map((l) => mapLoop(l, f, mirror)) } : {}),
  };
}

export const ANCHORS: { key: string; label: string }[] = [
  { key: "centre", label: "Middle" },
  { key: "topLeft", label: "Top left corner" },
  { key: "top", label: "Middle of the top" },
  { key: "topRight", label: "Top right corner" },
  { key: "left", label: "Middle of the left side" },
  { key: "right", label: "Middle of the right side" },
  { key: "bottomLeft", label: "Bottom left corner" },
  { key: "bottom", label: "Middle of the bottom" },
  { key: "bottomRight", label: "Bottom right corner" },
];
