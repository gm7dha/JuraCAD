/**
 * 3MF export: the modern alternative to STL that slicers (Bambu Studio,
 * PrusaSlicer, Cura) and many print services prefer. It stores each part
 * separately with its name, in millimetres, with shared corners so the
 * surface is properly joined up.
 *
 * A 3MF file is a zip containing a few small XML files. The zip is written
 * here without compression ("stored"), which every unzip tool can read.
 */

export interface MeshPart {
  name: string;
  /** x, y, z for each corner (corners may be repeated). */
  vertices: ArrayLike<number>;
  /** Three corner indices per triangle. */
  triangles: ArrayLike<number>;
  /** Display colour "#rrggbb", if the part has one. */
  colour?: string;
}

/** Merge repeated corners (same position to 0.01 µm) so triangles share them. */
export function weld(vertices: ArrayLike<number>, triangles: ArrayLike<number>): { vertices: number[]; triangles: number[] } {
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
  for (let t = 0; t < triangles.length; t += 3) {
    const a = remap[triangles[t]];
    const b = remap[triangles[t + 1]];
    const c = remap[triangles[t + 2]];
    if (a !== b && b !== c && a !== c) tris.push(a, b, c);
  }
  return { vertices: out, triangles: tris };
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

/** The 3D/3dmodel.model file. */
export function modelXml(parts: MeshPart[], title: string): string {
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="en-GB" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    ` <metadata name="Title">${xmlEscape(title)}</metadata>`,
    ' <metadata name="Application">PartSmith</metadata>',
    " <resources>",
  ];
  // Colours (if any part has one) go in a material list that each object points to.
  const coloured = parts.some((p) => p.colour);
  const firstObject = coloured ? 2 : 1;
  if (coloured) {
    lines.push('  <basematerials id="1">');
    for (const p of parts) lines.push(`   <base name="${xmlEscape(p.name)}" displaycolor="${(p.colour ?? "#A8B4C0").toUpperCase()}"/>`);
    lines.push("  </basematerials>");
  }
  parts.forEach((p, i) => {
    const m = weld(p.vertices, p.triangles);
    const material = coloured ? ` pid="1" pindex="${i}"` : "";
    lines.push(`  <object id="${i + firstObject}" type="model" name="${xmlEscape(p.name)}"${material}>`, "   <mesh>", "    <vertices>");
    for (let v = 0; v < m.vertices.length; v += 3) lines.push(`     <vertex x="${num(m.vertices[v])}" y="${num(m.vertices[v + 1])}" z="${num(m.vertices[v + 2])}"/>`);
    lines.push("    </vertices>", "    <triangles>");
    for (let t = 0; t < m.triangles.length; t += 3) lines.push(`     <triangle v1="${m.triangles[t]}" v2="${m.triangles[t + 1]}" v3="${m.triangles[t + 2]}"/>`);
    lines.push("    </triangles>", "   </mesh>", "  </object>");
  });
  lines.push(" </resources>", " <build>");
  parts.forEach((_, i) => lines.push(`  <item objectid="${i + firstObject}"/>`));
  lines.push(" </build>", "</model>", "");
  return lines.join("\n");
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

/** A complete .3mf file. */
export function write3mf(parts: MeshPart[], title = "PartSmith model"): Uint8Array {
  return zipStored([
    { name: "[Content_Types].xml", data: CONTENT_TYPES },
    { name: "_rels/.rels", data: RELS },
    { name: "3D/3dmodel.model", data: modelXml(parts, title) },
  ]);
}

// ---------------------------------------------------------------------------
// A minimal zip writer (no compression).

let crcTable: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipStored(files: { name: string; data: string | Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  // Fixed date (1 Jan 2020) keeps files identical for identical models.
  const dosTime = 0;
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;

  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    chunks.push(new Uint8Array(local.buffer), name, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true);
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, dosTime, true);
    cen.setUint16(14, dosDate, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true);
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
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
