/**
 * A 3MF for multi-colour printing (pure): parts whose faces have colours of their own. Every distinct colour is a
 * filament, numbered from 1 — the parts' own colours first, then the face colours — and written two ways:
 *  - for Bambu Studio (and Orca): each part's own colour as its filament (`extruder` in Metadata/model_settings.config,
 *    as the puzzles' files do) and every face of another colour painted with that filament (`paint_color` on its
 *    triangles — TriangleSelector's code, paintCode.ts). Bambu Studio reads painting from any 3MF and, when a file has
 *    painting, ignores the plain colours below (BambuStudio Plater.cpp: "has_painting" before standard_3mf colours).
 *  - for other slicers: the core 3MF colours — one <basematerials> entry per filament, the object pointing at its own
 *    colour and each painted triangle at its face's (`pid`/`p1`).
 * Plain exports without face colours keep using threeMf.ts's write3mf, byte for byte as before.
 */
import { paintCode } from "./paintCode";
import { zipStored } from "./threeMf";

/** One filament: a colour, and the Bambu Lab spool it is when that's known. */
export interface Filament {
  /** "#rrggbb". */
  colour: string;
  /** Bambu's colour code (bambuColours.ts). */
  spool?: string;
}

/** A part to write: its mesh, its own filament, and per triangle which of `faceFilaments` it is painted with. */
export interface PaintedPart {
  name: string;
  vertices: ArrayLike<number>;
  triangles: ArrayLike<number>;
  /** The part's own colour (missing = the usual grey) and spool. */
  own: Filament;
  /** The colours its faces have of their own. */
  faceFilaments: Filament[];
  /** Per triangle: 0 = the part's own colour, k = faceFilaments[k − 1]. */
  paint: ArrayLike<number>;
  /** Where the build puts it: a move (x, y, z mm). */
  move?: [number, number, number];
}

/** The usual grey parts are shown in (colours.ts DEFAULT_PART_COLOUR), so an uncoloured part is still a filament. */
const GREY = "#a8b4c0";

const plainHex = (c: string | undefined) => (c ?? GREY).toLowerCase().slice(0, 7);

/**
 * Number the filaments: each distinct colour once (the first spool named for it kept), parts' own colours first in
 * part order, then face colours. Returns the list and, per part, its own filament's number and its face filaments'.
 */
export function planFilaments(parts: readonly Pick<PaintedPart, "own" | "faceFilaments" | "paint">[]): { filaments: Filament[]; own: number[]; faces: number[][] } {
  const filaments: Filament[] = [];
  const numberOf = (f: Filament) => {
    const hex = plainHex(f.colour);
    let i = filaments.findIndex((x) => x.colour === hex);
    if (i < 0) i = filaments.push({ colour: hex, ...(f.spool ? { spool: f.spool } : {}) }) - 1;
    else if (!filaments[i].spool && f.spool) filaments[i] = { ...filaments[i], spool: f.spool };
    return i + 1;
  };
  const own = parts.map((p) => numberOf(p.own));
  const faces = parts.map((p) => {
    const used = new Set<number>();
    for (let t = 0; t < p.paint.length; t++) if (p.paint[t]) used.add(p.paint[t]);
    // Only colours some triangle really has become filaments.
    return p.faceFilaments.map((f, k) => (used.has(k + 1) ? numberOf(f) : 0));
  });
  return { filaments, own, faces };
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** Weld repeated corners (as threeMf.ts's weld), keeping each triangle's paint with it. */
function weldPainted(vertices: ArrayLike<number>, triangles: ArrayLike<number>, paint: ArrayLike<number>): { vertices: number[]; triangles: number[]; paint: number[] } {
  const index = new Map<string, number>();
  const remap: number[] = [];
  const out: number[] = [];
  for (let i = 0; i < vertices.length / 3; i++) {
    const x = vertices[i * 3];
    const y = vertices[i * 3 + 1];
    const z = vertices[i * 3 + 2];
    const key = `${Math.round(x * 1e5)},${Math.round(y * 1e5)},${Math.round(z * 1e5)}`;
    let j = index.get(key);
    if (j === undefined) {
      j = out.length / 3;
      index.set(key, j);
      out.push(x, y, z);
    }
    remap.push(j);
  }
  const tris: number[] = [];
  const kept: number[] = [];
  for (let t = 0; t < triangles.length; t += 3) {
    const a = remap[triangles[t]];
    const b = remap[triangles[t + 1]];
    const c = remap[triangles[t + 2]];
    if (a !== b && b !== c && a !== c) {
      tris.push(a, b, c);
      kept.push(paint[t / 3] ?? 0);
    }
  }
  return { vertices: out, triangles: tris, paint: kept };
}

/** The model and Bambu's settings for a painted 3MF. */
export function filamentFiles(parts: PaintedPart[], title: string): { model: string; config: string; filaments: Filament[] } {
  const plan = planFilaments(parts);
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ` <metadata name="Title">${xmlEscape(title)}</metadata>`,
    ' <metadata name="Application">JuraCAD</metadata>',
    " <resources>",
    '  <basematerials id="1">',
    ...plan.filaments.map((f, i) => `   <base name="${xmlEscape(`Filament ${i + 1}`)}" displaycolor="${f.colour.toUpperCase()}"/>`),
    "  </basematerials>",
  ];
  const config: string[] = ['<?xml version="1.0" encoding="UTF-8"?>', "<config>"];
  const items: string[] = [];
  const instances: string[] = [];
  let id = 2;
  parts.forEach((p, n) => {
    const m = weldPainted(p.vertices, p.triangles, p.paint);
    if (!m.triangles.length) return;
    const own = plan.own[n];
    const meshId = id++;
    lines.push(`  <object id="${meshId}" type="model" name="${xmlEscape(p.name)}" pid="1" pindex="${own - 1}">`, "   <mesh>", "    <vertices>");
    for (let v = 0; v < m.vertices.length; v += 3) lines.push(`     <vertex x="${num(m.vertices[v])}" y="${num(m.vertices[v + 1])}" z="${num(m.vertices[v + 2])}"/>`);
    lines.push("    </vertices>", "    <triangles>");
    for (let t = 0; t < m.triangles.length; t += 3) {
      const k = m.paint[t / 3];
      const f = k ? plan.faces[n][k - 1] : 0;
      const extra = f && f !== own ? ` pid="1" p1="${f - 1}" paint_color="${paintCode(f)}"` : "";
      lines.push(`     <triangle v1="${m.triangles[t]}" v2="${m.triangles[t + 1]}" v3="${m.triangles[t + 2]}"${extra}/>`);
    }
    lines.push("    </triangles>", "   </mesh>", "  </object>");
    // One object holding the part as a component, as Bambu Studio's own files are (and the puzzles' are).
    const objectId = id++;
    lines.push(`  <object id="${objectId}" type="model" name="${xmlEscape(p.name)}">`, "   <components>", `    <component objectid="${meshId}"/>`, "   </components>", "  </object>");
    const move = p.move ?? [0, 0, 0];
    items.push(`  <item objectid="${objectId}" transform="1 0 0 0 1 0 0 0 1 ${move.map(num).join(" ")}" printable="1"/>`);
    config.push(
      `  <object id="${objectId}">`,
      `    <metadata key="name" value="${xmlEscape(p.name)}"/>`,
      `    <metadata key="extruder" value="${own}"/>`,
      `    <part id="${meshId}" subtype="normal_part">`,
      `      <metadata key="name" value="${xmlEscape(p.name)}"/>`,
      '      <metadata key="matrix" value="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>',
      `      <metadata key="extruder" value="${own}"/>`,
      "    </part>",
      "  </object>",
    );
    instances.push("    <model_instance>", `      <metadata key="object_id" value="${objectId}"/>`, '      <metadata key="instance_id" value="0"/>', "    </model_instance>");
  });
  lines.push(" </resources>", " <build>", ...items, " </build>", "</model>", "");
  config.push("  <plate>", '    <metadata key="plater_id" value="1"/>', `    <metadata key="plater_name" value="${xmlEscape(title)}"/>`, '    <metadata key="locked" value="false"/>', ...instances, "  </plate>", "</config>", "");
  return { model: lines.join("\n"), config: config.join("\n"), filaments: plan.filaments };
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

/** A painted .3mf file, and the filaments it uses (in number order). */
export function writeFilament3mf(parts: PaintedPart[], title = "JuraCAD model"): { bytes: Uint8Array; filaments: Filament[] } {
  const { model, config, filaments } = filamentFiles(parts, title);
  const bytes = zipStored([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: RELS },
    { name: "3D/3dmodel.model", data: model },
    { name: "Metadata/model_settings.config", data: config },
  ]);
  return { bytes, filaments };
}
