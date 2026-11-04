/** Fitting a design's preview drawing into a picture (pure; the dialog draws it as SVG). */
import type { PreviewShape } from "./types";

export interface PreviewPicture {
  viewBox: string;
  /** Line width and text size, in drawing units (mm), so they look the same at any size. */
  stroke: number;
  font: number;
  /** The shapes with y turned to point down, as SVG has it. */
  shapes: PreviewShape[];
}

export function previewPicture(shapes: PreviewShape[]): PreviewPicture | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of shapes) {
    if (s.kind === "poly") s.points.forEach(([x, y]) => (xs.push(x), ys.push(y)));
    else if (s.kind === "circle") xs.push(s.c[0] - s.r, s.c[0] + s.r), ys.push(s.c[1] - s.r, s.c[1] + s.r);
    else xs.push(s.at[0]), ys.push(s.at[1]);
  }
  if (!xs.length || ![...xs, ...ys].every(Number.isFinite)) return null;
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const size = Math.max(x1 - x0, y1 - y0, 1e-6);
  const pad = size * 0.06;
  const flip = (y: number) => -y;
  const out = shapes.map((s): PreviewShape => {
    if (s.kind === "poly") return { ...s, points: s.points.map(([x, y]) => [x, flip(y)]) };
    if (s.kind === "circle") return { ...s, c: [s.c[0], flip(s.c[1])] };
    return { ...s, at: [s.at[0], flip(s.at[1])] };
  });
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return {
    viewBox: `${r(x0 - pad)} ${r(-y1 - pad)} ${r(x1 - x0 + 2 * pad)} ${r(y1 - y0 + 2 * pad)}`,
    stroke: size / 250,
    font: size / 22,
    shapes: out,
  };
}
