/**
 * Full-colour puzzle files (pure): for full-colour printers (Bambu Lab H3C) and print services (JLC3DP, 3D Alchemy, …).
 *
 * - 3MF with the core spec's colour group (`m:colorgroup`, each triangle's `pid` + `p1 p2 p3`: a colour per corner).
 *   Bambu Studio reads these from 3MF files it didn't write itself (bbs_3mf.cpp: colours are read when the file isn't a
 *   Bambu one), and JLC3DP takes 3MF for full colour.
 * - OBJ + MTL + PNG in a zip: a texture atlas of the pieces' surfaces would be huge, so the PNG is a palette — one small
 *   square of solid colour per colour used — and every triangle's three corners point at the middle of its colour's
 *   square (each triangle one colour, the average of its corners; the triangles are under a millimetre, so it still looks
 *   smooth). Any program that reads OBJ textures shows it the same.
 * - VRML 2.0 (.wrl) with a colour per corner (`colorPerVertex` + `colorIndex`), for PolyJet bureaus, zipped.
 * Lengths are millimetres throughout (OBJ and VRML have no units: services are told mm when uploading).
 */
import { crc32 } from "../geometry/threeMf";
import { bandParts, filamentSwaps, filaments, fullColours, paintCode, palette, SliceError, type BandContext, type BandPart, type ColouredMesh, type FullContext } from "./colour";
import type { PuzzlePiece } from "./mountainPuzzle";
import { bandPlate3mf, THREE_MF_PARTS, type BandPartFile, type Plate } from "./puzzle3mf";

export interface ColouredItem {
  name: string;
  mesh: ColouredMesh;
  /** Where it goes (mm), added to its corners. */
  move: [number, number, number];
}

// ---------------------------------------------------------------------------------------------------------------
// Whole puzzles

export interface BandedPuzzle {
  parts: Map<PuzzlePiece, BandPart[]>;
  /** Pieces that couldn't be cut (left in their lowest band's filament). */
  uncut: number;
}

/** Every piece cut into its colour bands. */
export function bandPuzzle(pieces: PuzzlePiece[], ctx: BandContext): BandedPuzzle {
  const parts = new Map<PuzzlePiece, BandPart[]>();
  let uncut = 0;
  const first = filaments(ctx.spec, ctx.map.water)[0]?.n ?? 1;
  for (const p of pieces) {
    try {
      parts.set(p, bandParts(p.bodies, p.z0, ctx));
    } catch (e) {
      if (!(e instanceof SliceError)) throw e;
      uncut++;
      parts.set(
        p,
        p.bodies.map((b) => ({ filament: first, vertices: b.vertices, triangles: b.triangles, low: 0, high: p.height })),
      );
    }
  }
  return { parts, uncut };
}

/** A banded plate's .3mf. */
export function bandPlateFile(plate: Plate, title: string, banded: BandedPuzzle, ctx: BandContext): Uint8Array {
  const fs = filaments(ctx.spec, ctx.map.water);
  const label = (n: number) => fs.find((f) => f.n === n)?.uses.join(" and ") ?? `filament ${n}`;
  const partsOf = (p: PuzzlePiece): BandPartFile[] => (banded.parts.get(p) ?? []).map((b) => ({ ...b, label: `${label(b.filament)} (filament ${b.filament})` }));
  return bandPlate3mf(plate, title, partsOf, paintCode);
}

/** Roughly how many filament changes each plate takes. */
export function plateSwaps(plates: Plate[], banded: BandedPuzzle, layer: number): number[] {
  return plates.map((pl) => filamentSwaps(pl.pieces.flatMap((x) => banded.parts.get(x.piece) ?? []), layer));
}

/** Every piece coloured corner by corner. */
export function colourPuzzle(pieces: PuzzlePiece[], ctx: FullContext): Map<PuzzlePiece, ColouredMesh> {
  const out = new Map<PuzzlePiece, ColouredMesh>();
  for (const p of pieces) out.set(p, fullColours(p.bodies, ctx));
  return out;
}

/** A plate's pieces as coloured items, moved `shift` mm along x (to lay several plates side by side in one file). */
export function plateItems(plate: Plate, coloured: Map<PuzzlePiece, ColouredMesh>, shift = 0): ColouredItem[] {
  return plate.pieces.flatMap(({ piece, move }) => {
    const mesh = coloured.get(piece);
    return mesh ? [{ name: piece.name, mesh, move: [move[0] + shift, move[1], move[2]] as [number, number, number] }] : [];
  });
}

/** Every plate's pieces in one file, plates side by side with `gap` mm between. */
export function allItems(plates: Plate[], coloured: Map<PuzzlePiece, ColouredMesh>, bedWidth: number, gap = 20): ColouredItem[] {
  return plates.flatMap((pl, i) => plateItems(pl, coloured, i * (bedWidth + gap)));
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
/** To a micrometre: plenty for any printer, and it keeps the files smaller. */
const num = (v: number) => String(Math.round(v * 1000) / 1000);

/** Every corner's colour of all the items in one list (for a shared palette). */
function allColours(items: ColouredItem[]): Uint8Array {
  let n = 0;
  for (const it of items) n += it.mesh.rgb.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const it of items) {
    out.set(it.mesh.rgb, at);
    at += it.mesh.rgb.length;
  }
  return out;
}

/** The 3MF model with one colour group shared by every piece. */
export function colour3mfModel(items: ColouredItem[], title: string): string {
  const { colours, index } = palette(allColours(items));
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:m="http://schemas.microsoft.com/3dmanufacturing/material/2015/02">',
    ` <metadata name="Title">${xmlEscape(title)}</metadata>`,
    ' <metadata name="Application">JuraCAD</metadata>',
    " <resources>",
    '  <m:colorgroup id="1">',
  ];
  for (const c of colours) lines.push(`   <m:color color="${c}"/>`);
  lines.push("  </m:colorgroup>");
  const build: string[] = [];
  let corner = 0;
  items.forEach((it, k) => {
    const id = k + 2;
    const { vertices: v, triangles: t } = it.mesh;
    lines.push(`  <object id="${id}" type="model" name="${xmlEscape(it.name)}" pid="1" pindex="${index[corner] ?? 0}">`, "   <mesh>", "    <vertices>");
    for (let i = 0; i < v.length; i += 3) lines.push(`     <vertex x="${num(v[i])}" y="${num(v[i + 1])}" z="${num(v[i + 2])}"/>`);
    lines.push("    </vertices>", "    <triangles>");
    for (let i = 0; i < t.length; i += 3) {
      lines.push(`     <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}" pid="1" p1="${index[corner]}" p2="${index[corner + 1]}" p3="${index[corner + 2]}"/>`);
      corner += 3;
    }
    lines.push("    </triangles>", "   </mesh>", "  </object>");
    build.push(`  <item objectid="${id}" transform="1 0 0 0 1 0 0 0 1 ${it.move.map(num).join(" ")}" printable="1"/>`);
  });
  lines.push(" </resources>", " <build>", ...build, " </build>", "</model>", "");
  return lines.join("\n");
}

/** The files inside a full-colour .3mf. */
export function colour3mfFiles(items: ColouredItem[], title: string): { name: string; data: string }[] {
  return [
    { name: "[Content_Types].xml", data: THREE_MF_PARTS.contentTypes },
    { name: "_rels/.rels", data: THREE_MF_PARTS.rels },
    { name: "3D/3dmodel.model", data: colour3mfModel(items, title) },
  ];
}

/** Squares per palette row, and each square's size in pixels (big enough that texture filtering stays inside). */
export const PALETTE_COLUMNS = 64;
export const SWATCH = 4;
/** At most this many colours in the OBJ's palette: colours are rounded more coarsely until they fit. */
export const MOST_SWATCHES = 16384;

/** Each triangle's colour (its corners' average) as one palette, rounded until it has at most `MOST_SWATCHES`. */
function triangleColours(items: ColouredItem[]): { colours: string[]; index: Uint32Array } {
  let n = 0;
  for (const it of items) n += it.mesh.triangles.length / 3;
  const mean = new Uint8Array(n * 3);
  let t = 0;
  for (const it of items) {
    const c = it.mesh.rgb;
    for (let i = 0; i < c.length; i += 9, t++)
      for (let d = 0; d < 3; d++) mean[t * 3 + d] = Math.round((c[i + d] + c[i + 3 + d] + c[i + 6 + d]) / 3);
  }
  for (let step = 4; ; step *= 2) {
    const p = palette(mean, step);
    if (p.colours.length <= MOST_SWATCHES || step >= 64) return p;
  }
}

/** The palette picture's pixels (RGB, rows top to bottom) and size. */
export function paletteImage(colours: string[]): { width: number; height: number; rgb: Uint8Array } {
  const width = PALETTE_COLUMNS * SWATCH;
  const rows = Math.max(1, Math.ceil(colours.length / PALETTE_COLUMNS));
  const height = rows * SWATCH;
  const rgb = new Uint8Array(width * height * 3).fill(255);
  colours.forEach((c, k) => {
    const [r, g, b] = [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
    const [x0, y0] = [(k % PALETTE_COLUMNS) * SWATCH, Math.floor(k / PALETTE_COLUMNS) * SWATCH];
    for (let y = y0; y < y0 + SWATCH; y++)
      for (let x = x0; x < x0 + SWATCH; x++) rgb.set([r, g, b], (y * width + x) * 3);
  });
  return { width, height, rgb };
}

/** OBJ + MTL text and the palette picture, named `<base>.obj`, `<base>.mtl`, `<base>.png`. */
export function colourObjFiles(items: ColouredItem[], base: string): { obj: string; mtl: string; png: Uint8Array } {
  const { colours, index } = triangleColours(items);
  const img = paletteImage(colours);
  const lines: string[] = [`# ${base} — made by JuraCAD. Millimetres.`, `mtllib ${base}.mtl`];
  // One texture point per colour: the middle of its square (v counts up from the picture's bottom).
  colours.forEach((_, k) => {
    const u = ((k % PALETTE_COLUMNS) * SWATCH + SWATCH / 2) / img.width;
    const v = 1 - (Math.floor(k / PALETTE_COLUMNS) * SWATCH + SWATCH / 2) / img.height;
    lines.push(`vt ${u.toFixed(6)} ${v.toFixed(6)}`);
  });
  let vBase = 1;
  let t = 0;
  for (const it of items) {
    lines.push(`o ${it.name.replace(/\s+/g, "_")}`, "usemtl puzzle");
    const { vertices: v, triangles: tr } = it.mesh;
    const [dx, dy, dz] = it.move;
    for (let i = 0; i < v.length; i += 3) lines.push(`v ${num(v[i] + dx)} ${num(v[i + 1] + dy)} ${num(v[i + 2] + dz)}`);
    for (let i = 0; i < tr.length; i += 3, t++) {
      const c = index[t] + 1;
      lines.push(`f ${tr[i] + vBase}/${c} ${tr[i + 1] + vBase}/${c} ${tr[i + 2] + vBase}/${c}`);
    }
    vBase += v.length / 3;
  }
  lines.push("");
  const mtl = [`# ${base} — made by JuraCAD`, "newmtl puzzle", "Ka 1 1 1", "Kd 1 1 1", "Ks 0 0 0", "d 1", "illum 1", `map_Kd ${base}.png`, ""].join("\n");
  return { obj: lines.join("\n"), mtl, png: pngStored(img.width, img.height, img.rgb) };
}

/** VRML 2.0 with a colour for every corner. */
export function colourWrl(items: ColouredItem[], title: string): string {
  const out: string[] = ["#VRML V2.0 utf8", `# ${title.replace(/[\r\n]/g, " ")} — made by JuraCAD. Units: millimetres.`, ""];
  for (const it of items) {
    const { colours, index } = palette(it.mesh.rgb);
    const { vertices: v, triangles: t } = it.mesh;
    out.push(`DEF ${vrmlName(it.name)} Transform {`, `  translation ${it.move.map(num).join(" ")}`, "  children Shape {");
    out.push("    appearance Appearance { material Material { diffuseColor 1 1 1 } }");
    out.push("    geometry IndexedFaceSet {", "      solid TRUE", "      ccw TRUE", "      colorPerVertex TRUE", "      coord Coordinate { point [");
    for (let i = 0; i < v.length; i += 3) out.push(`        ${num(v[i])} ${num(v[i + 1])} ${num(v[i + 2])},`);
    out.push("      ] }", "      color Color { color [");
    for (const c of colours) out.push(`        ${(parseInt(c.slice(1, 3), 16) / 255).toFixed(3)} ${(parseInt(c.slice(3, 5), 16) / 255).toFixed(3)} ${(parseInt(c.slice(5, 7), 16) / 255).toFixed(3)},`);
    out.push("      ] }", "      coordIndex [");
    for (let i = 0; i < t.length; i += 3) out.push(`        ${t[i]} ${t[i + 1]} ${t[i + 2]} -1,`);
    out.push("      ]", "      colorIndex [");
    for (let i = 0; i < t.length; i += 3) out.push(`        ${index[i]} ${index[i + 1]} ${index[i + 2]} -1,`);
    out.push("      ]", "    }", "  }", "}", "");
  }
  return out.join("\n");
}

/** A VRML node name: letters, digits and _ only, not starting with a digit. */
const vrmlName = (s: string) => {
  const n = s.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[0-9]/.test(n) ? `P_${n}` : n || "Piece";
};

// ---------------------------------------------------------------------------------------------------------------
// A PNG without compression (the palette is small), and a compressed zip

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** An RGB PNG whose data is zlib "stored" blocks — valid for every reader, just not small. */
export function pngStored(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const z = new Uint8Array(2 + raw.length + blocks * 5 + 4);
  z[0] = 0x78;
  z[1] = 0x01;
  let at = 2;
  for (let k = 0; k < blocks; k++) {
    const part = raw.subarray(k * 65535, Math.min(raw.length, (k + 1) * 65535));
    z[at] = k === blocks - 1 ? 1 : 0;
    z[at + 1] = part.length & 255;
    z[at + 2] = part.length >> 8;
    z[at + 3] = ~part.length & 255;
    z[at + 4] = (~part.length >> 8) & 255;
    z.set(part, at + 5);
    at += 5 + part.length;
  }
  new DataView(z.buffer).setUint32(at, adler32(raw));
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header[8] = 8;
  header[9] = 2;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", z), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let k = 0;
  for (const p of parts) {
    out.set(p, k);
    k += p.length;
  }
  return out;
}

/** Raw deflate through the browser's (or Node's) CompressionStream; null where there's none. */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } }).CompressionStream;
  if (!CS) return null;
  try {
    const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new CS("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>);
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** A zip whose files are compressed (deflate) where the browser can, else stored. Full-colour files are big text. */
export async function zipDeflated(files: { name: string; data: string | Uint8Array }[]): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const packed = await deflateRaw(data);
    const deflated = !!packed && packed.length < data.length;
    const body = deflated ? packed! : data;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true);
    local.setUint16(8, deflated ? 8 : 0, true);
    local.setUint16(10, 0, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, body);
    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, deflated ? 8 : 0, true);
    cen.setUint16(12, 0, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, body.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of all) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
