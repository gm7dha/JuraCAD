/**
 * Mountain puzzle pieces onto print plates (pure): laid out in rows on the printer's bed, each standing on its
 * underside, and written as 3MF files — one per plate — that Bambu Studio and OrcaSlicer open with the snow ready for
 * a second filament: each piece is one object made of two parts, rock (filament 1) and snow (filament 2), told to the
 * slicer in Metadata/model_settings.config (Bambu's own way). Other slicers see an ordinary 3MF whose pieces have
 * two parts each, to give a filament by hand.
 */
import { weld, zipStored } from "../geometry/threeMf";
import type { PuzzlePiece } from "./mountainPuzzle";
import { zipDeflated } from "../geometry/zipDeflate";

export interface PlacedPiece {
  piece: PuzzlePiece;
  /** Move from puzzle position to its place on the plate (mm). */
  move: [number, number, number];
}

export interface Plate {
  pieces: PlacedPiece[];
}

/** Room left round the bed's edge and between pieces, mm. */
export const BED_MARGIN = 5;
export const PIECE_GAP = 4;

function footprint(p: PuzzlePiece): [number, number, number, number] {
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, y] of p.outline) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return [x0, y0, x1, y1];
}

/** Lay the pieces out on as few plates as rows of them allow, in name order (column by column, bottom up). */
export function platesFor(pieces: PuzzlePiece[], bed: [number, number, number]): Plate[] {
  const plates: Plate[] = [];
  let plate: Plate = { pieces: [] };
  let x = BED_MARGIN;
  let y = BED_MARGIN;
  let rowDepth = 0;
  const [W, D] = [bed[0] - BED_MARGIN, bed[1] - BED_MARGIN];
  // Bottom layers first (they're assembled first), then by row and column.
  const order = [...pieces].sort((a, b) => a.layer - b.layer || a.row - b.row || a.col - b.col);
  for (const p of order) {
    const [x0, y0, x1, y1] = footprint(p);
    const [w, d] = [x1 - x0, y1 - y0];
    if (x + w > W && x > BED_MARGIN) {
      x = BED_MARGIN;
      y += rowDepth + PIECE_GAP;
      rowDepth = 0;
    }
    if (y + d > D && plate.pieces.length) {
      plates.push(plate);
      plate = { pieces: [] };
      x = BED_MARGIN;
      y = BED_MARGIN;
      rowDepth = 0;
    }
    plate.pieces.push({ piece: p, move: [x - x0, y - y0, -p.z0] });
    x += w + PIECE_GAP;
    rowDepth = Math.max(rowDepth, d);
  }
  if (plate.pieces.length) plates.push(plate);
  return plates;
}

/** A rectangle on the bed: x0, y0, x1, y1 (mm from the front-left corner). */
export type BedRect = [number, number, number, number];

/**
 * Room kept free for Bambu Studio's prime tower when the puzzle is put together in several filaments: the back-left
 * corner (its usual place — x 15, y 220 on a 256 mm bed — and where to drag it otherwise). The tower is 35 mm wide
 * (Bambu's `prime_tower_width`), with its brim and some depth for many colours: 55 × 55 mm.
 */
export const TOWER_ROOM = 55;
export const towerCorner = (bed: [number, number, number]): BedRect => [0, bed[1] - TOWER_ROOM, TOWER_ROOM, bed[1]];

/**
 * The largest rectangles of the bed that keep clear of every `keepOut` (each a candidate place for the puzzle). With
 * none, the whole bed.
 */
export function freeRooms(bed: [number, number, number], keepOut: BedRect[]): BedRect[] {
  const clip = (v: number, hi: number) => Math.min(hi, Math.max(0, v));
  const boxes = keepOut.map(([a, b, c, d]): BedRect => [clip(a, bed[0]), clip(b, bed[1]), clip(c, bed[0]), clip(d, bed[1])]).filter(([a, b, c, d]) => c > a && d > b);
  const xs = [...new Set([0, bed[0], ...boxes.flatMap((b) => [b[0], b[2]])])].sort((a, b) => a - b);
  const ys = [...new Set([0, bed[1], ...boxes.flatMap((b) => [b[1], b[3]])])].sort((a, b) => a - b);
  const all: BedRect[] = [];
  for (let i = 0; i < xs.length; i++)
    for (let j = i + 1; j < xs.length; j++)
      for (let k = 0; k < ys.length; k++)
        for (let l = k + 1; l < ys.length; l++) {
          const r: BedRect = [xs[i], ys[k], xs[j], ys[l]];
          if (!boxes.some((b) => r[0] < b[2] && b[0] < r[2] && r[1] < b[3] && b[1] < r[3])) all.push(r);
        }
  const inside = (r: BedRect, o: BedRect) => o[0] <= r[0] && o[1] <= r[1] && o[2] >= r[2] && o[3] >= r[3];
  return all.filter((r) => !all.some((o) => o !== r && inside(r, o) && (o[0] !== r[0] || o[1] !== r[1] || o[2] !== r[2] || o[3] !== r[3])));
}

/** How much a w × h mm puzzle can be grown to fit a room less `BED_MARGIN` all round. */
export const roomScale = (r: BedRect, w: number, h: number) => Math.min((r[2] - r[0] - 2 * BED_MARGIN) / w, (r[3] - r[1] - 2 * BED_MARGIN) / h);

/** The room a w × h puzzle can be biggest in (the first on a tie). */
export function bestRoom(rooms: BedRect[], w: number, h: number): BedRect {
  let best = rooms[0];
  for (const r of rooms) if (roomScale(r, w, h) > roomScale(best, w, h) + 1e-9) best = r;
  return best;
}

/**
 * Every piece where it sits in the finished puzzle, on one plate, the whole puzzle centred in `room` (the whole bed
 * unless given; the island puzzle printed put together). `fits` says whether it's within the room less `BED_MARGIN` all
 * round; `size` is the finished puzzle's footprint (mm).
 */
export function platesInPlace(pieces: PuzzlePiece[], bed: [number, number, number], room: BedRect = [0, 0, bed[0], bed[1]]): { plates: Plate[]; size: [number, number]; fits: boolean } {
  if (!pieces.length) return { plates: [], size: [0, 0], fits: true };
  let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const p of pieces) {
    const [a, b, c, d] = footprint(p);
    [x0, y0, x1, y1] = [Math.min(x0, a), Math.min(y0, b), Math.max(x1, c), Math.max(y1, d)];
  }
  const [w, d] = [x1 - x0, y1 - y0];
  const [dx, dy] = [(room[0] + room[2] - w) / 2 - x0, (room[1] + room[3] - d) / 2 - y0];
  const order = [...pieces].sort((a, b) => a.layer - b.layer || a.row - b.row || a.col - b.col);
  const fits = w <= room[2] - room[0] - 2 * BED_MARGIN + 1e-6 && d <= room[3] - room[1] - 2 * BED_MARGIN + 1e-6;
  return { plates: [{ pieces: order.map((p) => ({ piece: p, move: [dx, dy, -p.z0] })) }], size: [w, d], fits };
}

/**
 * Bambu Studio's own settings for each piece when the puzzle is printed put together (per-object keys of its
 * PrintObjectConfig, read from Metadata/model_settings.config): no brim, which would fill the gaps between pieces and
 * join them, and elephant-foot compensation, which draws the first layer this much (mm) smaller all round so its squish
 * doesn't close the gaps — 0.15 is Bambu's own 0.20 mm profiles' value.
 */
export const IN_PLACE_SETTINGS: Readonly<Record<string, string>> = { brim_type: "no_brim", elefant_foot_compensation: "0.15" };

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number) => String(Math.round(v * 1e5) / 1e5);

/** An object's own slicer settings as model_settings.config lines (none when not given). */
const objectSettings = (settings?: Readonly<Record<string, string>>) =>
  Object.entries(settings ?? {}).map(([key, value]) => `    <metadata key="${xmlEscape(key)}" value="${xmlEscape(value)}"/>`);

/** Filament numbers for the parts. */
export const FILAMENT = { rock: 1, snow: 2 } as const;

/** The 3MF files' text parts for one plate: the model and Bambu's settings. */
export function plateFiles(plate: Plate, title: string, settings?: Readonly<Record<string, string>>): { model: string; config: string } {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ` <metadata name="Title">${xmlEscape(title)}</metadata>`,
    ' <metadata name="Application">JuraCAD</metadata>',
    " <resources>",
  ];
  const config: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<config>"];
  const items: string[] = [];
  const instances: string[] = [];
  let id = 1;
  for (const { piece, move } of plate.pieces) {
    const parts: { id: number; part: "rock" | "snow" }[] = [];
    for (const b of piece.bodies) {
      const m = weld(b.vertices, b.triangles);
      if (!m.triangles.length) continue;
      const partId = id++;
      parts.push({ id: partId, part: b.part });
      lines.push(`  <object id="${partId}" type="model" name="${xmlEscape(`${piece.name} ${b.part}`)}">`, "   <mesh>", "    <vertices>");
      for (let v = 0; v < m.vertices.length; v += 3) lines.push(`     <vertex x="${num(m.vertices[v])}" y="${num(m.vertices[v + 1])}" z="${num(m.vertices[v + 2])}"/>`);
      lines.push("    </vertices>", "    <triangles>");
      for (let t = 0; t < m.triangles.length; t += 3) lines.push(`     <triangle v1="${m.triangles[t]}" v2="${m.triangles[t + 1]}" v3="${m.triangles[t + 2]}"/>`);
      lines.push("    </triangles>", "   </mesh>", "  </object>");
    }
    if (!parts.length) continue;
    const objectId = id++;
    lines.push(`  <object id="${objectId}" type="model" name="${xmlEscape(piece.name)}">`, "   <components>");
    for (const p of parts) lines.push(`    <component objectid="${p.id}"/>`);
    lines.push("   </components>", "  </object>");
    items.push(`  <item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 ${move.map(num).join(" ")}" printable="1"/>`);
    config.push(`  <object id="${objectId}">`, `    <metadata key="name" value="${xmlEscape(piece.name)}"/>`, `    <metadata key="extruder" value="${FILAMENT.rock}"/>`, ...objectSettings(settings));
    for (const p of parts)
      config.push(
        `    <part id="${p.id}" subtype="normal_part">`,
        `      <metadata key="name" value="${xmlEscape(`${piece.name} ${p.part}`)}"/>`,
        '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
        `      <metadata key="extruder" value="${FILAMENT[p.part]}"/>`,
        "    </part>",
      );
    config.push("  </object>");
    instances.push("    <model_instance>", `      <metadata key="object_id" value="${objectId}"/>`, '      <metadata key="instance_id" value="0"/>', "    </model_instance>");
  }
  lines.push(" </resources>", " <build>", ...items, " </build>", "</model>", "");
  config.push("  <plate>", '    <metadata key="plater_id" value="1"/>', `    <metadata key="plater_name" value="${xmlEscape(title)}"/>`, '    <metadata key="locked" value="false"/>', ...instances, "  </plate>", "</config>", "");
  return { model: lines.join("\n"), config: config.join("\n") };
}

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
 <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
 <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
 <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>
`;

/** One plate as a .3mf file. */
export function plate3mf(plate: Plate, title: string, settings?: Readonly<Record<string, string>>): Uint8Array {
  const { model, config } = plateFiles(plate, title, settings);
  return zipStored([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: RELS },
    { name: "3D/3dmodel.model", data: model },
    { name: "Metadata/model_settings.config", data: config },
  ]);
}

/** Every plate's .3mf in one .zip. */
export function allPlatesZip(plates: Plate[], name: string, settings?: Readonly<Record<string, string>>): Uint8Array {
  return zipStored(plates.map((p, i) => ({ name: `${name} - plate ${i + 1} of ${plates.length}.3mf`, data: plate3mf(p, `${name} - plate ${i + 1}`, settings) })));
}

// ---------------------------------------------------------------------------------------------------------------
// Colour bands and full colour (the plain plates above are left exactly as they were)

/** A piece's parts for a colour-band plate: one closed mesh per filament band, lowest first. */
export interface BandPartFile {
  filament: number;
  /** "Sand", "Water", … for the part's name. */
  label: string;
  vertices: number[];
  triangles: number[];
  /** Per triangle: a filament painted on (Bambu's paint_color), or 0. */
  paint?: Uint8Array;
}

/**
 * One colour-band plate's 3MF texts: each piece one object of parts, a part per band with its filament in Bambu's
 * model_settings.config (as rock and snow), water painted onto the ground's triangles with `paint_color`.
 * `paintCode(n)` gives the attribute for filament n. The meshes are written as given (already welded, so the paint
 * stays with its triangle).
 */
export function bandPlateFiles(
  plate: Plate,
  title: string,
  partsOf: (p: PuzzlePiece) => BandPartFile[],
  paintCode: (n: number) => string,
  settings?: Readonly<Record<string, string>>,
): { model: string; config: string } {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ` <metadata name="Title">${xmlEscape(title)}</metadata>`,
    ' <metadata name="Application">JuraCAD</metadata>',
    " <resources>",
  ];
  const config: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<config>"];
  const items: string[] = [];
  const instances: string[] = [];
  let id = 1;
  for (const { piece, move } of plate.pieces) {
    const parts: { id: number; part: BandPartFile }[] = [];
    for (const part of partsOf(piece)) {
      if (!part.triangles.length) continue;
      const partId = id++;
      parts.push({ id: partId, part });
      lines.push(`  <object id="${partId}" type="model" name="${xmlEscape(`${piece.name} ${part.label}`)}">`, "   <mesh>", "    <vertices>");
      const v = part.vertices;
      for (let i = 0; i < v.length; i += 3) lines.push(`     <vertex x="${num(v[i])}" y="${num(v[i + 1])}" z="${num(v[i + 2])}"/>`);
      lines.push("    </vertices>", "    <triangles>");
      const t = part.triangles;
      for (let i = 0; i < t.length; i += 3) {
        const paint = part.paint?.[i / 3] ? ` paint_color="${paintCode(part.paint[i / 3])}"` : "";
        lines.push(`     <triangle v1="${t[i]}" v2="${t[i + 1]}" v3="${t[i + 2]}"${paint}/>`);
      }
      lines.push("    </triangles>", "   </mesh>", "  </object>");
    }
    if (!parts.length) continue;
    const objectId = id++;
    lines.push(`  <object id="${objectId}" type="model" name="${xmlEscape(piece.name)}">`, "   <components>");
    for (const p of parts) lines.push(`    <component objectid="${p.id}"/>`);
    lines.push("   </components>", "  </object>");
    items.push(`  <item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 ${move.map(num).join(" ")}" printable="1"/>`);
    config.push(`  <object id="${objectId}">`, `    <metadata key="name" value="${xmlEscape(piece.name)}"/>`, `    <metadata key="extruder" value="${parts[0].part.filament}"/>`, ...objectSettings(settings));
    for (const p of parts)
      config.push(
        `    <part id="${p.id}" subtype="normal_part">`,
        `      <metadata key="name" value="${xmlEscape(`${piece.name} ${p.part.label}`)}"/>`,
        '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
        `      <metadata key="extruder" value="${p.part.filament}"/>`,
        "    </part>",
      );
    config.push("  </object>");
    instances.push("    <model_instance>", `      <metadata key="object_id" value="${objectId}"/>`, '      <metadata key="instance_id" value="0"/>', "    </model_instance>");
  }
  lines.push(" </resources>", " <build>", ...items, " </build>", "</model>", "");
  config.push("  <plate>", '    <metadata key="plater_id" value="1"/>', `    <metadata key="plater_name" value="${xmlEscape(title)}"/>`, '    <metadata key="locked" value="false"/>', ...instances, "  </plate>", "</config>", "");
  return { model: lines.join("\n"), config: config.join("\n") };
}

/** One colour-band plate as a .3mf file, compressed (as Bambu Studio's own are). */
export async function bandPlate3mf(
  plate: Plate,
  title: string,
  partsOf: (p: PuzzlePiece) => BandPartFile[],
  paintCode: (n: number) => string,
  settings?: Readonly<Record<string, string>>,
): Promise<Uint8Array> {
  const { model, config } = bandPlateFiles(plate, title, partsOf, paintCode, settings);
  return zipDeflated([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: RELS },
    { name: "3D/3dmodel.model", data: model },
    { name: "Metadata/model_settings.config", data: config },
  ]);
}

/** The 3MF's fixed texts, for other writers (full colour). */
export const THREE_MF_PARTS = { contentTypes: CONTENT_TYPES, rels: RELS };

/**
 * Plates for colour bands: pieces whose undersides sit at different heights in the puzzle (the mountain's layers) have
 * their band edges at different heights as printed, so a plate mixing them changes filament on almost every layer.
 * Each underside height gets plates of its own (lowest first), laid out as `platesFor` does.
 */
export function platesByLevel(pieces: PuzzlePiece[], bed: [number, number, number]): Plate[] {
  const groups = new Map<number, PuzzlePiece[]>();
  for (const p of pieces) {
    const key = Math.round(p.z0 * 1e4) / 1e4;
    const g = groups.get(key);
    if (g) g.push(p);
    else groups.set(key, [p]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, g]) => platesFor(g, bed));
}
