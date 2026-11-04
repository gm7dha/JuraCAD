/** Small triangle meshes made in code, for the Simplify tests. */
import { cross, dot, sub, type Vec3 } from "../../src/geometry/shapeFit";

/** A triangle mesh built up corner by corner, each triangle turned to face `out`. */
export class MeshBuilder {
  vertices: number[] = [];
  triangles: number[] = [];
  point(p: Vec3): number {
    this.vertices.push(...p);
    return this.vertices.length / 3 - 1;
  }
  at(i: number): Vec3 {
    return [this.vertices[3 * i], this.vertices[3 * i + 1], this.vertices[3 * i + 2]];
  }
  tri(a: number, b: number, c: number, out: Vec3) {
    const n = cross(sub(this.at(b), this.at(a)), sub(this.at(c), this.at(a)));
    if (dot(n, out) >= 0) this.triangles.push(a, b, c);
    else this.triangles.push(a, c, b);
  }
  quad(a: number, b: number, c: number, d: number, out: Vec3) {
    this.tri(a, b, c, out);
    this.tri(a, c, d, out);
  }
}

/** A washer: outside Ø20, hole Ø8, 3 thick, faceted with `n` sides (corners moved by up to `wobble`). */
export function washer(n = 48, wobble = 0): MeshBuilder {
  const m = new MeshBuilder();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * wobble;
  const ring = (r: number, z: number) => Array.from({ length: n }, (_, i) => m.point([r * Math.cos((2 * Math.PI * i) / n) + rnd(), r * Math.sin((2 * Math.PI * i) / n) + rnd(), z]));
  const ot = ring(10, 3);
  const ob = ring(10, 0);
  const it = ring(4, 3);
  const ib = ring(4, 0);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const a = (2 * Math.PI * (i + 0.5)) / n;
    const radial: Vec3 = [Math.cos(a), Math.sin(a), 0];
    m.quad(ot[i], ot[j], it[j], it[i], [0, 0, 1]);
    m.quad(ob[i], ob[j], ib[j], ib[i], [0, 0, -1]);
    m.quad(ob[i], ob[j], ot[j], ot[i], radial);
    m.quad(ib[i], ib[j], it[j], it[i], [-radial[0], -radial[1], 0]);
  }
  return m;
}


/** Bytes as base64 (how an imported STL is kept in the design). */
export function base64(bytes: Uint8Array): string {
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s);
}
