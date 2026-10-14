/**
 * Text as outlines: letters from a three.js "typeface" font (the outline
 * commands m/l/q/b in font units) turned into closed polygons in mm, and
 * grouped into shapes with their holes (the inside of an "o" or "A").
 */

export interface TypefaceFont {
  resolution: number;
  boundingBox: { yMin: number; yMax: number };
  underlineThickness?: number;
  glyphs: Record<string, { ha: number; o?: string }>;
}

type P2 = [number, number];

export interface TextShape {
  outer: P2[];
  holes: P2[][];
}

/** Signed area (positive = anticlockwise). */
export function polygonArea(poly: P2[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const [x1, y1] = poly[i];
    const [x2, y2] = poly[(i + 1) % poly.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

function inside(p: P2, poly: P2[]): boolean {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Drop repeated points (and a closing point equal to the first). */
function tidy(poly: P2[], tol: number): P2[] {
  const out: P2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > tol) out.push(p);
  }
  while (out.length > 2 && Math.hypot(out[0][0] - out[out.length - 1][0], out[0][1] - out[out.length - 1][1]) <= tol) out.pop();
  return out;
}

/**
 * The closed outlines of `text` at `size` mm (the font's full height), with
 * the first letter's baseline starting at (0, 0). Curves become short straight
 * pieces (`steps` per curve). Lines of text are split by "\n".
 */
export function textOutlines(font: TypefaceFont, text: string, size: number, steps = 6): { contours: P2[][]; width: number; height: number } {
  const scale = size / font.resolution;
  const lineHeight = (font.boundingBox.yMax - font.boundingBox.yMin + (font.underlineThickness ?? 0)) * scale;
  const contours: P2[][] = [];
  let width = 0;
  const lines = text.split("\n");
  lines.forEach((line, row) => {
    let x = 0;
    const y = -row * lineHeight;
    for (const ch of Array.from(line)) {
      const glyph = font.glyphs[ch] ?? font.glyphs["?"];
      if (!glyph) continue;
      if (glyph.o) {
        const o = glyph.o.split(" ").filter(Boolean);
        let cur: P2[] = [];
        let i = 0;
        const num = () => Number(o[i++]);
        const pt = (): P2 => {
          const px = num() * scale + x;
          const py = num() * scale + y;
          return [px, py];
        };
        let last: P2 = [x, y];
        while (i < o.length) {
          const cmd = o[i++];
          if (cmd === "m") {
            if (cur.length > 2) contours.push(cur);
            last = pt();
            cur = [last];
          } else if (cmd === "l") {
            last = pt();
            cur.push(last);
          } else if (cmd === "q") {
            // End point first, then the control point.
            const end = pt();
            const c = pt();
            for (let k = 1; k <= steps; k++) {
              const t = k / steps;
              const u = 1 - t;
              cur.push([u * u * last[0] + 2 * u * t * c[0] + t * t * end[0], u * u * last[1] + 2 * u * t * c[1] + t * t * end[1]]);
            }
            last = end;
          } else if (cmd === "b") {
            const end = pt();
            const c1 = pt();
            const c2 = pt();
            for (let k = 1; k <= steps; k++) {
              const t = k / steps;
              const u = 1 - t;
              cur.push([
                u * u * u * last[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * end[0],
                u * u * u * last[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * end[1],
              ]);
            }
            last = end;
          } else {
            break; // unknown command: stop reading this glyph
          }
        }
        if (cur.length > 2) contours.push(cur);
      }
      x += glyph.ha * scale;
    }
    width = Math.max(width, x);
  });
  const tol = size * 1e-5;
  return { contours: contours.map((c) => tidy(c, tol)).filter((c) => c.length >= 3 && Math.abs(polygonArea(c)) > tol * tol), width, height: lineHeight * lines.length };
}

/**
 * Group outlines into shapes with holes: an outline inside an odd number of
 * others is a hole in the smallest one around it.
 */
export function nestContours(contours: P2[][]): TextShape[] {
  const items = contours.map((c) => ({ c, area: Math.abs(polygonArea(c)) })).sort((a, b) => b.area - a.area);
  const depth: number[] = [];
  const parent: number[] = [];
  items.forEach((it, i) => {
    let p = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (inside(it.c[0], items[j].c)) {
        p = j;
        break;
      }
    }
    parent[i] = p;
    depth[i] = p < 0 ? 0 : depth[p] + 1;
  });
  const shapes: (TextShape | null)[] = items.map((it, i) => (depth[i] % 2 === 0 ? { outer: it.c, holes: [] } : null));
  items.forEach((it, i) => {
    if (depth[i] % 2 === 1) shapes[parent[i]]!.holes.push(it.c);
  });
  return shapes.filter((s): s is TextShape => s !== null);
}
