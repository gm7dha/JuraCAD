/**
 * Laser files from a laid-out sheet (laser.ts): SVG (what Bambu Studio and
 * most laser programs open) and DXF, both at true size in millimetres, one
 * closed path per loop, each layer its own colour and named group / layer.
 * No title block, dimensions or hidden lines: only what the laser should do.
 */
import type { Pt, Segment } from "../sketch/regions";
import { arcInfo, LASER_LAYERS, LAYER_ORDER, pathPoints, segmentPoints, FLAT_TOLERANCE, type LaserPath, type LaserSheet } from "./laser";

/** Line width in the SVG (mm): a hairline, as laser programs expect for vector cuts. */
export const LASER_STROKE = 0.05;

const n = (v: number) => {
  const r = Math.round(v * 10000) / 10000;
  return String(Object.is(r, -0) ? 0 : r);
};
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The colour key, in words (also written into the SVG's description). */
export function colourKey(): string[] {
  return LAYER_ORDER.map((l) => `${LASER_LAYERS[l].colour} ${LASER_LAYERS[l].label}: ${LASER_LAYERS[l].hint}`);
}

/** One path's SVG drawing commands, in the file's coordinates (y down from the top edge). */
function svgPathData(path: LaserPath, H: number): string {
  const P = (p: Pt) => `${n(p[0])} ${n(H - p[1])}`;
  const out: string[] = [];
  let at: Pt | null = null;
  const moveTo = (p: Pt) => {
    if (!at || Math.hypot(at[0] - p[0], at[1] - p[1]) > 1e-9) out.push(`M${P(p)}`);
    at = p;
  };
  for (const s of path.segments) {
    switch (s.kind) {
      case "line":
        moveTo(s.from);
        out.push(`L${P(s.to)}`);
        at = s.to;
        break;
      case "arc": {
        moveTo(s.from);
        const a = arcInfo(s);
        if (!a) {
          out.push(`L${P(s.to)}`);
        } else if (Math.abs(Math.abs(a.turn) - 2 * Math.PI) < 1e-9) {
          // A whole turn: two halves (an SVG arc can't end where it starts).
          const opp: Pt = [2 * a.centre[0] - s.from[0], 2 * a.centre[1] - s.from[1]];
          const sweep = a.turn > 0 ? 0 : 1;
          out.push(`A${n(a.r)} ${n(a.r)} 0 0 ${sweep} ${P(opp)}`, `A${n(a.r)} ${n(a.r)} 0 0 ${sweep} ${P(s.to)}`);
        } else {
          // Seen with y down, anticlockwise on paper is SVG's sweep 0.
          const large = Math.abs(a.turn) > Math.PI ? 1 : 0;
          const sweep = a.turn > 0 ? 0 : 1;
          out.push(`A${n(a.r)} ${n(a.r)} 0 ${large} ${sweep} ${P(s.to)}`);
        }
        at = s.to;
        break;
      }
      case "bezier":
        moveTo(s.from);
        out.push(`C${P(s.c1)} ${P(s.c2)} ${P(s.to)}`);
        at = s.to;
        break;
      case "circle": {
        const a: Pt = [s.center[0] + s.radius, s.center[1]];
        const b: Pt = [s.center[0] - s.radius, s.center[1]];
        moveTo(a);
        out.push(`A${n(s.radius)} ${n(s.radius)} 0 0 0 ${P(b)}`, `A${n(s.radius)} ${n(s.radius)} 0 0 0 ${P(a)}`);
        at = a;
        break;
      }
      case "ellipse": {
        const c = Math.cos(s.angle), sn = Math.sin(s.angle);
        const a: Pt = [s.center[0] + s.rx * c, s.center[1] + s.rx * sn];
        const b: Pt = [s.center[0] - s.rx * c, s.center[1] - s.rx * sn];
        const deg = n((-s.angle * 180) / Math.PI);
        moveTo(a);
        out.push(`A${n(s.rx)} ${n(s.ry)} ${deg} 0 0 ${P(b)}`, `A${n(s.rx)} ${n(s.ry)} ${deg} 0 0 ${P(a)}`);
        at = a;
        break;
      }
      case "ellipseArc": {
        // (Only from sketch areas; laid-out sheets have them as Bézier pieces already.)
        const pts = segmentPoints(s);
        moveTo(pts[0]);
        for (const p of pts.slice(1)) out.push(`L${P(p)}`);
        at = s.to;
        break;
      }
    }
  }
  if (path.closed) out.push("Z");
  return out.join(" ");
}

/** A path as one SVG element: a lone circle as <circle>, everything else as one <path>. */
function svgElement(path: LaserPath, H: number, style: string): string {
  const only = path.segments.length === 1 ? path.segments[0] : null;
  if (only?.kind === "circle") return `<circle cx="${n(only.center[0])}" cy="${n(H - only.center[1])}" r="${n(only.radius)}" ${style}/>`;
  return `<path d="${svgPathData(path, H)}" ${style}/>`;
}

export interface LaserSvgOptions {
  title?: string;
  /** For showing on screen: lines a steady width however small the picture is drawn. */
  preview?: boolean;
}

/** An SVG of the sheet: width and height in mm, a viewBox in mm, so it opens at true size. */
export function laserSvg(sheet: LaserSheet, opts: LaserSvgOptions = {}): string {
  const [W, H] = sheet.size;
  const title = opts.title ?? "JuraCAD laser cut";
  const lines: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="${n(W)}mm" height="${n(H)}mm" viewBox="0 0 ${n(W)} ${n(H)}">`,
    `<title>${xml(title)}</title>`,
    `<desc>${xml(`Made in JuraCAD at true size (millimetres). ${colourKey().join(". ")}.`)}</desc>`,
  ];
  if (opts.preview) lines.push(`<rect x="0" y="0" width="${n(W)}" height="${n(H)}" fill="#ffffff"/>`);
  const stroke = opts.preview ? `stroke-width="1.2" vector-effect="non-scaling-stroke"` : `stroke-width="${LASER_STROKE}"`;
  for (const layer of LAYER_ORDER) {
    const paths = sheet.paths.filter((p) => p.layer === layer);
    if (!paths.length) continue;
    const info = LASER_LAYERS[layer];
    const id = info.dxf.toLowerCase().replace(/_/g, "-");
    lines.push(`<g id="${id}" inkscape:groupmode="layer" inkscape:label="${xml(info.label)}">`);
    if (layer === "engrave") {
      // Every engraved area in one filled shape: holes in letters (the inside of an "o") stay clear.
      const d = paths.map((p) => svgPathData({ ...p, closed: true }, H)).join(" ");
      lines.push(`<path d="${d}" fill="${info.colour}" fill-rule="evenodd" stroke="none"/>`);
    } else {
      const style = `fill="none" stroke="${info.colour}" ${stroke} stroke-linecap="round" stroke-linejoin="round"`;
      for (const p of paths) lines.push(svgElement(p, H, style));
    }
    lines.push(`</g>`);
  }
  lines.push(`</svg>`, "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DXF (AutoCAD R12: read by every laser and CAD program)

/** A path as polyline vertices with bulges (arcs stay exact; Bézier pieces and ellipses become short straight pieces). */
export function polylineOf(path: LaserPath, tol = FLAT_TOLERANCE): { p: Pt; bulge: number }[] {
  const out: { p: Pt; bulge: number }[] = [];
  const push = (p: Pt, bulge = 0) => {
    const last = out[out.length - 1];
    if (last && Math.hypot(last.p[0] - p[0], last.p[1] - p[1]) < 1e-9) {
      last.bulge = bulge;
      return;
    }
    out.push({ p, bulge });
  };
  for (const s of path.segments) {
    if (s.kind === "line") {
      push(s.from);
      push(s.to);
    } else if (s.kind === "arc") {
      const a = arcInfo(s);
      if (!a) {
        push(s.from);
        push(s.to);
        continue;
      }
      // A bulge covers less than a whole turn: split into halves when needed.
      const pieces = Math.abs(a.turn) > Math.PI * 1.5 ? 2 : 1;
      for (let k = 0; k < pieces; k++) {
        const t0 = a.a0 + (a.turn * k) / pieces;
        const t1 = a.a0 + (a.turn * (k + 1)) / pieces;
        const p0: Pt = k === 0 ? s.from : [a.centre[0] + a.r * Math.cos(t0), a.centre[1] + a.r * Math.sin(t0)];
        const p1: Pt = k === pieces - 1 ? s.to : [a.centre[0] + a.r * Math.cos(t1), a.centre[1] + a.r * Math.sin(t1)];
        push(p0, Math.tan((t1 - t0) / 4));
        push(p1);
      }
    } else if (s.kind === "circle") {
      const a: Pt = [s.center[0] + s.radius, s.center[1]];
      const b: Pt = [s.center[0] - s.radius, s.center[1]];
      push(a, 1);
      push(b, 1);
      push(a);
    } else {
      for (const p of segmentPoints(s, tol)) push(p);
    }
  }
  // Closed: the last vertex is the first one again — drop it (the polyline closes itself), keeping its bulge on the one before.
  if (path.closed && out.length > 1) {
    const first = out[0].p;
    const last = out[out.length - 1].p;
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-6) out.pop();
  }
  return out;
}

/** A DXF of the sheet (millimetres, $INSUNITS 4) with layers CUT_OUTER, CUT_INNER, SCORE and ENGRAVE. */
export function laserDxf(sheet: LaserSheet): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === "number" ? n(value) : value);
  const [W, H] = sheet.size;
  g(0, "SECTION"), g(2, "HEADER");
  g(9, "$ACADVER"), g(1, "AC1009");
  g(9, "$INSUNITS"), g(70, 4);
  g(9, "$EXTMIN"), g(10, 0), g(20, 0), g(30, 0);
  g(9, "$EXTMAX"), g(10, W), g(20, H), g(30, 0);
  g(0, "ENDSEC");
  g(0, "SECTION"), g(2, "TABLES");
  g(0, "TABLE"), g(2, "LTYPE"), g(70, 1);
  g(0, "LTYPE"), g(2, "CONTINUOUS"), g(70, 0), g(3, "Solid line"), g(72, 65), g(73, 0), g(40, 0);
  g(0, "ENDTAB");
  g(0, "TABLE"), g(2, "LAYER"), g(70, LAYER_ORDER.length);
  for (const l of LAYER_ORDER) g(0, "LAYER"), g(2, LASER_LAYERS[l].dxf), g(70, 0), g(62, LASER_LAYERS[l].aci), g(6, "CONTINUOUS");
  g(0, "ENDTAB"), g(0, "ENDSEC");
  g(0, "SECTION"), g(2, "ENTITIES");
  for (const layer of LAYER_ORDER) {
    for (const path of sheet.paths.filter((p) => p.layer === layer)) {
      const name = LASER_LAYERS[layer].dxf;
      const only = path.segments.length === 1 ? path.segments[0] : null;
      if (only?.kind === "circle") {
        g(0, "CIRCLE"), g(8, name), g(10, only.center[0]), g(20, only.center[1]), g(30, 0), g(40, only.radius);
        continue;
      }
      const verts = polylineOf(path);
      if (verts.length < 2) continue;
      g(0, "POLYLINE"), g(8, name), g(66, 1), g(10, 0), g(20, 0), g(30, 0), g(70, path.closed ? 1 : 0);
      for (const v of verts) {
        g(0, "VERTEX"), g(8, name), g(10, v.p[0]), g(20, v.p[1]), g(30, 0);
        if (Math.abs(v.bulge) > 1e-12) g(42, v.bulge);
      }
      g(0, "SEQEND"), g(8, name);
    }
  }
  g(0, "ENDSEC"), g(0, "EOF");
  return out.join("\n") + "\n";
}

/** Points of every path (for quick checks and previews). */
export function sheetOutlinePoints(sheet: LaserSheet): Pt[][] {
  return sheet.paths.map((p) => pathPoints(p.segments, p.closed));
}

export type { Segment };
