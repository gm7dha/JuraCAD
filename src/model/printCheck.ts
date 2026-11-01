/**
 * 3D-print check, the pure parts: turning a part so a chosen direction points
 * down onto the bed, finding overhangs (faces that lean too far to print
 * without support), laying several parts out on the bed without overlapping,
 * and the plain-English report. The engine (src/kernel/printAnalysis.ts) does
 * the measuring on the real shape and calls these.
 *
 * "Down" is the direction, in the model, that points into the bed: a face laid
 * flat on the bed has its outside pointing down. The usual is -Z (the part
 * prints the way it's modelled, Z up).
 */
import type { PrintSettings } from "./printSettings";
import { minWallOf } from "./printSettings";

export type Vec3 = [number, number, number];

export const MODEL_DOWN: Vec3 = [0, 0, -1];

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: readonly number[], b: readonly number[]): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

export function unit(v: readonly number[]): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return l > 1e-12 ? [v[0] / l, v[1] / l, v[2] / l] : [0, 0, -1];
}

/**
 * A turn (3 × 3, row by row) that takes `down` to -Z: the smallest such turn,
 * so a part already the right way up isn't turned at all.
 */
export function bedRotation(down: readonly number[]): number[] {
  const d = unit(down);
  const target: Vec3 = [0, 0, -1];
  const c = dot(d, target);
  if (c > 1 - 1e-12) return [1, 0, 0, 0, 1, 0, 0, 0, 1];
  // Upside down: half a turn about X.
  if (c < -1 + 1e-12) return [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const k = unit(cross(d, target));
  const s = Math.sqrt(Math.max(0, 1 - c * c));
  const t = 1 - c;
  const [x, y, z] = k;
  return [
    t * x * x + c, t * x * y - s * z, t * x * z + s * y,
    t * x * y + s * z, t * y * y + c, t * y * z - s * x,
    t * x * z - s * y, t * y * z + s * x, t * z * z + c,
  ];
}

export function rotate(R: readonly number[], v: readonly number[]): Vec3 {
  return [R[0] * v[0] + R[1] * v[1] + R[2] * v[2], R[3] * v[0] + R[4] * v[1] + R[5] * v[2], R[6] * v[0] + R[7] * v[1] + R[8] * v[2]];
}

/** The part's size as it sits on the bed (X × Y × height), from its mesh corners. */
export function bedExtents(vertices: ArrayLike<number>, down: readonly number[]): { size: Vec3; min: Vec3; max: Vec3 } {
  const R = bedRotation(down);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < vertices.length; i += 3) {
    const p = rotate(R, [vertices[i], vertices[i + 1], vertices[i + 2]]);
    for (let k = 0; k < 3; k++) {
      if (p[k] < min[k]) min[k] = p[k];
      if (p[k] > max[k]) max[k] = p[k];
    }
  }
  if (!Number.isFinite(min[0])) return { size: [0, 0, 0], min: [0, 0, 0], max: [0, 0, 0] };
  return { size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], min, max };
}

export interface OverhangResult {
  /** Surface area that leans too far and needs support, mm². */
  area: number;
  /** Area resting on the bed, mm². */
  bedArea: number;
  /** The triangles (index into the mesh's triangle list) that need support. */
  triangles: number[];
  /** The triangles lying on the bed. */
  onBed: number[];
}

/**
 * Overhangs on a mesh (outward-facing triangles, as OpenCascade makes them):
 * a triangle needs support when it faces downwards and leans further than
 * `angle` degrees from upright — a sideways wall is 0°, a flat ceiling 90°.
 * Triangles lying on the bed (at the lowest level, facing straight down) are
 * held up by the bed, so they don't count.
 */
export function findOverhangs(vertices: ArrayLike<number>, triangles: ArrayLike<number>, down: readonly number[], angle: number, bedTolerance = 0.02): OverhangResult {
  const d = unit(down);
  const height = (i: number) => -(vertices[i * 3] * d[0] + vertices[i * 3 + 1] * d[1] + vertices[i * 3 + 2] * d[2]);
  let lowest = Infinity;
  for (let i = 0; i < vertices.length / 3; i++) lowest = Math.min(lowest, height(i));
  const limit = Math.sin((Math.max(0, Math.min(90, angle)) * Math.PI) / 180);
  const result: OverhangResult = { area: 0, bedArea: 0, triangles: [], onBed: [] };
  for (let t = 0; t + 2 < triangles.length; t += 3) {
    const [a, b, c] = [triangles[t], triangles[t + 1], triangles[t + 2]];
    const A = [vertices[a * 3], vertices[a * 3 + 1], vertices[a * 3 + 2]];
    const B = [vertices[b * 3], vertices[b * 3 + 1], vertices[b * 3 + 2]];
    const C = [vertices[c * 3], vertices[c * 3 + 1], vertices[c * 3 + 2]];
    const n = cross([B[0] - A[0], B[1] - A[1], B[2] - A[2]], [C[0] - A[0], C[1] - A[1], C[2] - A[2]]);
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-12) continue;
    const area = len / 2;
    const facingDown = dot(n, d) / len;
    if (facingDown <= limit + 1e-9) continue;
    const onBed = [a, b, c].every((i) => height(i) - lowest <= bedTolerance);
    if (onBed && facingDown > 0.999) {
      result.bedArea += area;
      result.onBed.push(t / 3);
    } else {
      result.area += area;
      result.triangles.push(t / 3);
    }
  }
  return result;
}

/** Chosen triangles as a flat list of corners (9 numbers each), for drawing. */
export function triangleSoup(vertices: ArrayLike<number>, triangles: ArrayLike<number>, chosen: readonly number[]): Float32Array {
  const out = new Float32Array(chosen.length * 9);
  chosen.forEach((t, k) => {
    for (let j = 0; j < 3; j++) {
      const v = triangles[t * 3 + j];
      out.set([vertices[v * 3], vertices[v * 3 + 1], vertices[v * 3 + 2]], k * 9 + j * 3);
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Laying parts out on the bed.

export interface BedItem {
  id: string;
  /** Footprint on the bed, X × Y mm (after it's turned down onto the bed). */
  size: [number, number];
}

export interface BedPlace {
  id: string;
  /** Centre of the footprint on the bed, mm from the bed's front-left corner. */
  x: number;
  y: number;
  /** Turned a quarter turn about Z to fit. */
  turned: boolean;
  /** On the bed (false: too big, or no room left — put beside it). */
  onBed: boolean;
}

export interface BedLayout {
  places: BedPlace[];
  /** Parts bigger than the bed whichever way round. */
  tooBig: string[];
  /** Parts that would fit alone but there wasn't room for with the others. */
  noRoom: string[];
}

/**
 * Lay parts out on a bed in rows (biggest first), `gap` mm apart, centred on
 * the bed. A part is turned a quarter turn when that's the only way it fits.
 * Parts that don't fit are placed in a row beside the bed, so nothing overlaps.
 */
export function arrangeOnBed(items: readonly BedItem[], bed: [number, number], gap: number): BedLayout {
  const tol = 1e-6;
  const order = items.map((it, i) => ({ it, i })).sort((a, b) => b.it.size[1] - a.it.size[1] || b.it.size[0] - a.it.size[0] || a.i - b.i);
  type Placed = { id: string; x0: number; y0: number; w: number; d: number; turned: boolean };
  const placed: Placed[] = [];
  const tooBig: string[] = [];
  const noRoom: string[] = [];
  let rowY = 0;
  let rowX = 0;
  let rowDepth = 0;
  for (const { it } of order) {
    const [w0, d0] = it.size;
    const fitsStraight = w0 <= bed[0] + tol && d0 <= bed[1] + tol;
    const fitsTurned = d0 <= bed[0] + tol && w0 <= bed[1] + tol;
    if (!fitsStraight && !fitsTurned) {
      tooBig.push(it.id);
      continue;
    }
    const tryPlace = (w: number, d: number): { x0: number; y0: number; newRow: boolean } | null => {
      if (rowX + w <= bed[0] + tol && rowY + d <= bed[1] + tol) return { x0: rowX, y0: rowY, newRow: false };
      const nextY = rowY + rowDepth + (rowDepth > 0 ? gap : 0);
      if (w <= bed[0] + tol && nextY + d <= bed[1] + tol) return { x0: 0, y0: nextY, newRow: true };
      return null;
    };
    let turned = false;
    let spot = fitsStraight ? tryPlace(w0, d0) : null;
    if (!spot && fitsTurned) {
      spot = tryPlace(d0, w0);
      turned = !!spot || !fitsStraight;
    }
    if (!spot) {
      noRoom.push(it.id);
      continue;
    }
    const [w, d] = turned ? [d0, w0] : [w0, d0];
    if (spot.newRow) {
      rowY = spot.y0;
      rowDepth = 0;
    }
    placed.push({ id: it.id, x0: spot.x0, y0: spot.y0, w, d, turned });
    rowX = spot.x0 + w + gap;
    rowDepth = Math.max(rowDepth, d);
  }
  // Centre the whole layout on the bed.
  const usedW = placed.reduce((m, p) => Math.max(m, p.x0 + p.w), 0);
  const usedD = placed.reduce((m, p) => Math.max(m, p.y0 + p.d), 0);
  const ox = (bed[0] - usedW) / 2;
  const oy = (bed[1] - usedD) / 2;
  const places: BedPlace[] = placed.map((p) => ({ id: p.id, x: ox + p.x0 + p.w / 2, y: oy + p.y0 + p.d / 2, turned: p.turned, onBed: true }));
  // What didn't fit goes in a row to the right of the bed.
  let x = bed[0] + Math.max(gap, 10);
  for (const id of [...tooBig, ...noRoom]) {
    const it = items.find((i) => i.id === id)!;
    places.push({ id, x: x + it.size[0] / 2, y: it.size[1] / 2, turned: false, onBed: false });
    x += it.size[0] + gap;
  }
  return { places: items.map((it) => places.find((p) => p.id === it.id)!), tooBig, noRoom };
}

// ---------------------------------------------------------------------------
// The report.

/** What the engine found on one part, as it would sit on the bed. */
export interface PrintPartResult {
  partId: string;
  name: string;
  /** The part is a surface (no inside): it can't be printed as it is. */
  surface?: boolean;
  /** X × Y × height on the bed, mm. */
  size: Vec3;
  overhangArea: number;
  bedArea: number;
  /** Thinnest wall found, mm (null: none measured). */
  thinnest: number | null;
  /** Where (in the model) the thinnest wall is. */
  thinnestAt: Vec3 | null;
  /** About how much surface lies on walls thinner than the minimum, mm². */
  thinArea: number;
  /** Some edges come to a sharp point (thin only at the tip: not counted as thin walls). */
  sharpEdges?: boolean;
  /** Round holes narrower than the smallest hole, by diameter (mm). */
  smallHoles: number[];
  /** Round pins/posts thinner than the smallest pin, by diameter (mm). */
  thinPins: number[];
  /** Triangles to light up (9 numbers per triangle, model mm). */
  marks: { overhang: Float32Array; bed: Float32Array; thin: Float32Array; small: Float32Array };
}

export type PrintLevel = "ok" | "warn" | "error";

export interface PrintFinding {
  level: PrintLevel;
  /** Which highlight colour the finding goes with. */
  kind: "overhang" | "thin" | "small" | "bed" | "fit" | "other";
  text: string;
}

export interface PrintPartReport {
  partId: string;
  name: string;
  level: PrintLevel;
  findings: PrintFinding[];
}

const worst = (levels: PrintLevel[]): PrintLevel => (levels.includes("error") ? "error" : levels.includes("warn") ? "warn" : "ok");

/**
 * The findings for one part, in plain English. `len` writes a length (in the
 * design's units), `area` an area; `bed` is the printer's build volume.
 */
export function printPartReport(
  r: PrintPartResult,
  settings: PrintSettings,
  bed: Vec3,
  len: (mm: number) => string,
  area: (mm2: number) => string,
): PrintPartReport {
  const findings: PrintFinding[] = [];
  if (r.surface) {
    findings.push({ level: "error", kind: "other", text: "This is a surface with no inside, so it can't be printed. Thicken it first (Surfaces › Thicken)." });
    return { partId: r.partId, name: r.name, level: "error", findings };
  }
  const tol = 1e-6;
  const over = r.size.map((v, i) => Math.max(0, v - bed[i]));
  const turnedFits = r.size[1] <= bed[0] + tol && r.size[0] <= bed[1] + tol && r.size[2] <= bed[2] + tol;
  if (over.every((v) => v <= tol)) {
    findings.push({ level: "ok", kind: "fit", text: `Fits on the bed (${r.size.map((v) => len(v)).join(" × ")}).` });
  } else if (turnedFits) {
    findings.push({ level: "ok", kind: "fit", text: `Fits on the bed turned a quarter turn (${r.size.map((v) => len(v)).join(" × ")}); the slicer file turns it for you.` });
  } else {
    const words = ["wide", "deep", "tall"];
    const too = over.map((v, i) => (v > tol ? `${len(v)} too ${words[i]}` : null)).filter(Boolean);
    findings.push({
      level: "error",
      kind: "fit",
      text: `Too big for the printer: ${too.join(", ")}. Try laying it on another face, pick a bigger printer, or split it into pieces (Split).`,
    });
  }
  if (r.bedArea <= tol) {
    findings.push({ level: "warn", kind: "bed", text: "Nothing flat rests on the bed this way up, so it may not stick. Click a flat face to lay it on, or add a brim in the slicer." });
  } else if (r.bedArea < 0.05 * r.size[0] * r.size[1] && r.size[2] > 3 * Math.sqrt(r.bedArea)) {
    findings.push({ level: "warn", kind: "bed", text: `Only ${area(r.bedArea)} rests on the bed and it stands tall — it could topple. Use a brim, or lay it on a bigger face.` });
  } else {
    findings.push({ level: "ok", kind: "bed", text: `${area(r.bedArea)} rests flat on the bed.` });
  }
  if (r.overhangArea > 1) {
    findings.push({
      level: "warn",
      kind: "overhang",
      text:
        `About ${area(r.overhangArea)} hangs over steeper than ${settings.overhangAngle}° (shown in orange). ` +
        "Short flat spans between two walls (bridges) and the tops of small sideways holes usually print fine without support; " +
        "for the rest, turn on supports in the slicer or try another face on the bed.",
    });
  } else {
    findings.push({ level: "ok", kind: "overhang", text: `No overhangs steeper than ${settings.overhangAngle}° — prints without support.` });
  }
  const minWall = minWallOf(settings);
  if (r.thinnest !== null && r.thinnest < minWall - 1e-6) {
    findings.push({
      level: r.thinnest < settings.nozzle ? "error" : "warn",
      kind: "thin",
      text:
        `Walls thinner than ${len(minWall)} (shown in red): the thinnest is about ${len(r.thinnest)}` +
        (r.thinnest < settings.nozzle ? `, narrower than the ${len(settings.nozzle)} nozzle, so the slicer may leave it out.` : ", which prints weak or patchy.") +
        " Make them thicker if you can.",
    });
  } else if (r.thinnest !== null) {
    findings.push({ level: "ok", kind: "thin", text: `Walls are at least ${len(minWall)} thick (the thinnest is about ${len(r.thinnest)}).` });
  }
  if (r.sharpEdges) {
    findings.push({ level: "ok", kind: "thin", text: "Some edges come to a sharp point. The very tip prints a little rounded, which is normal — not a weak wall." });
  }
  const list = (ds: number[]) => {
    const shown = [...new Set(ds.map((d) => len(d)))];
    return shown.length > 4 ? `${shown.slice(0, 4).join(", ")}…` : shown.join(", ");
  };
  if (r.smallHoles.length) {
    const n = r.smallHoles.length;
    findings.push({
      level: "warn",
      kind: "small",
      text: `${n === 1 ? "A hole" : `${n} holes`} narrower than ${len(settings.minHole)} (${list(r.smallHoles)}, shown in purple) may close up when printed. Make ${n === 1 ? "it" : "them"} bigger, or drill ${n === 1 ? "it" : "them"} out afterwards.`,
    });
  }
  if (r.thinPins.length) {
    const n = r.thinPins.length;
    findings.push({
      level: "warn",
      kind: "small",
      text: `${n === 1 ? "A pin or post" : `${n} pins or posts`} thinner than ${len(settings.minPin)} (${list(r.thinPins)}, shown in purple) may snap or wobble while printing.`,
    });
  }
  return { partId: r.partId, name: r.name, level: worst(findings.map((f) => f.level)), findings };
}

/** A one-line summary for several parts. */
export function printHeadline(reports: readonly PrintPartReport[]): { level: PrintLevel; text: string } {
  const level = worst(reports.map((r) => r.level));
  if (!reports.length) return { level: "ok", text: "Nothing to check." };
  if (level === "ok") return { level, text: reports.length === 1 ? "Ready to print." : `All ${reports.length} parts are ready to print.` };
  if (level === "warn") return { level, text: "Printable, with things to watch (below)." };
  return { level, text: "Problems found — fix these before printing (below)." };
}
