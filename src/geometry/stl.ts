/**
 * Binary STL writer. Format: 80-byte header, uint32 triangle count, then per
 * triangle: normal (3 × float32), three vertices (9 × float32), uint16 attribute.
 * All little-endian. Units are millimetres, which every slicer assumes.
 */

export interface TriangleMesh {
  vertices: ArrayLike<number>;
  triangles: ArrayLike<number>;
}

export function writeBinaryStl(meshes: TriangleMesh[], header = "PartSmith"): ArrayBuffer {
  const total = meshes.reduce((n, m) => n + Math.floor(m.triangles.length / 3), 0);
  const buffer = new ArrayBuffer(84 + total * 50);
  const view = new DataView(buffer);

  const headerBytes = new TextEncoder().encode(header.slice(0, 80));
  new Uint8Array(buffer, 0, 80).set(headerBytes.subarray(0, 80));
  view.setUint32(80, total, true);

  let offset = 84;
  for (const { vertices: v, triangles: t } of meshes) {
    for (let i = 0; i + 2 < t.length; i += 3) {
      const a = 3 * t[i], b = 3 * t[i + 1], c = 3 * t[i + 2];
      const ux = v[b] - v[a], uy = v[b + 1] - v[a + 1], uz = v[b + 2] - v[a + 2];
      const wx = v[c] - v[a], wy = v[c + 1] - v[a + 1], wz = v[c + 2] - v[a + 2];
      let nx = uy * wz - uz * wy;
      let ny = uz * wx - ux * wz;
      let nz = ux * wy - uy * wx;
      const len = Math.hypot(nx, ny, nz) || 1;
      nx /= len;
      ny /= len;
      nz /= len;

      const values = [nx, ny, nz, v[a], v[a + 1], v[a + 2], v[b], v[b + 1], v[b + 2], v[c], v[c + 1], v[c + 2]];
      for (const value of values) {
        view.setFloat32(offset, value, true);
        offset += 4;
      }
      view.setUint16(offset, 0, true);
      offset += 2;
    }
  }
  return buffer;
}

/** Read a binary STL back (used by tests and, later, STL import). */
export function readBinaryStl(buffer: ArrayBuffer): { triangleCount: number; vertices: Float32Array } {
  const view = new DataView(buffer);
  const triangleCount = view.getUint32(80, true);
  const vertices = new Float32Array(triangleCount * 9);
  let offset = 84;
  for (let t = 0; t < triangleCount; t++) {
    offset += 12; // skip normal
    for (let k = 0; k < 9; k++) {
      vertices[t * 9 + k] = view.getFloat32(offset, true);
      offset += 4;
    }
    offset += 2;
  }
  return { triangleCount, vertices };
}
