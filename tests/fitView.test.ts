import { describe, expect, it } from "vitest";
import { fitDistance } from "../src/viewport/fitView";

/** Where a point lands on the screen, as a share of the half width and half height (1 = the edge). */
function onScreen(p: [number, number, number], dir: [number, number, number], d: number, fov: number, aspect: number): [number, number] {
  const [dx, dy, dz] = dir;
  const rl = Math.hypot(dy, dx);
  const r = [-dy / rl, dx / rl, 0];
  const u = [r[1] * -dz - r[2] * -dy, r[2] * -dx - r[0] * -dz, r[0] * -dy - r[1] * -dx];
  const depth = d - (p[0] * dx + p[1] * dy + p[2] * dz);
  const t = Math.tan((fov * Math.PI) / 360);
  return [Math.abs(p[0] * r[0] + p[1] * r[1] + p[2] * r[2]) / depth / (t * aspect), Math.abs(p[0] * u[0] + p[1] * u[1] + p[2] * u[2]) / depth / t];
}

describe("fitDistance", () => {
  const n = Math.hypot(0.9, 1.9, 1.4);
  const dir: [number, number, number] = [0.9 / n, -1.9 / n, 1.4 / n];
  // A flat puzzle 240 × 180 mm and 30 mm tall, seen in a tall narrow view and a wide one.
  const box: [number, number, number][] = [];
  for (const x of [-120, 120]) for (const y of [-90, 90]) for (const z of [-15, 15]) box.push([x, y, z]);
  for (const aspect of [380 / 494, 2.2]) {
    it(`keeps every corner in view and one on the edge (aspect ${aspect.toFixed(2)})`, () => {
      const d = fitDistance(box, dir, 35, aspect);
      const most = Math.max(...box.flatMap((p) => onScreen(p, dir, d, 35, aspect)));
      expect(most).toBeLessThanOrEqual(1 + 1e-9);
      expect(most).toBeGreaterThan(0.999);
    });
  }
});
