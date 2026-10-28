/**
 * A picture (PNG) of a drawing sheet for Claude to look at: the same line
 * and text shapes the PDF, SVG and DXF files are made from (drawing/sheet.ts),
 * drawn into pixels — visible lines thick, hidden lines dashed grey, centre
 * lines dash-dot, text in a small pixel font.
 */
import { LINE_STYLES, type LineStyle, type Prim } from "../drawing/sheet";
import { glyph } from "./font5x7";
import { encodePng } from "./png";

const INK: Record<LineStyle, [number, number, number]> = {
  border: [0, 0, 0],
  visible: [0, 0, 0],
  hidden: [120, 120, 120],
  thin: [40, 40, 40],
  centre: [70, 110, 160],
};

class Paper {
  readonly rgb: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.rgb = new Uint8Array(width * height * 3).fill(255);
  }
  dot(x: number, y: number, c: readonly number[], r = 0) {
    const xi = Math.round(x);
    const yi = Math.round(y);
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const px = xi + dx;
        const py = yi + dy;
        if (px < 0 || py < 0 || px >= this.width || py >= this.height) continue;
        const i = (py * this.width + px) * 3;
        this.rgb[i] = c[0];
        this.rgb[i + 1] = c[1];
        this.rgb[i + 2] = c[2];
      }
  }
}

/** Draw the sheet: `prims` in sheet mm (y up), `size` the paper (mm), at most `width` pixels across. */
export function sheetPicture(prims: readonly Prim[], size: [number, number], width = 1400): { png: Uint8Array; width: number; height: number; pxPerMm: number } {
  const k = width / size[0];
  const W = Math.max(1, Math.round(size[0] * k));
  const H = Math.max(1, Math.round(size[1] * k));
  const paper = new Paper(W, H);
  const at = (x: number, y: number): [number, number] => [x * k, H - y * k];
  for (const p of prims) {
    if (p.kind === "path") drawPath(paper, p, at, k);
    else drawText(paper, p, at, k);
  }
  return { png: encodePng(W, H, paper.rgb), width: W, height: H, pxPerMm: k };
}

function drawPath(paper: Paper, p: Extract<Prim, { kind: "path" }>, at: (x: number, y: number) => [number, number], k: number) {
  const style = LINE_STYLES[p.style];
  const colour = INK[p.style];
  const radius = style.width * k >= 2.5 ? 1 : 0;
  const pts: [number, number][] = [];
  for (let i = 0; i + 1 < p.points.length; i += 2) pts.push(at(p.points[i], p.points[i + 1]));
  if (p.closed && pts.length > 2) pts.push(pts[0]);
  if (p.fill && pts.length > 2) fillPolygon(paper, pts, colour);
  // Dashes, measured along the line on paper (mm).
  const dash = style.dash?.map((d) => d * k);
  const period = dash ? dash.reduce((a, b) => a + b, 0) : 0;
  let travelled = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    const n = Math.max(1, Math.ceil(len));
    for (let s = 0; s <= n; s++) {
      const t = s / n;
      if (dash && period > 0 && !inDash(dash, (travelled + t * len) % period)) continue;
      paper.dot(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, colour, radius);
    }
    travelled += len;
  }
}

function inDash(dash: number[], along: number): boolean {
  let at = 0;
  for (let i = 0; i < dash.length; i++) {
    at += dash[i];
    if (along < at) return i % 2 === 0;
  }
  return true;
}

function fillPolygon(paper: Paper, pts: [number, number][], colour: readonly number[]) {
  const ys = pts.map((p) => p[1]);
  const y0 = Math.max(0, Math.floor(Math.min(...ys)));
  const y1 = Math.min(paper.height - 1, Math.ceil(Math.max(...ys)));
  for (let y = y0; y <= y1; y++) {
    const yc = y + 0.5;
    const xs: number[] = [];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) xs.push(ax + ((yc - ay) / (by - ay)) * (bx - ax));
    }
    xs.sort((a, b) => a - b);
    for (let j = 0; j + 1 < xs.length; j += 2) for (let x = Math.round(xs[j]); x <= Math.round(xs[j + 1]); x++) paper.dot(x, y, colour);
  }
}

function drawText(paper: Paper, p: Extract<Prim, { kind: "text" }>, at: (x: number, y: number) => [number, number], k: number) {
  // Capitals are about 0.72 of the text's size; the font is 7 pixels tall.
  const unit = Math.max(1, (p.size * k * 0.72) / 7);
  const chars = [...p.text];
  const advance = 6 * unit;
  const width = chars.length * advance - unit;
  const shift = p.anchor === "middle" ? -width / 2 : p.anchor === "end" ? -width : 0;
  const a = ((p.rotate ?? 0) * Math.PI) / 180;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const [ox, oy] = at(p.x, p.y);
  const colour = [0, 0, 0];
  chars.forEach((ch, n) => {
    const g = glyph(ch);
    for (let r = 0; r < 7; r++)
      for (let c = 0; c < 5; c++) {
        if (g[r][c] !== "1") continue;
        // Along the baseline (u) and up from it (v), in pixels; the glyph's bottom row sits on the baseline.
        for (let du = 0; du < unit; du += 1)
          for (let dv = 0; dv < unit; dv += 1) {
            const u = shift + n * advance + c * unit + du;
            const v = (6 - r) * unit + dv;
            // Turned anticlockwise on the paper (y down in pixels).
            paper.dot(ox + u * cos - v * sin, oy - (u * sin + v * cos), colour);
          }
      }
  });
}
