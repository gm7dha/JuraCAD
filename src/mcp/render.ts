/**
 * Pictures of the parts for Claude to look at: each view drawn shaded with
 * its edges, from the same directions as JuraCAD's drawings (Z up; Front looks
 * from −Y, Right from +X, Top from +Z, iso from front-right-above). A small
 * software renderer, so it runs anywhere Node does.
 */
import { VIEW_CAMERAS } from "../drawing/cameras";
import type { ViewKind } from "../model/types";
import { encodePng } from "./png";

type V3 = [number, number, number];

export interface RenderPart {
  vertices: Float32Array | number[];
  triangles: Uint32Array | number[];
  /** Edge polylines as pairs of points (x, y, z, x, y, z…). */
  lines: Float32Array | number[];
  /** Fill colour, 0–255. */
  colour?: [number, number, number];
}

export const RENDER_VIEWS = ["iso", "top", "front", "right", "back", "left", "bottom"] as const;
export type RenderView = (typeof RENDER_VIEWS)[number];

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** 5 × 7 letters for the view names. */
const FONT: Record<string, string[]> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
};

class Canvas {
  readonly rgb: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgb = new Uint8Array(width * height * 3).fill(255);
  }
  set(x: number, y: number, c: readonly number[]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 3;
    this.rgb[i] = c[0];
    this.rgb[i + 1] = c[1];
    this.rgb[i + 2] = c[2];
  }
  line(x0: number, y0: number, x1: number, y1: number, c: readonly number[], test?: (x: number, y: number, t: number) => boolean) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const x = Math.round(x0 + (x1 - x0) * t);
      const y = Math.round(y0 + (y1 - y0) * t);
      if (!test || test(x, y, t)) this.set(x, y, c);
    }
  }
  text(x: number, y: number, s: string, c: readonly number[], scale = 2) {
    let at = x;
    for (const ch of s.toUpperCase()) {
      const g = FONT[ch] ?? FONT[" "];
      g.forEach((row, r) => {
        for (let k = 0; k < 5; k++) {
          if (row[k] !== "1") continue;
          for (let a = 0; a < scale; a++) for (let b = 0; b < scale; b++) this.set(at + k * scale + a, y + r * scale + b, c);
        }
      });
      at += 6 * scale;
    }
  }
}

const AXIS_COLOURS: Record<"X" | "Y" | "Z", [number, number, number]> = { X: [210, 40, 40], Y: [30, 150, 50], Z: [40, 80, 220] };
const DEFAULT_FILL: [number, number, number] = [176, 196, 222];
const EDGE: [number, number, number] = [35, 40, 50];

/**
 * Draw the parts from each view into one picture: the views side by side in
 * rows of two, each `size` pixels square. Returns the PNG file and where each
 * view is (for the description that goes with it).
 */
export function renderViews(parts: RenderPart[], views: readonly RenderView[], size = 400): { png: Uint8Array; width: number; height: number; layout: string } {
  const cols = views.length === 1 ? 1 : 2;
  const rows = Math.ceil(views.length / cols);
  const canvas = new Canvas(cols * size, rows * size);
  const where: string[] = [];
  // One scale for every view, so sizes can be compared between them.
  const span = Math.max(1e-6, ...views.map((v) => extent(parts, v).span));
  views.forEach((view, i) => {
    const ox = (i % cols) * size;
    const oy = Math.floor(i / cols) * size;
    drawView(canvas, parts, view, ox, oy, size, span);
    where.push(`${view} (${rows > 1 ? (Math.floor(i / cols) === 0 ? "top" : Math.floor(i / cols) === rows - 1 ? "bottom" : "middle") + " " : ""}${cols > 1 ? (i % cols === 0 ? "left" : "right") : ""})`.replace(" )", ")").replace("()", ""));
  });
  return { png: encodePng(canvas.width, canvas.height, canvas.rgb), width: canvas.width, height: canvas.height, layout: where.join(", ") };
}

function camera(view: RenderView) {
  const cam = VIEW_CAMERAS[view as ViewKind];
  const toward = cam.toward as V3;
  const right = cam.right as V3;
  return { toward, right, up: cross(toward, right) };
}

/** How far the parts reach across and up a view. */
function extent(parts: RenderPart[], view: RenderView) {
  const { right, up } = camera(view);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const p of parts) {
    for (let i = 0; i < p.vertices.length; i += 3) {
      const v: V3 = [p.vertices[i], p.vertices[i + 1], p.vertices[i + 2]];
      const x = dot(v, right), y = dot(v, up);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  }
  return { minX, maxX, minY, maxY, span: Number.isFinite(minX) ? Math.max(maxX - minX, maxY - minY) : 0 };
}

function drawView(canvas: Canvas, parts: RenderPart[], view: RenderView, ox: number, oy: number, size: number, span: number) {
  const { toward, right, up } = camera(view);
  const { minX, maxX, minY, maxY } = extent(parts, view);
  // Panel border and name.
  for (let k = 0; k < size; k++) {
    canvas.set(ox + k, oy, [215, 215, 215]);
    canvas.set(ox, oy + k, [215, 215, 215]);
  }
  canvas.text(ox + 8, oy + 8, view, [90, 90, 90]);
  drawTriad(canvas, right, up, ox + 34, oy + size - 34);
  if (!Number.isFinite(minX)) return;
  const margin = 40;
  const scale = (size - 2 * margin) / span;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = (v: V3) => ox + size / 2 + (dot(v, right) - cx) * scale;
  const sy = (v: V3) => oy + size / 2 - (dot(v, up) - cy) * scale;

  const depth = new Float32Array(size * size).fill(-Infinity);
  const light = unit([toward[0] + 0.4 * up[0] - 0.3 * right[0], toward[1] + 0.4 * up[1] - 0.3 * right[1], toward[2] + 0.4 * up[2] - 0.3 * right[2]]);
  for (const p of parts) {
    const fill = p.colour ?? DEFAULT_FILL;
    const V = (i: number): V3 => [p.vertices[3 * i], p.vertices[3 * i + 1], p.vertices[3 * i + 2]];
    for (let t = 0; t + 2 < p.triangles.length; t += 3) {
      const a = V(p.triangles[t]), b = V(p.triangles[t + 1]), c = V(p.triangles[t + 2]);
      const n = unit(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
      const shade = 0.45 + 0.55 * Math.abs(dot(n, light));
      const colour = fill.map((x) => Math.min(255, Math.round(x * shade)));
      const P = [a, b, c].map((v) => [sx(v) - ox, sy(v) - oy, dot(v, toward)]);
      const x0 = Math.max(0, Math.floor(Math.min(P[0][0], P[1][0], P[2][0])));
      const x1 = Math.min(size - 1, Math.ceil(Math.max(P[0][0], P[1][0], P[2][0])));
      const y0 = Math.max(0, Math.floor(Math.min(P[0][1], P[1][1], P[2][1])));
      const y1 = Math.min(size - 1, Math.ceil(Math.max(P[0][1], P[1][1], P[2][1])));
      const area = (P[1][0] - P[0][0]) * (P[2][1] - P[0][1]) - (P[2][0] - P[0][0]) * (P[1][1] - P[0][1]);
      if (Math.abs(area) < 1e-9) continue;
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5, py = y + 0.5;
          const w0 = ((P[1][0] - px) * (P[2][1] - py) - (P[2][0] - px) * (P[1][1] - py)) / area;
          const w1 = ((P[2][0] - px) * (P[0][1] - py) - (P[0][0] - px) * (P[2][1] - py)) / area;
          const w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          const z = w0 * P[0][2] + w1 * P[1][2] + w2 * P[2][2];
          const k = y * size + x;
          if (z <= depth[k]) continue;
          depth[k] = z;
          canvas.set(ox + x, oy + y, colour);
        }
      }
    }
  }
  // Edges, where they aren't hidden behind the part.
  const slack = span * 0.004 + 1e-3;
  for (const p of parts) {
    for (let i = 0; i + 5 < p.lines.length; i += 6) {
      const a: V3 = [p.lines[i], p.lines[i + 1], p.lines[i + 2]];
      const b: V3 = [p.lines[i + 3], p.lines[i + 4], p.lines[i + 5]];
      const za = dot(a, toward), zb = dot(b, toward);
      canvas.line(sx(a), sy(a), sx(b), sy(b), EDGE, (x, y, t) => {
        const lx = x - ox, ly = y - oy;
        if (lx < 0 || ly < 0 || lx >= size || ly >= size) return false;
        const z = za + (zb - za) * t;
        // Look at the pixel and its neighbours: an edge lies along the boundary of its faces.
        let best = -Infinity;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = lx + dx, yy = ly + dy;
          if (xx >= 0 && yy >= 0 && xx < size && yy < size) best = Math.max(best, depth[yy * size + xx]);
        }
        return z >= best - slack;
      });
    }
  }
}

/** Little X/Y/Z arrows in the corner, showing which way each axis points in this view. */
function drawTriad(canvas: Canvas, right: V3, up: V3, x: number, y: number) {
  const axes: ["X" | "Y" | "Z", V3][] = [["X", [1, 0, 0]], ["Y", [0, 1, 0]], ["Z", [0, 0, 1]]];
  for (const [name, d] of axes) {
    const dx = dot(d, right), dy = dot(d, up);
    const colour = AXIS_COLOURS[name];
    if (Math.hypot(dx, dy) < 0.15) {
      // Pointing straight at (or away from) the viewer: a dot.
      for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) canvas.set(x + a, y + b, colour);
      canvas.text(x + 5, y + 4, name, colour, 1);
      continue;
    }
    const ex = x + dx * 22, ey = y - dy * 22;
    canvas.line(x, y, ex, ey, colour);
    canvas.line(x + 1, y, ex + 1, ey, colour);
    canvas.text(Math.round(x + dx * 30) - 2, Math.round(y - dy * 30) - 3, name, colour, 1);
  }
}
