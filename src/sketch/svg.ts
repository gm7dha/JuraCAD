/**
 * Insert SVG: reads the shapes in an SVG drawing (from Inkscape, Illustrator,
 * Cricut Design Space, JuraCUT…) and adds them to a sketch as real sketch
 * geometry, as Insert DXF does.
 *
 * Paths, rectangles, circles, ellipses, lines, polylines and polygons come in,
 * inside any groups, transforms and `use` copies. Nothing is approximated:
 * lines stay lines, circles and circular arcs stay circles and arcs, other
 * ellipses and elliptical arcs stay ellipses, and cubic and quadratic curves
 * become sketch splines with exactly the same shape (a quadratic is a cubic
 * exactly). Text and pictures are left out (and counted).
 *
 * True size: a file whose width/height say mm, cm, in or pt (with a viewBox)
 * comes in at that size; otherwise 96 pixels to the inch, as browsers and
 * Inkscape read it. SVG's y runs down the page, a sketch's up, so the drawing
 * is turned the right way up and the page's bottom-left corner put on the
 * sketch's origin (the shapes' own bottom-left corner when the file has no
 * page size). Ends that meet are joined into one point, so closed outlines
 * come in as closed shapes. Nothing is constrained.
 *
 * Pure: the small XML reader is JuraCUT's (src/geometry/svgImport.ts there).
 */
import { splineThrough } from "./curves";
import { sketchId } from "./ops";
import { bezierBetween } from "./spline";
import type { InsertResult } from "./dxf";
import type { SketchCurve, SketchData, SketchPoint } from "./types";

type Pt = [number, number];

/** A problem with the file, in plain English. */
export class SvgError extends Error {}

/** Files bigger than this (characters) aren't read: they'd freeze the page. */
export const MAX_SVG_SIZE = 20 * 1024 * 1024;
/** Nor drawings with more than this many shapes… */
export const MAX_SVG_SHAPES = 20000;
/** …or this many pieces (lines, curves and arcs) in all. */
export const MAX_SVG_PIECES = 50000;
/** `use` copies inside copies are followed this deep (a file that uses itself would never end). */
const MAX_USE_DEPTH = 8;

/** One piece of a shape, in millimetres, y up. Arcs and parts of ellipses run anticlockwise from `from` to `to`. */
export type SvgPiece =
  | { kind: "line"; a: Pt; b: Pt }
  | { kind: "bezier"; a: Pt; c1: Pt; c2: Pt; b: Pt }
  | { kind: "circle"; c: Pt; r: number }
  | { kind: "arc"; c: Pt; from: Pt; to: Pt }
  /** `major`/`minor`: the ends of the two half-axes (points), the minor a quarter turn anticlockwise from the major. */
  | { kind: "ellipse"; c: Pt; major: Pt; minor: Pt; from?: Pt; to?: Pt };

/** A run of pieces end to end (one subpath, or one shape). */
export interface SvgShape {
  pieces: SvgPiece[];
  closed: boolean;
}

export interface SvgDrawing {
  shapes: SvgShape[];
  /** Millimetres per user unit. */
  unitMm: number;
  /** True when the file says its size in real units (mm, in…), false when it's read at 96 px to the inch. */
  sized: boolean;
  /** The page's size in mm, when the file gives one. */
  page: [number, number] | null;
  /** Kinds of thing that were left out (text, pictures…), with how many of each. */
  skipped: Record<string, number>;
}

// ---------------------------------------------------------------------------
// A small XML reader (JuraCUT's).

interface XmlElement {
  name: string;
  attrs: Record<string, string>;
  children: XmlElement[];
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/** The element tree of an XML document (text is ignored; namespaces are kept as plain prefixes). */
function parseXml(text: string): XmlElement {
  const root: XmlElement = { name: "", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) break;
    i = lt + 1;
    if (text.startsWith("!--", i)) {
      const end = text.indexOf("-->", i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text.startsWith("![CDATA[", i)) {
      const end = text.indexOf("]]>", i);
      i = end < 0 ? n : end + 3;
      continue;
    }
    if (text[i] === "!" || text[i] === "?") {
      let depth = 0;
      while (i < n) {
        const c = text[i++];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      continue;
    }
    if (text[i] === "/") {
      const end = text.indexOf(">", i);
      i = end < 0 ? n : end + 1;
      if (stack.length > 1) stack.pop();
      continue;
    }
    let j = i;
    while (j < n && !/[\s/>]/.test(text[j])) j++;
    const el: XmlElement = { name: text.slice(i, j), attrs: {}, children: [] };
    i = j;
    let selfClosing = false;
    for (;;) {
      while (i < n && /\s/.test(text[i])) i++;
      if (i >= n) break;
      if (text[i] === ">") {
        i++;
        break;
      }
      if (text[i] === "/") {
        selfClosing = true;
        i++;
        continue;
      }
      let k = i;
      while (k < n && !/[\s=/>]/.test(text[k])) k++;
      const attr = text.slice(i, k);
      i = k;
      while (i < n && /\s/.test(text[i])) i++;
      let value = "";
      if (text[i] === "=") {
        i++;
        while (i < n && /\s/.test(text[i])) i++;
        const q = text[i];
        if (q === '"' || q === "'") {
          const end = text.indexOf(q, i + 1);
          value = text.slice(i + 1, end < 0 ? n : end);
          i = end < 0 ? n : end + 1;
        } else {
          let e = i;
          while (e < n && !/[\s>]/.test(text[e])) e++;
          value = text.slice(i, e);
          i = e;
        }
      }
      if (attr) el.attrs[attr] = decode(value);
      if (k === i && !attr) i++; // never stand still on a stray character
    }
    stack[stack.length - 1].children.push(el);
    if (!selfClosing) stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------------------
// Transforms and lengths.

/** x' = a·x + c·y + e, y' = b·x + d·y + f. */
type M = [number, number, number, number, number, number];
const I: M = [1, 0, 0, 1, 0, 0];
const mul = (m2: M, m1: M): M => [
  m2[0] * m1[0] + m2[2] * m1[1],
  m2[1] * m1[0] + m2[3] * m1[1],
  m2[0] * m1[2] + m2[2] * m1[3],
  m2[1] * m1[2] + m2[3] * m1[3],
  m2[0] * m1[4] + m2[2] * m1[5] + m2[4],
  m2[1] * m1[4] + m2[3] * m1[5] + m2[5],
];
const ap = (m: M, p: Pt): Pt => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];
/** A direction moved by the transform (no shift). */
const dir = (m: M, v: Pt): Pt => [m[0] * v[0] + m[2] * v[1], m[1] * v[0] + m[3] * v[1]];

/** An SVG transform attribute as a matrix (unknown parts ignored). */
export function parseTransform(s: string | undefined): M {
  let m = I;
  if (!s) return m;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let r: RegExpExecArray | null;
  while ((r = re.exec(s))) {
    const a = r[2].split(/[\s,]+/).filter(Boolean).map(Number);
    if (a.some((v) => !Number.isFinite(v))) continue;
    let t: M | null = null;
    switch (r[1]) {
      case "matrix":
        if (a.length === 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case "translate":
        t = [1, 0, 0, 1, a[0] ?? 0, a[1] ?? 0];
        break;
      case "scale":
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case "rotate": {
        const ang = ((a[0] ?? 0) * Math.PI) / 180;
        const c = Math.cos(ang);
        const sn = Math.sin(ang);
        const rot: M = [c, sn, -sn, c, 0, 0];
        t = a.length >= 3 ? mul(mul([1, 0, 0, 1, a[1], a[2]], rot), [1, 0, 0, 1, -a[1], -a[2]]) : rot;
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        t = [1, Math.tan(((a[0] ?? 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    if (t) m = mul(m, t);
  }
  return m;
}

/** Millimetres per CSS unit. */
const UNIT_MM: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, "": 25.4 / 96 };

/** A length attribute in mm, and whether it named a real-world unit (null when missing or a percentage). */
function lengthMm(v: string | undefined): { mm: number; real: boolean } | null {
  if (!v) return null;
  const r = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)\s*([a-z%]*)\s*$/i.exec(v);
  if (!r) return null;
  const unit = r[2].toLowerCase();
  const k = UNIT_MM[unit];
  const mm = Number(r[1]) * (k ?? NaN);
  return k === undefined || !(mm > 0) ? null : { mm, real: unit !== "" && unit !== "px" };
}

const numAttr = (v: string | undefined, fallback = 0): number => {
  if (v === undefined) return fallback;
  const r = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)/i.exec(v);
  const n = r ? Number(r[1]) : NaN;
  return Number.isFinite(n) ? n : fallback;
};

// ---------------------------------------------------------------------------
// Pieces in the file's own coordinates (before transforms).

/**
 * Part of an ellipse in user units: centre, half-axes, the turn of its x axis
 * (radians), the start parameter and how far it goes (signed), and its exact
 * end points.
 */
interface RawArc {
  kind: "arc";
  c: Pt;
  rx: number;
  ry: number;
  phi: number;
  t0: number;
  dt: number;
  from: Pt;
  to: Pt;
}
type Raw = { kind: "line"; a: Pt; b: Pt } | { kind: "bezier"; a: Pt; c1: Pt; c2: Pt; b: Pt } | RawArc | { kind: "ellipse"; c: Pt; rx: number; ry: number };

/** The centre form of an SVG arc command (the standard conversion), or null when it's really a straight line. */
function arcCentre(from: Pt, rx: number, ry: number, rotDeg: number, large: boolean, sweep: boolean, to: Pt): RawArc | null {
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx < 1e-12 || ry < 1e-12 || (from[0] === to[0] && from[1] === to[1])) return null;
  const phi = (rotDeg * Math.PI) / 180;
  const cp = Math.cos(phi);
  const sp = Math.sin(phi);
  const dx = (from[0] - to[0]) / 2;
  const dy = (from[1] - to[1]) / 2;
  const x1 = cp * dx + sp * dy;
  const y1 = -sp * dx + cp * dy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) {
    rx *= Math.sqrt(lam);
    ry *= Math.sqrt(lam);
  }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1;
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const k = sign * Math.sqrt(Math.max(0, num / den));
  const cx1 = (k * rx * y1) / ry;
  const cy1 = (-k * ry * x1) / rx;
  const c: Pt = [cp * cx1 - sp * cy1 + (from[0] + to[0]) / 2, sp * cx1 + cp * cy1 + (from[1] + to[1]) / 2];
  const ang = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry);
  let dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry);
  if (!sweep && dt > 0) dt -= 2 * Math.PI;
  if (sweep && dt < 0) dt += 2 * Math.PI;
  return { kind: "arc", c, rx, ry, phi, t0, dt, from, to };
}

/** SVG path data as runs of pieces (one per subpath), in the path's own coordinates. */
function parsePathData(d: string): { pieces: Raw[]; closed: boolean }[] {
  const runs: { pieces: Raw[]; closed: boolean }[] = [];
  const tokens = d.match(/[a-zA-Z]|[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/g) ?? [];
  let i = 0;
  let cmd = "";
  let at: Pt = [0, 0];
  let start: Pt = [0, 0];
  let lastC: Pt | null = null;
  let lastQ: Pt | null = null;
  let cur: Raw[] = [];
  const num = () => {
    const n = Number(tokens[i++]);
    if (!Number.isFinite(n)) throw new SvgError("That SVG file has a drawing command that can't be read. Try saving it again from the program that made it.");
    return n;
  };
  const flag = () => {
    // Arc flags may be written run together ("a5 5 0 105 5"): take one digit.
    const t = tokens[i];
    if (t !== undefined && /^[01]./.test(t) && !/^[01]\.?$/.test(t) && !t.includes("e")) {
      tokens[i] = t.slice(1);
      return Number(t[0]);
    }
    return num();
  };
  const more = () => i < tokens.length && !/[a-zA-Z]/.test(tokens[i]);
  const flush = (closed: boolean) => {
    if (cur.length) runs.push({ pieces: cur, closed });
    cur = [];
  };
  const line = (to: Pt) => {
    if (Math.hypot(to[0] - at[0], to[1] - at[1]) > 1e-12) cur.push({ kind: "line", a: at, b: to });
    at = to;
  };
  const cubic = (c1: Pt, c2: Pt, to: Pt) => {
    cur.push({ kind: "bezier", a: at, c1, c2, b: to });
    at = to;
  };
  const quad = (c: Pt, to: Pt) => {
    cubic([at[0] + (2 / 3) * (c[0] - at[0]), at[1] + (2 / 3) * (c[1] - at[1])], [to[0] + (2 / 3) * (c[0] - to[0]), to[1] + (2 / 3) * (c[1] - to[1])], to);
  };
  let guard = 0;
  while (i < tokens.length) {
    if (++guard > 2_000_000) throw new SvgError("That SVG file is too complicated to read.");
    if (/[a-zA-Z]/.test(tokens[i])) cmd = tokens[i++];
    else if (!cmd) throw new SvgError("That SVG file's drawing doesn't start with a move, so it can't be read.");
    const rel = cmd === cmd.toLowerCase();
    const P = (): Pt => {
      const x = num();
      const y = num();
      return rel ? [at[0] + x, at[1] + y] : [x, y];
    };
    const C = cmd.toUpperCase();
    let hadC = false;
    let hadQ = false;
    switch (C) {
      case "M":
        flush(false);
        at = P();
        start = at;
        // Further pairs are lines (relative ones from where the pen is).
        while (more()) line(P());
        break;
      case "Z":
        if (cur.length && Math.hypot(at[0] - start[0], at[1] - start[1]) > 1e-9) line(start);
        at = start;
        flush(true);
        break;
      case "L":
        do line(P());
        while (more());
        break;
      case "H":
        do {
          const x = num();
          line([rel ? at[0] + x : x, at[1]]);
        } while (more());
        break;
      case "V":
        do {
          const y = num();
          line([at[0], rel ? at[1] + y : y]);
        } while (more());
        break;
      case "C":
        do {
          const c1 = P();
          const c2 = P();
          const to = P();
          cubic(c1, c2, to);
          lastC = c2;
        } while (more());
        hadC = true;
        break;
      case "S":
        do {
          const c1: Pt = lastC ? [2 * at[0] - lastC[0], 2 * at[1] - lastC[1]] : at;
          const c2 = P();
          const to = P();
          cubic(c1, c2, to);
          lastC = c2;
        } while (more());
        hadC = true;
        break;
      case "Q":
        do {
          const c = P();
          const to = P();
          quad(c, to);
          lastQ = c;
        } while (more());
        hadQ = true;
        break;
      case "T":
        do {
          const c: Pt = lastQ ? [2 * at[0] - lastQ[0], 2 * at[1] - lastQ[1]] : at;
          const to = P();
          quad(c, to);
          lastQ = c;
        } while (more());
        hadQ = true;
        break;
      case "A":
        do {
          const rx = num();
          const ry = num();
          const rot = num();
          const large = flag();
          const sweep = flag();
          const to = P();
          const arc = arcCentre(at, rx, ry, rot, !!large, !!sweep, to);
          if (arc) {
            cur.push(arc);
            at = to;
          } else line(to);
        } while (more());
        break;
      default:
        throw new SvgError(`That SVG file uses a drawing command ("${cmd}") JuraCAD doesn't know. Try saving it as a plain SVG.`);
    }
    if (!hadC) lastC = null;
    if (!hadQ) lastQ = null;
  }
  flush(false);
  return runs;
}

/** A rectangle (rounded corners as quarter ellipses), in user units. */
function rectPieces(x: number, y: number, w: number, h: number, rx: number, ry: number): Raw[] {
  rx = Math.min(Math.max(rx, 0), w / 2);
  ry = Math.min(Math.max(ry, 0), h / 2);
  const L = (a: Pt, b: Pt): Raw[] => (Math.hypot(a[0] - b[0], a[1] - b[1]) > 1e-12 ? [{ kind: "line", a, b }] : []);
  if (rx < 1e-12 || ry < 1e-12) return [...L([x, y], [x + w, y]), ...L([x + w, y], [x + w, y + h]), ...L([x + w, y + h], [x, y + h]), ...L([x, y + h], [x, y])];
  const corner = (cx: number, cy: number, t0: number): RawArc => {
    const p = (t: number): Pt => [cx + rx * Math.cos(t), cy + ry * Math.sin(t)];
    return { kind: "arc", c: [cx, cy], rx, ry, phi: 0, t0, dt: Math.PI / 2, from: p(t0), to: p(t0 + Math.PI / 2) };
  };
  return [
    ...L([x + rx, y], [x + w - rx, y]),
    corner(x + w - rx, y + ry, -Math.PI / 2),
    ...L([x + w, y + ry], [x + w, y + h - ry]),
    corner(x + w - rx, y + h - ry, 0),
    ...L([x + w - rx, y + h], [x + rx, y + h]),
    corner(x + rx, y + h - ry, Math.PI / 2),
    ...L([x, y + h - ry], [x, y + ry]),
    corner(x + rx, y + ry, Math.PI),
  ];
}

// ---------------------------------------------------------------------------
// Moving pieces into millimetres, y up.

/**
 * The ellipse c + A·(cos t, sin t), from the 2 × 2 matrix A (columns: where the
 * parameter's x and y go): its half-axes (major first, minor a quarter turn
 * anticlockwise from it), and whether t runs anticlockwise.
 */
function axesOf(A: [number, number, number, number]): { major: Pt; minor: Pt; round: boolean; anticlockwise: boolean } {
  const [a, b, c, d] = A; // columns (a, b) and (c, d)
  const p = a * a + c * c;
  const q = a * b + c * d;
  const r = b * b + d * d;
  const mid = (p + r) / 2;
  const half = Math.sqrt(((p - r) / 2) ** 2 + q * q);
  const big = Math.sqrt(Math.max(0, mid + half));
  const small = Math.sqrt(Math.max(0, mid - half));
  const th = 0.5 * Math.atan2(2 * q, p - r);
  return {
    major: [big * Math.cos(th), big * Math.sin(th)],
    minor: [-small * Math.sin(th), small * Math.cos(th)],
    round: big - small <= 1e-9 * big,
    anticlockwise: a * d - b * c > 0,
  };
}

function placeRaw(r: Raw, m: M): SvgPiece {
  switch (r.kind) {
    case "line":
      return { kind: "line", a: ap(m, r.a), b: ap(m, r.b) };
    case "bezier":
      return { kind: "bezier", a: ap(m, r.a), c1: ap(m, r.c1), c2: ap(m, r.c2), b: ap(m, r.b) };
    case "ellipse": {
      const c = ap(m, r.c);
      const ex = dir(m, [r.rx, 0]);
      const ey = dir(m, [0, r.ry]);
      const ax = axesOf([ex[0], ex[1], ey[0], ey[1]]);
      if (ax.round) return { kind: "circle", c, r: Math.hypot(ax.major[0], ax.major[1]) };
      return { kind: "ellipse", c, major: [c[0] + ax.major[0], c[1] + ax.major[1]], minor: [c[0] + ax.minor[0], c[1] + ax.minor[1]] };
    }
    case "arc": {
      const c = ap(m, r.c);
      const cp = Math.cos(r.phi);
      const sp = Math.sin(r.phi);
      const ex = dir(m, [r.rx * cp, r.rx * sp]);
      const ey = dir(m, [-r.ry * sp, r.ry * cp]);
      const ax = axesOf([ex[0], ex[1], ey[0], ey[1]]);
      const a = ap(m, r.from);
      const b = ap(m, r.to);
      // Sketch arcs run anticlockwise: start where the file's arc ends when it runs the other way.
      const [from, to] = r.dt > 0 === ax.anticlockwise ? [a, b] : [b, a];
      if (ax.round) return { kind: "arc", c, from, to };
      return { kind: "ellipse", c, major: [c[0] + ax.major[0], c[1] + ax.major[1]], minor: [c[0] + ax.minor[0], c[1] + ax.minor[1]], from, to };
    }
  }
}

// ---------------------------------------------------------------------------
// Reading the file.

const SKIP = new Set(["defs", "clipPath", "mask", "symbol", "marker", "pattern", "metadata", "title", "desc", "style", "script", "linearGradient", "radialGradient", "filter", "namedview"]);
/** Things left out, by the name the summary gives them. */
const NOTED: Record<string, string> = { text: "text", image: "pictures", foreignObject: "embedded pages", use: "copies whose original is missing" };

function hidden(el: XmlElement): boolean {
  const css: Record<string, string> = {};
  for (const part of (el.attrs.style ?? "").split(";")) {
    const k = part.indexOf(":");
    if (k > 0) css[part.slice(0, k).trim().toLowerCase()] = part.slice(k + 1).trim();
  }
  const get = (name: string) => (css[name] ?? el.attrs[name])?.trim();
  return get("display") === "none" || get("visibility") === "hidden";
}

/** Read an SVG file's text. Throws a plain-English `SvgError` when it isn't an SVG drawing or is too big. */
export function parseSvg(text: string): SvgDrawing {
  if (text.length > MAX_SVG_SIZE) throw new SvgError("That SVG file is too big to bring in (over 20 MB). Open it in a drawing program and save just the part you need.");
  const root = parseXml(text);
  const svg = root.children.find((c) => c.name === "svg" || c.name.endsWith(":svg"));
  if (!svg) throw new SvgError("That doesn't look like an SVG drawing. Choose a .svg file.");

  // Size: with a viewBox and a width (or height), user units are viewBox units at that size; else px (96 to the inch).
  const vb = (svg.attrs.viewBox ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
  const hasBox = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const w = lengthMm(svg.attrs.width);
  const h = lengthMm(svg.attrs.height);
  let unitMm = UNIT_MM.px;
  let sized = false;
  if (hasBox && w) {
    unitMm = w.mm / vb[2];
    sized = w.real;
  } else if (hasBox && h) {
    unitMm = h.mm / vb[3];
    sized = h.real;
  }
  // The page in user units: the viewBox, else the width and height.
  const page: [number, number, number, number] | null = hasBox ? [vb[0], vb[1], vb[2], vb[3]] : w && h ? [0, 0, w.mm / unitMm, h.mm / unitMm] : null;
  // User units → mm, y up, the page's bottom-left corner on (0, 0).
  const base: M = page ? [unitMm, 0, 0, -unitMm, -unitMm * page[0], unitMm * (page[1] + page[3])] : [unitMm, 0, 0, -unitMm, 0, 0];

  const ids = new Map<string, XmlElement>();
  const index = (el: XmlElement) => {
    if (el.attrs.id && !ids.has(el.attrs.id)) ids.set(el.attrs.id, el);
    el.children.forEach(index);
  };
  index(svg);

  const shapes: SvgShape[] = [];
  const skipped: Record<string, number> = {};
  let pieces = 0;
  const note = (what: string) => (skipped[what] = (skipped[what] ?? 0) + 1);
  const add = (raw: Raw[], closed: boolean, m: M) => {
    if (!raw.length) return;
    if (shapes.length >= MAX_SVG_SHAPES) throw new SvgError(`That drawing has more than ${MAX_SVG_SHAPES.toLocaleString("en")} shapes, too many for a sketch. Open it in a drawing program and save just the part you need.`);
    pieces += raw.length;
    if (pieces > MAX_SVG_PIECES) throw new SvgError(`That drawing has more than ${MAX_SVG_PIECES.toLocaleString("en")} lines and curves, too many for a sketch. Open it in a drawing program and save just the part you need (or simplify it).`);
    shapes.push({ pieces: raw.map((r) => placeRaw(r, m)), closed });
  };

  const walk = (el: XmlElement, m: M, depth: number, children = false) => {
    const name = el.name.replace(/^.*:/, "");
    if (SKIP.has(name) && !children) return;
    if (hidden(el)) return;
    let mm = mul(m, parseTransform(el.attrs.transform));
    const a = el.attrs;
    if (children) {
      for (const c of el.children) walk(c, mm, depth);
      return;
    }
    switch (name) {
      case "svg":
        // A drawing inside the drawing: moved to its x, y.
        if (el !== svg) mm = mul(mm, [1, 0, 0, 1, numAttr(a.x), numAttr(a.y)]);
        for (const c of el.children) walk(c, mm, depth);
        break;
      case "g":
      case "a":
      case "switch":
        for (const c of el.children) walk(c, mm, depth);
        break;
      case "use": {
        const href = (a.href ?? a["xlink:href"] ?? "").trim();
        const target = href.startsWith("#") ? ids.get(href.slice(1)) : undefined;
        if (!target || depth >= MAX_USE_DEPTH) {
          note(NOTED.use);
          break;
        }
        const moved = mul(mm, [1, 0, 0, 1, numAttr(a.x), numAttr(a.y)]);
        const tName = target.name.replace(/^.*:/, "");
        // A symbol's own shapes are drawn (it isn't drawn where it's defined).
        if (tName === "symbol") walk(target, moved, depth + 1, true);
        else walk(target, moved, depth + 1);
        break;
      }
      case "path":
        if (a.d) for (const run of parsePathData(a.d)) add(run.pieces, run.closed, mm);
        break;
      case "rect": {
        const rw = numAttr(a.width);
        const rh = numAttr(a.height);
        if (rw > 0 && rh > 0) {
          const rx = a.rx !== undefined ? numAttr(a.rx) : a.ry !== undefined ? numAttr(a.ry) : 0;
          const ry = a.ry !== undefined ? numAttr(a.ry) : rx;
          add(rectPieces(numAttr(a.x), numAttr(a.y), rw, rh, rx, ry), true, mm);
        }
        break;
      }
      case "circle": {
        const r = numAttr(a.r);
        if (r > 0) add([{ kind: "ellipse", c: [numAttr(a.cx), numAttr(a.cy)], rx: r, ry: r }], true, mm);
        break;
      }
      case "ellipse": {
        const rx = numAttr(a.rx);
        const ry = numAttr(a.ry);
        if (rx > 0 && ry > 0) add([{ kind: "ellipse", c: [numAttr(a.cx), numAttr(a.cy)], rx, ry }], true, mm);
        break;
      }
      case "line": {
        const p: Pt = [numAttr(a.x1), numAttr(a.y1)];
        const q: Pt = [numAttr(a.x2), numAttr(a.y2)];
        if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-12) add([{ kind: "line", a: p, b: q }], false, mm);
        break;
      }
      case "polyline":
      case "polygon": {
        const nums = (a.points ?? "").split(/[\s,]+/).filter(Boolean).map(Number);
        const pts: Pt[] = [];
        for (let i = 0; i + 1 < nums.length; i += 2) if (Number.isFinite(nums[i]) && Number.isFinite(nums[i + 1])) pts.push([nums[i], nums[i + 1]]);
        const closed = name === "polygon";
        const raw: Raw[] = [];
        for (let i = 0; i < (closed ? pts.length : pts.length - 1); i++) {
          const p = pts[i];
          const q = pts[(i + 1) % pts.length];
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) > 1e-12) raw.push({ kind: "line", a: p, b: q });
        }
        add(raw, closed && raw.length > 1, mm);
        break;
      }
      default:
        if (NOTED[name]) note(NOTED[name]);
        else if (!SKIP.has(name)) for (const c of el.children) walk(c, mm, depth);
    }
  };
  walk(svg, base, 0);

  // A file with no page size: its shapes' bottom-left corner goes on the origin.
  if (!page && shapes.length) {
    let x0 = Infinity;
    let y0 = Infinity;
    const see = (p: Pt) => {
      x0 = Math.min(x0, p[0]);
      y0 = Math.min(y0, p[1]);
    };
    for (const s of shapes)
      for (const p of s.pieces) {
        if (p.kind === "line") [p.a, p.b].forEach(see);
        else if (p.kind === "bezier") [p.a, p.c1, p.c2, p.b].forEach(see);
        else if (p.kind === "circle") see([p.c[0] - p.r, p.c[1] - p.r]);
        else {
          const r = p.kind === "arc" ? Math.hypot(p.from[0] - p.c[0], p.from[1] - p.c[1]) : Math.hypot(p.major[0] - p.c[0], p.major[1] - p.c[1]);
          see([p.c[0] - r, p.c[1] - r]);
        }
      }
    const sh = (p: Pt): Pt => [p[0] - x0, p[1] - y0];
    for (const s of shapes)
      s.pieces = s.pieces.map((p): SvgPiece => {
        switch (p.kind) {
          case "line":
            return { kind: "line", a: sh(p.a), b: sh(p.b) };
          case "bezier":
            return { kind: "bezier", a: sh(p.a), c1: sh(p.c1), c2: sh(p.c2), b: sh(p.b) };
          case "circle":
            return { kind: "circle", c: sh(p.c), r: p.r };
          case "arc":
            return { kind: "arc", c: sh(p.c), from: sh(p.from), to: sh(p.to) };
          case "ellipse":
            return { kind: "ellipse", c: sh(p.c), major: sh(p.major), minor: sh(p.minor), ...(p.from && p.to ? { from: sh(p.from), to: sh(p.to) } : {}) };
        }
      });
  }

  // Shapes with broken numbers in them are left out (and counted).
  const good = shapes.filter((s) => JSON.stringify(s.pieces).indexOf("null") < 0 && s.pieces.every((p) => Object.values(p).every((v) => typeof v === "string" || (Array.isArray(v) ? v.every(Number.isFinite) : Number.isFinite(v)))));
  if (good.length < shapes.length) skipped["shapes with unreadable numbers"] = shapes.length - good.length;
  return { shapes: good, unitMm, sized, page: page ? [page[2] * unitMm, page[3] * unitMm] : null, skipped };
}

// ---------------------------------------------------------------------------
// Into a sketch.

const near = (p: Pt, q: Pt, tol: number) => Math.hypot(p[0] - q[0], p[1] - q[1]) <= tol;

/** A cubic piece that is really a straight line (its handles on the line, in order), so it comes in as one. */
function straight(p: Extract<SvgPiece, { kind: "bezier" }>, tol: number): boolean {
  const dx = p.b[0] - p.a[0];
  const dy = p.b[1] - p.a[1];
  const len = Math.hypot(dx, dy);
  if (len <= tol) return false;
  const along = (q: Pt) => ((q[0] - p.a[0]) * dx + (q[1] - p.a[1]) * dy) / (len * len);
  const off = (q: Pt) => Math.abs((q[0] - p.a[0]) * dy - (q[1] - p.a[1]) * dx) / len;
  const u1 = along(p.c1);
  const u2 = along(p.c2);
  return off(p.c1) <= tol && off(p.c2) <= tol && u1 >= -1e-9 && u1 <= u2 + 1e-9 && u2 <= 1 + 1e-9;
}

/**
 * Add an SVG drawing to a sketch, `scale` × its true size. New shapes are
 * construction geometry if asked.
 */
export function insertSvg(s: SketchData, drawing: SvgDrawing, scale: number, construction = false): InsertResult {
  const fail = (error: string): InsertResult => ({ sketch: s, curveIds: [], count: 0, error });
  if (!(scale > 0)) return fail("The scale must be more than 0.");
  const k = scale;
  const K = (p: Pt): Pt => [p[0] * k, p[1] * k];
  let size = 0;
  for (const sh of drawing.shapes)
    for (const p of sh.pieces) for (const v of Object.values(p)) if (Array.isArray(v)) size = Math.max(size, Math.abs(v[0] * k), Math.abs(v[1] * k));
  const tol = 1e-6 * Math.max(1, size);
  const points: SketchPoint[] = [];
  const curves: SketchCurve[] = [];
  const byKey = new Map<string, string>();
  /** A point at p (mm, scaled), shared with any end already there. */
  const at = (p: Pt, shared = true): string => {
    const key = `${Math.round(p[0] / tol)},${Math.round(p[1] / tol)}`;
    const known = shared ? byKey.get(key) : undefined;
    if (known) return known;
    const id = sketchId("p");
    points.push({ id, x: p[0], y: p[1] });
    if (shared) byKey.set(key, id);
    return id;
  };
  let count = 0;

  for (const shape of drawing.shapes) {
    const before = curves.length;
    const list = shape.pieces;
    // A closed run of curves only is one closed spline.
    const allCurves = list.every((p) => p.kind === "bezier");
    let i = 0;
    while (i < list.length) {
      const p = list[i];
      if (p.kind === "bezier" && !straight({ ...p, a: K(p.a), c1: K(p.c1), c2: K(p.c2), b: K(p.b) }, tol)) {
        // Curves end to end are one spline, with exactly their shape.
        const run: [Pt, Pt, Pt, Pt][] = [];
        while (i < list.length) {
          const q = list[i];
          if (q.kind !== "bezier") break;
          const b: [Pt, Pt, Pt, Pt] = [K(q.a), K(q.c1), K(q.c2), K(q.b)];
          if (straight({ kind: "bezier", a: b[0], c1: b[1], c2: b[2], b: b[3] }, tol)) break;
          if (!b.every((x) => near(x, b[0], tol))) run.push(b);
          i++;
        }
        if (!run.length) continue;
        const closed = allCurves && shape.closed && run.length === list.length && near(run[run.length - 1][3], run[0][0], tol);
        // A closed spline needs three points or more: the longest pieces are cut in half (exactly) until it has them.
        while (closed && run.length < 3) {
          let k = 0;
          run.forEach((b, j) => (Math.hypot(b[3][0] - b[0][0], b[3][1] - b[0][1]) > Math.hypot(run[k][3][0] - run[k][0][0], run[k][3][1] - run[k][0][1]) ? (k = j) : 0));
          run.splice(k, 1, bezierBetween(run[k], 0, 0.5), bezierBetween(run[k], 0.5, 1));
        }
        const starts = run.map((b) => b[0]);
        const ids = closed ? starts.map((q) => at(q, false)) : [...starts, run[run.length - 1][3]].map((q, j, all) => at(q, j === 0 || j === all.length - 1));
        curves.push(splineThrough(sketchId("sp"), ids, run, closed, construction));
        continue;
      }
      i++;
      switch (p.kind) {
        case "line":
        case "bezier": {
          const a = K(p.a);
          const b = K(p.b);
          if (!near(a, b, tol)) curves.push({ id: sketchId("l"), type: "line", p1: at(a), p2: at(b), construction });
          break;
        }
        case "circle":
          if (p.r * k > tol) curves.push({ id: sketchId("k"), type: "circle", center: at(K(p.c), false), radius: p.r * k, construction });
          break;
        case "arc": {
          const c = K(p.c);
          const from = K(p.from);
          if (Math.hypot(from[0] - c[0], from[1] - c[1]) > tol && !near(from, K(p.to), tol))
            curves.push({ id: sketchId("a"), type: "arc", center: at(c, false), start: at(from), end: at(K(p.to)), construction });
          break;
        }
        case "ellipse": {
          const c = K(p.c);
          const major = K(p.major);
          const minor = K(p.minor);
          if (near(major, c, tol) || near(minor, c, tol)) break;
          const part = p.from && p.to ? { start: at(K(p.from)), end: at(K(p.to)) } : {};
          if (p.from && p.to && near(K(p.from), K(p.to), tol)) break;
          curves.push({ id: sketchId("el"), type: "ellipse", center: at(c, false), major: at(major, false), minor: at(minor, false), ...part, construction });
          break;
        }
      }
    }
    if (curves.length > before) count++;
  }
  if (!count) {
    const what = Object.keys(drawing.skipped);
    return fail(
      what.length
        ? `Nothing in that file can be brought in: it only has ${what.join(", ")}.${drawing.skipped.text ? " Turn text into paths first (in Inkscape: Path › Object to Path)." : ""}`
        : "That SVG file has no shapes in it.",
    );
  }
  return { sketch: { ...s, points: [...s.points, ...points], curves: [...s.curves, ...curves] }, curveIds: curves.map((c) => c.id), count };
}

/** A plain-English note of what was brought in and what was left out. */
export function svgSummary(drawing: SvgDrawing, count: number, scale: number): string {
  const scaled = scale !== 1 ? `, scaled × ${scale}` : "";
  const size = drawing.sized
    ? ` It's at the size the file gives${scaled}.`
    : ` The file doesn't give its size in mm or inches, so it's read at 96 pixels to the inch (as Inkscape and web browsers do)${scaled}.`;
  const left = Object.entries(drawing.skipped);
  const skipped = left.length ? ` Left out: ${left.map(([t, n]) => `${n} ${t}`).join(", ")}.${drawing.skipped.text ? " To bring text in, turn it into paths first (in Inkscape: Path › Object to Path)." : ""}` : "";
  return `Brought in ${count} shape${count === 1 ? "" : "s"}.${size}${skipped}`;
}
