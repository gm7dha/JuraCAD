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
