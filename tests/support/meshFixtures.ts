/** Small hand-made 3MF and OBJ files for the import tests. */
import { zipStored } from "../../src/geometry/threeMf";
import { zipDeflated } from "../../src/geometry/zipDeflate";

/** A cube's 8 corners (0…s) and its 6 faces as quads, each walked anticlockwise seen from outside. */
export function cubeCorners(s: number): number[][] {
  return [
    [0, 0, 0], [s, 0, 0], [s, s, 0], [0, s, 0],
    [0, 0, s], [s, 0, s], [s, s, s], [0, s, s],
  ];
}
export const CUBE_QUADS = [
  [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
];

/** An OBJ cube made of quads (1-based indices, with texture/normal forms mixed in). */
export function objCube(s: number, opts: { negative?: boolean; at?: number[] } = {}): string {
  const [dx, dy, dz] = opts.at ?? [0, 0, 0];
  const lines = ["# a cube", "o Cube"];
  for (const [x, y, z] of cubeCorners(s)) lines.push(`v ${x + dx} ${y + dy} ${z + dz}`);
  lines.push("vt 0 0", "vn 0 0 1");
  CUBE_QUADS.forEach((q, k) => {
    const idx = q.map((i) => (opts.negative ? i - 8 : i + 1));
    const forms = [(i: number) => `${i}`, (i: number) => `${i}/1`, (i: number) => `${i}//1`, (i: number) => `${i}/1/1`];
    lines.push(`f ${idx.map(forms[k % 4]).join(" ")}`);
  });
  return lines.join("\n") + "\n";
}

/** A 3MF mesh object (triangles) for a cube of side s. */
export function cubeObject(id: number, s: number): string {
  const v = cubeCorners(s).map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("");
  const t = CUBE_QUADS.flatMap(([a, b, c, d]) => [`<triangle v1="${a}" v2="${b}" v3="${c}"/>`, `<triangle v1="${a}" v2="${c}" v3="${d}"/>`]).join("");
  return `<object id="${id}" type="model"><mesh><vertices>${v}</vertices><triangles>${t}</triangles></mesh></object>`;
}

export function modelXml(body: string, items: string, unit = "millimeter"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="${unit}" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${body}</resources><build>${items}</build></model>`;
}

const RELS = `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`;

/** A 3MF zip of the given model (and other files), stored or deflated. */
export async function threeMf(model: string, more: { name: string; data: string }[] = [], deflate = false): Promise<Uint8Array> {
  const files = [{ name: "_rels/.rels", data: RELS }, { name: "3D/3dmodel.model", data: model }, ...more];
  return deflate ? zipDeflated(files) : zipStored(files);
}

const PROD = 'xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';

/**
 * A Bambu Studio–style project: 3D/3dmodel.model's objects are components in 3D/Objects/object_N.model (p:path), the
 * build items sit at the plate's middle (128, 128) and a second plate's 307.2 mm along; Metadata/model_settings.config
 * marks part 3 a modifier and part 4 a negative part (or, `onlyModifiers`, the only part).
 */
export async function bambuProject(opts: { onlyModifiers?: boolean } = {}): Promise<Uint8Array> {
  const comp = (id: number, file: string, t = "1 0 0 0 1 0 0 0 1 0 0 0") => `<component p:path="/3D/Objects/${file}" objectid="${id}" p:UUID="0000-${id}" transform="${t}"/>`;
  const main = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:BambuStudio="http://schemas.bambulab.com/package/2021" ${PROD} requiredextensions="p"><metadata name="Application">BambuStudio-01.10.00.00</metadata><resources>` +
    `<object id="8" p:UUID="8" type="model"><components>${opts.onlyModifiers ? comp(3, "object_1.model") : comp(1, "object_1.model", "1 0 0 0 1 0 0 0 1 -10 -10 0") + comp(3, "object_1.model") + comp(4, "object_1.model")}</components></object>` +
    `<object id="9" p:UUID="9" type="model"><components>${comp(5, "object_2.model", "1 0 0 0 1 0 0 0 1 -5 -5 0")}</components></object>` +
    `</resources><build p:UUID="b"><item objectid="8" p:UUID="i8" transform="1 0 0 0 1 0 0 0 1 128 128 0" printable="1"/>` +
    (opts.onlyModifiers ? "" : `<item objectid="9" p:UUID="i9" transform="1 0 0 0 1 0 0 0 1 435.2 128 0" printable="1"/>`) +
    `</build></model>`;
  const sub1 = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ${PROD} requiredextensions="p"><resources>${cubeObject(1, 20)}${cubeObject(3, 30)}${cubeObject(4, 5)}</resources><build/></model>`;
  const sub2 = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" ${PROD}><resources>${cubeObject(5, 10)}</resources><build/></model>`;
  const config = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <object id="8">\n    <metadata key="name" value="Cube"/>\n    <part id="1" subtype="normal_part"><metadata key="name" value="Cube"/></part>\n    <part id="3" subtype="modifier_part"><metadata key="name" value="Modifier"/></part>\n    <part id="4" subtype="negative_part"/>\n  </object>\n  <object id="9"><part id="5" subtype="normal_part"/></object>\n  <plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="8"/></model_instance></plate>\n</config>`;
  return threeMf(main, [
    { name: "3D/Objects/object_1.model", data: sub1 },
    { name: "3D/Objects/object_2.model", data: sub2 },
    { name: "Metadata/model_settings.config", data: config },
    { name: "Metadata/project_settings.config", data: "{}" },
  ], true);
}

/** A PrusaSlicer-style project: one mesh holding a 10 mm cube (triangles 0–11) and a modifier cube (12–23). */
export async function prusaProject(): Promise<Uint8Array> {
  const a = cubeCorners(10), b = cubeCorners(40).map(([x, y, z]) => [x + 50, y, z]);
  const v = [...a, ...b].map(([x, y, z]) => `<vertex x="${x}" y="${y}" z="${z}"/>`).join("");
  const tris = (o: number) => CUBE_QUADS.flatMap(([p, q, r, s]) => [`<triangle v1="${p + o}" v2="${q + o}" v3="${r + o}"/>`, `<triangle v1="${p + o}" v2="${r + o}" v3="${s + o}"/>`]).join("");
  const model = modelXml(`<object id="1" type="model"><mesh><vertices>${v}</vertices><triangles>${tris(0)}${tris(8)}</triangles></mesh></object>`, `<item objectid="1" transform="1 0 0 0 1 0 0 0 1 125 105 0" printable="1"/>`);
  const config = `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n <object id="1" instances_count="1">\n  <metadata type="object" key="name" value="cube"/>\n  <volume firstid="0" lastid="11">\n   <metadata type="volume" key="name" value="cube"/>\n   <metadata type="volume" key="volume_type" value="ModelPart"/>\n  </volume>\n  <volume firstid="12" lastid="23">\n   <metadata type="volume" key="volume_type" value="ParameterModifier"/>\n   <metadata type="volume" key="modifier" value="1"/>\n  </volume>\n </object>\n</config>`;
  return threeMf(model, [{ name: "Metadata/Slic3r_PE_model.config", data: config }], true);
}
