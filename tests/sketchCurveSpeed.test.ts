/**
 * Sketches with Tangent, Normal and offset copies on splines and ellipses must
 * never freeze the app, even when what's asked can't be met. Time bounds here
 * are generous (CI machines are often busy); locally each step takes well under
 * half a second.
 */
import { describe, expect, it } from "vitest";

import { addCircle, addLine, applyRelation, dragPoint, type RelationTool } from "../src/sketch/ops";
import { addConic, addEllipse, addSpline, offsetCurves, splitAt, trimAt } from "../src/sketch/tools";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { placedByOffset } from "../src/sketch/solver";

const at = (x: number, y: number) => ({ x, y, snap: null });

/** Found by a reviewer: a Tangent between an offset copy and a conic that can't be met took 9.6 s before being refused. */
const STUCK = {
  points: [
    { id: "p0", x: 18.907734248787165, y: 13.479827709496021 },
    { id: "p1", x: 26.907734248787165, y: 12.800209234468639 },
    { id: "p2", x: 34.907734248787165, y: 16.231757568195462 },
    { id: "p3", x: -24.7329644050205, y: -14.892871989278555 },
    { id: "p4", x: -16.59836754486444, y: -3.736995798515652 },
    { id: "p5", x: -8.618438028277327, y: -13.891452784758576 },
    { id: "p6", x: -21.990552831200603, y: -6.1565954399599105 },
    { id: "p7", x: -14.77956059909192, y: -10.155893213674428 },
    { id: "p8", x: -5.912698916146879, y: -10.906583983606376 },
    { id: "p9", x: 18.957857155901564, y: 14.069840005584693 },
    { id: "p10", x: 21.00427486001453, y: 13.797782241667763 },
    { id: "p11", x: 22.995107816981808, y: 13.468726311312787 },
    { id: "p12", x: 26.807362990900863, y: 13.383777933032695 },
    { id: "p13", x: 28.69702623154603, y: 13.92240947015122 },
    { id: "p14", x: 30.64582353821319, y: 14.790100062290227 },
    { id: "p15", x: 34.67430879600752, y: 16.775944460125103 },
  ],
  curves: [
    { id: "s0", type: "spline", points: ["p0", "p1", "p2"], closed: false, construction: false },
    { id: "s1", type: "spline", points: ["p3", "p4", "p5"], closed: false, construction: false, conic: 0.4 },
    { id: "s2", type: "spline", points: ["p6", "p7", "p8"], closed: false, construction: false },
    {
      id: "s3",
      type: "spline",
      points: ["p9", "p10", "p11", "p12", "p13", "p14", "p15"],
      closed: false,
      construction: false,
      tangents: {
        p9: [2.075258088054138, -0.17629796713644907],
        p10: [2.01826531941747, -0.33351538951916027],
        p11: [3.926396704331797, -0.5857763395821092],
        p12: [1.8543615808562066, 0.3189420626989534],
        p13: [1.9223843378075465, 0.7319782212037609],
        p14: [3.945120263346741, 1.945656475180158],
        p15: [4.118098455582739, 1.7664317366722422],
      },
      tangentsIn: { p11: [1.9631983521659038, -0.2928881697910519], p12: [3.7087231617124132, 0.6378841253979122], p14: [1.9725601316733652, 0.972828237590079] },
      offsetParams: [0, 0.25, 0.5, 1, 1.25, 1.5, 2],
    },
  ],
  constraints: [
    { id: "k0", type: "offset", refs: ["s3", "s0"], value: "0.5921374972676858", extra: [1], labelOffset: { x: 0, y: 0 } },
    { id: "k1", type: "fix", refs: ["p14"], extra: [30.64582353821319, 14.790100062290227] },
    { id: "k2", type: "tangent", refs: ["s2", "s1"] },
  ],
} as unknown as SketchData;

describe("no freezing", () => {
  it("a Tangent that can't be met is refused quickly", () => {
    const t = performance.now();
    const r = applyRelation(STUCK, "tangent", ["s3", "s1"]);
    expect(performance.now() - t).toBeLessThan(3000); // about 0.1 s here
    expect(r.error).toMatch(/conflict/);
    const plain = { ...STUCK, constraints: STUCK.constraints.filter((k) => k.type !== "offset") };
    const t2 = performance.now();
    applyRelation(plain, "tangent", ["s3", "s1"]);
    expect(performance.now() - t2).toBeLessThan(3000);
  });

  it("picking the same curve twice is just one curve", () => {
    const s = addSpline(emptySketch(), [at(0, 0), at(10, 8), at(20, 0)], false);
    expect(applyRelation(s.sketch, "tangent", [s.splineId, s.splineId]).error).toBeTruthy();
    expect(applyRelation(s.sketch, "curvature", [s.splineId, s.splineId]).error).toBeTruthy();
  });

  it("random drawing, relations, drags, offsets, trims and splits: no step takes long", () => {
    let worst = 0;
    let worstWhat = "";
    for (const seed of [4, 11]) {
      let state = seed >>> 0;
      const r = () => ((state = (state * 1664525 + 1013904223) >>> 0) / 4294967296);
      const R = (a: number, b: number) => a + (b - a) * r();
      let s: SketchData = emptySketch();
      for (let i = 0; i < 200; i++) {
        const kind = Math.floor(r() * 10);
        let what = "";
        const t0 = performance.now();
        if (s.curves.length < 4 || kind === 0) {
          const k = Math.floor(r() * 5);
          const x = R(-30, 30), y = R(-30, 30);
          what = `add ${k}`;
          if (k === 0) s = addSpline(s, [at(x, y), at(x + R(3, 10), y + R(-8, 8)), at(x + R(10, 20), y + R(-8, 8))], false).sketch;
          else if (k === 1) s = addConic(s, at(x, y), at(x + R(5, 15), y), at(x + R(2, 8), y + R(3, 10)), R(0.2, 0.8)).sketch;
          else if (k === 2) s = addEllipse(s, at(x, y), at(x + R(4, 12), y + R(-3, 3)), [x, y + R(2, 6)]).sketch;
          else if (k === 3) s = addLine(s, at(x, y), at(x + R(-15, 15), y + R(-15, 15))).sketch;
          else s = addCircle(s, at(x, y), R(1, 6)).sketch;
        } else if (kind <= 4) {
          const ids = s.curves.map((c) => c.id);
          const tools: RelationTool[] = ["tangent", "normal", "curvature", "concentric", "equal", "tangent", "tangent"];
          const tool = tools[Math.floor(r() * tools.length)];
          const pick = [ids[Math.floor(r() * ids.length)], ids[Math.floor(r() * ids.length)]];
          what = `${tool} ${pick.join(" ")}`;
          s = applyRelation(s, tool, pick).sketch;
        } else if (kind <= 7) {
          const p = s.points[Math.floor(r() * s.points.length)];
          what = `drag ${p.id}`;
          s = dragPoint(s, p.id, p.x + R(-3, 3), p.y + R(-3, 3));
        } else if (kind === 8) {
          const c = s.curves[Math.floor(r() * s.curves.length)];
          what = `offset ${c.id}`;
          s = offsetCurves(s, c.id, at(R(-30, 30), R(-30, 30)), String(R(0.3, 2))).sketch;
        } else {
          const c = s.curves[Math.floor(r() * s.curves.length)];
          what = `cut ${c.id}`;
          s = (r() < 0.5 ? trimAt(s, c.id, at(R(-30, 30), R(-30, 30))) : splitAt(s, c.id, at(R(-30, 30), R(-30, 30)))).sketch;
        }
        const dt = performance.now() - t0;
        if (dt > worst) [worst, worstWhat] = [dt, `seed ${seed} step ${i}: ${what}`];
        if (s.curves.length > 14) s = emptySketch();
      }
    }
    // Under a second at worst here; generous for busy CI machines. On failure this names the slow step.
    console.log(`worst step ${Math.round(worst)} ms: ${worstWhat}`);
    expect(worst < 4000 ? "quick" : `${Math.round(worst)} ms at ${worstWhat}`).toBe("quick");
  });
});

describe("dragging an offset copy", () => {
  it("leaves it where its original puts it, straight away", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(15, 6), at(30, -3)], false);
    const o = offsetCurves(sp.sketch, sp.splineId, at(15, 9), "2");
    const copy = o.sketch.curves.find((c) => c.id === o.curveIds[0]) as { points: string[] };
    const mid = copy.points[Math.floor(copy.points.length / 2)];
    const before = o.sketch.points.find((p) => p.id === mid)!;
    const after = dragPoint(o.sketch, mid, before.x + 5, before.y + 5).points.find((p) => p.id === mid)!;
    expect(Math.hypot(after.x - before.x, after.y - before.y)).toBeLessThan(1e-9);
  });
});

describe("telling an offset copy's point from others", () => {
  it("knows a point only its original places", () => {
    const sp = addSpline(emptySketch(), [at(0, 0), at(15, 6), at(30, -3)], false);
    const o = offsetCurves(sp.sketch, sp.splineId, at(15, 9), "2");
    const copy = o.sketch.curves.find((c) => c.id === o.curveIds[0]) as { points: string[] };
    expect(placedByOffset(o.sketch, copy.points[1])).toBe(true);
    expect(placedByOffset(o.sketch, (o.sketch.curves.find((c) => c.id === sp.splineId) as { points: string[] }).points[1])).toBe(false);
  });
});
