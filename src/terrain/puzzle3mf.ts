/**
 * Mountain puzzle pieces onto print plates (pure): laid out in rows on the printer's bed, each standing on its
 * underside, and written as 3MF files — one per plate — that Bambu Studio and OrcaSlicer open with the snow ready for
 * a second filament: each piece is one object made of two parts, rock (filament 1) and snow (filament 2), told to the
 * slicer in Metadata/model_settings.config (Bambu's own way). Other slicers see an ordinary 3MF whose pieces have
 * two parts each, to give a filament by hand.
 */
import { weld, zipStored } from "../geometry/threeMf";
import type { PuzzlePiece } from "./mountainPuzzle";

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

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number) => String(Math.round(v * 1e5) / 1e5);

/** Filament numbers for the parts. */
export const FILAMENT = { rock: 1, snow: 2 } as const;

/** The 3MF files' text parts for one plate: the model and Bambu's settings. */
export function plateFiles(plate: Plate, title: string): { model: string; config: string } {
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
    config.push(`  <object id="${objectId}">`, `    <metadata key="name" value="${xmlEscape(piece.name)}"/>`, `    <metadata key="extruder" value="${FILAMENT.rock}"/>`);
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
export function plate3mf(plate: Plate, title: string): Uint8Array {
  const { model, config } = plateFiles(plate, title);
  return zipStored([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: RELS },
    { name: "3D/3dmodel.model", data: model },
    { name: "Metadata/model_settings.config", data: config },
  ]);
}

/** Every plate's .3mf in one .zip. */
export function allPlatesZip(plates: Plate[], name: string): Uint8Array {
  return zipStored(plates.map((p, i) => ({ name: `${name} - plate ${i + 1} of ${plates.length}.3mf`, data: plate3mf(p, `${name} - plate ${i + 1}`) })));
}
