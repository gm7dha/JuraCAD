/**
 * Frames, more (pure): path pieces from part edges and curves (lines, arcs and sampled curves; the profile carried
 * along them), mitres where three or more meet (a cube's corner), reading the new fields, Delete with dependents,
 * and the Cut list table on a drawing sheet.
 */
import { describe, expect, it } from "vitest";
import { builtInProfile, placedProfile, type ProfileShape } from "../src/model/frameProfiles";
import { buildMembers, curveAcross, cutList, edgeKeyFor, edgeSegment, findCorners, frameLayout, laterPathMessage, memberInfo, parseFrameDef, planFrame, segFrames, togglePathCurve, togglePathEdge, withPathNormal, type CurveSeg, type PathSeg, type V3 } from "../src/model/frame";
import type { FrameDef } from "../src/model/frameTypes";
import type { Feature } from "../src/model/types";
import { findDependents, withoutGone } from "../src/model/dependents";
import { parsePick, type TopoPick } from "../src/geometry/topoRef";
import { cutListRows, NO_MEMBERS, sheetCutList } from "../src/drawing/cutListTable";
import type { PartMesh } from "../src/kernel/protocol";

const square = (s: number): ProfileShape => {
  const p = builtInProfile("timber", `${s}x${s}`);
  if (typeof p === "string") throw new Error(p);
  return placedProfile(p, undefined, false, 0);
};
const line = (id: string, a: V3, b: V3): PathSeg => ({ kind: "line", id, a, b, n: [0, 0, 1] });
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A helix round Z sampled as an edge would be: points and unit tangents, and its length. */
function helixSamples(r: number, pitch: number, turns: number, n: number): { pts: V3[]; tans: V3[]; length: number } {
  const pts: V3[] = [];
  const tans: V3[] = [];
  const k = pitch / (2 * Math.PI);
  const sp = Math.hypot(r, k);
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * turns * i) / n;
    pts.push([r * Math.cos(t), r * Math.sin(t), k * t]);
    tans.push([(-r * Math.sin(t)) / sp, (r * Math.cos(t)) / sp, k / sp]);
  }
  return { pts, tans, length: 2 * Math.PI * turns * sp };
}

describe("path pieces from edges and curves", () => {
  it("a straight edge is a line, a round one an arc (or a whole circle), anything else a curve", () => {
    const l = edgeSegment("p/e0", [[0, 0, 0], [5, 0, 0], [10, 0, 0]], [[1, 0, 0], [1, 0, 0], [1, 0, 0]], 10);
    expect(l?.kind).toBe("line");
    const q: V3[] = [];
    const t: V3[] = [];
    for (let i = 0; i <= 16; i++) {
      const a = ((Math.PI / 2) * i) / 16;
      q.push([10 * Math.cos(a), 10 * Math.sin(a), 3]);
      t.push([-Math.sin(a), Math.cos(a), 0]);
    }
    const arc = edgeSegment("p/e1", q, t, 5 * Math.PI);
    expect(arc?.kind).toBe("arc");
    if (arc?.kind === "arc") {
      expect(arc.angle).toBeCloseTo(Math.PI / 2, 6);
      expect(arc.r).toBeCloseTo(10, 6);
      expect(arc.c[2]).toBeCloseTo(3, 6);
    }
    const c: V3[] = [];
    const ct: V3[] = [];
    for (let i = 0; i <= 32; i++) {
      const a = (2 * Math.PI * i) / 32;
      c.push([10 * Math.cos(a), 10 * Math.sin(a), 0]);
      ct.push([-Math.sin(a), Math.cos(a), 0]);
    }
    const ring = edgeSegment("p/e2", c, ct, 20 * Math.PI);
    expect(ring?.kind === "arc" && ring.angle).toBeCloseTo(2 * Math.PI, 9);
    const h = helixSamples(50, 30, 2, 200);
    const coil = edgeSegment("h/0.0", h.pts, h.tans, h.length, { frenet: true }) as CurveSeg;
    expect(coil.kind).toBe("curve");
    expect(coil.normals).toHaveLength(201);
    // The helix's bending points at its axis.
    const n0 = coil.normals![0];
    expect(dot(n0, [-1, 0, 0])).toBeGreaterThan(0.999);
  });

  it("along a helix the profile keeps facing the axis (its across points in), the same at the other end", () => {
    const h = helixSamples(50, 30, 2, 400);
    const coil = edgeSegment("h/0.0", h.pts, h.tans, h.length, { frenet: true })!;
    const [m] = buildMembers([coil], true);
    const f = segFrames(m);
    const end = f[f.length - 1];
    // Start (50, 0, 0): in = −x; end after two turns: the same place round, higher.
    expect(dot(f[0].x, [-1, 0, 0])).toBeGreaterThan(0.999);
    expect(dot(end.x, [-1, 0, 0])).toBeGreaterThan(0.999);
    expect(Math.abs(dot(end.y, h.tans[400]))).toBeLessThan(1e-9);
  });

  it("the planned across directions along a 3D curve end where the member's end axes are", () => {
    const pts: V3[] = [];
    const tans: V3[] = [];
    let length = 0;
    for (let i = 0; i <= 300; i++) {
      const u = i / 300;
      pts.push([100 * u, 40 * Math.sin(3 * u), 30 * u * u]);
      const d: V3 = [100, 120 * Math.cos(3 * u), 60 * u];
      const l = Math.hypot(...d);
      tans.push([d[0] / l, d[1] / l, d[2] / l]);
      if (i) length += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1], pts[i][2] - pts[i - 1][2]);
    }
    const seg = withPathNormal([edgeSegment("c/0.0", pts, tans, length)!])[0] as CurveSeg;
    expect(seg.kind).toBe("curve");
    const [m] = buildMembers([seg], true);
    const xs = curveAcross(m.segs[0] as CurveSeg, m.start);
    const f = segFrames(m);
    expect(dot(xs[xs.length - 1], f[1].x)).toBeGreaterThan(1 - 1e-12);
    expect(xs.every((x, i) => Math.abs(dot(x, (m.segs[0] as CurveSeg).tans[i])) < 1e-12)).toBe(true);
  });

  it("without following its bending, a flat curve carries the profile exactly as an arc would, and back again", () => {
    const q: V3[] = [];
    const t: V3[] = [];
    // Half a circle sampled, but kept as a curve (a slightly squashed one so it isn't an arc).
    for (let i = 0; i <= 200; i++) {
      const a = (Math.PI * i) / 200;
      q.push([20 * Math.cos(a), 19.9 * Math.sin(a), 0]);
      const d: V3 = [-20 * Math.sin(a), 19.9 * Math.cos(a), 0];
      const l = Math.hypot(...d);
      t.push([d[0] / l, d[1] / l, 0]);
    }
    const s = withPathNormal([edgeSegment("c/0.0", q, t, 62.7)!])[0];
    expect(s.kind).toBe("curve");
    const [m] = buildMembers([s], true);
    const f = segFrames(m);
    // Up stays up (the plane's normal), across turns with the curve.
    expect(dot(f[0].y, [0, 0, 1])).toBeGreaterThan(0.9999);
    expect(dot(f[1].y, [0, 0, 1])).toBeGreaterThan(0.9999);
    expect(Math.abs(dot(f[1].x, t[200]))).toBeLessThan(1e-6);
    // Walked the other way, it comes back to the same axes.
    const back = buildMembers([s], true)[0];
    expect(back.start.x.every((v, i) => Math.abs(v - f[0].x[i]) < 1e-9)).toBe(true);
  });

  it("part edges in one plane stand the profile up from that plane (a box's top: up is +Z)", () => {
    const top = withPathNormal([line("b/e0", [0, 0, 50], [200, 0, 50]), line("b/e1", [200, 0, 50], [200, 100, 50]), line("b/e2", [200, 100, 50], [0, 100, 50]), line("b/e3", [0, 100, 50], [0, 0, 50])]);
    expect(top.every((s) => Math.abs(s.n[2] - 1) < 1e-12)).toBe(true);
    // A side face's rectangle (x and z): up is +Y.
    const side = withPathNormal([line("b/e0", [0, 0, 0], [200, 0, 0]), line("b/e1", [200, 0, 0], [200, 0, 50])]);
    expect(side[0].n[1]).toBeCloseTo(1, 12);
    const plan = planFrame(top, {}, square(44), 0);
    if (typeof plan === "string") throw new Error(plan);
    expect(plan.members).toHaveLength(4);
    expect(plan.corners.every((c) => c.type === "mitre")).toBe(true);
    expect(plan.members[0].frames[0].y[2]).toBeCloseTo(1, 12);
  });
});

describe("mitres where three or more meet", () => {
  const corner = [line("a/x", [0, 0, 0], [200, 0, 0]), line("a/y", [0, 0, 0], [0, 200, 0]), line("b/z", [0, 0, 0], [0, 0, 200])];

  it("a cube's corner offers a mitre (butt stays the usual)", () => {
    const { corners } = findCorners(buildMembers(corner, true));
    const c = corners.find((k) => k.ends.length === 3)!;
    expect(c.choices).toContain("mitre");
    expect(frameLayout(corner, {}).corners[0].type).toBe("butt");
  });

  it("isn't offered where two carry straight on, or meet too sharply", () => {
    const t = [line("a/x", [0, 0, 0], [200, 0, 0]), line("a/w", [0, 0, 0], [-200, 0, 0]), line("a/y", [0, 0, 0], [0, 200, 0])];
    expect(findCorners(buildMembers(t, false)).corners[0].choices).not.toContain("mitre");
    const sharp = [line("a/x", [0, 0, 0], [200, 0, 0]), line("a/s", [0, 0, 0], [200, 10, 0]), line("a/y", [0, 0, 0], [0, 200, 0])];
    expect(findCorners(buildMembers(sharp, true)).corners[0].choices).not.toContain("mitre");
  });

  it("each end is cut by the halfway planes to the other two: 45° each, no point kept twice", () => {
    const key = findCorners(buildMembers(corner, true)).corners[0].key;
    const s = square(44);
    const p = planFrame(corner, { corners: [{ key, type: "mitre" }] }, s, 0);
    if (typeof p === "string") throw new Error(p);
    expect(p.corners[0].type).toBe("mitre");
    for (const m of p.members) {
      const end = m.ends[0];
      expect(end.cuts).toHaveLength(2);
      expect(end.label).toBe(45);
      expect(end.extend).toBeGreaterThan(22);
    }
    // Points near the corner: inside a member's bar (lengthened) and on the kept side of all its cuts.
    const keeps = (i: number, q: V3) => {
      const m = p.members[i];
      const s0 = m.member.segs[0];
      const d: V3 = [s0.b[0] - s0.a[0], s0.b[1] - s0.a[1], s0.b[2] - s0.a[2]].map((v) => v / 200) as V3;
      const along = dot(q, d);
      const off = q.map((v, k) => v - d[k] * along);
      if (Math.max(...off.map(Math.abs)) > 22 || along < -m.ends[0].extend || along > 200) return false;
      return m.ends[0].cuts.every((c) => dot(c.n, [q[0] - c.o[0], q[1] - c.o[1], q[2] - c.o[2]]) >= 0);
    };
    let both = 0;
    let covered = 0;
    let inBars = 0;
    for (let x = -21; x <= 60; x += 3)
      for (let y = -21; y <= 60; y += 3)
        for (let z = -21; z <= 60; z += 3) {
          const q: V3 = [x + 0.17, y + 0.31, z + 0.43];
          const n = [0, 1, 2].filter((i) => keeps(i, q)).length;
          const inAny = [0, 1, 2].some((i) => Math.max(...q.map(Math.abs).filter((_, k) => k !== i)) < 22 && q[i] > -22);
          if (n > 1) both++;
          if (inAny) inBars++;
          if (inAny && n === 1) covered++;
        }
    expect(both).toBe(0);
    // And every point of the three bars round the corner belongs to one of them (no gap).
    expect(covered).toBe(inBars);
    // The cut list calls them compound mitres.
    const info = memberInfo(p, 0, s, "fr");
    expect(info.compound).toEqual([true, false]);
    expect(cutList([{ id: "a", name: "a", frame: info }]).rows[0].ends).toBe("compound mitre 45° / square");
  });
});

describe("reading, toggling and Delete with dependents", () => {
  const pick: TopoPick = parsePick({ partId: "box1", ref: { kind: "edge", a: [0, 0, 5], b: [20, 0, 5], mid: [10, 0, 5], length: 20, curve: "LINE" } })!;

  it("old frames read exactly as before; edges and curves are kept", () => {
    const old = { paths: [{ sketch: "s1" }], profile: { kind: "extrusion", size: "2020" } };
    expect(parseFrameDef(old, parsePick)).toEqual(old);
    expect(JSON.stringify(parseFrameDef(old, parsePick))).toBe(JSON.stringify(old));
    const more = parseFrameDef({ ...old, edges: [{ ...pick, key: "e7q" }, { partId: "x", ref: "nonsense" }, pick], curves: ["h1", "h1", 3] }, parsePick)!;
    expect(more.edges!.map((e) => e.key)).toEqual(["e7q", edgeKeyFor(pick)]);
    expect(more.curves).toEqual(["h1"]);
    // Read back exactly as saved.
    expect(parseFrameDef(JSON.parse(JSON.stringify(more)), parsePick)).toEqual(more);
  });

  it("clicking an edge or a curve adds it, clicking it again leaves it out", () => {
    const def: FrameDef = { paths: [], profile: { kind: "extrusion", size: "2020" } };
    const same = (a: TopoPick, b: TopoPick) => a.partId === b.partId && JSON.stringify(a.ref) === JSON.stringify(b.ref);
    const one = togglePathEdge(def, pick, same);
    expect(one.edges).toHaveLength(1);
    expect(togglePathEdge(one, pick, same)).toEqual(def);
    // Names last: taking out the middle edge leaves the others' names alone; picked again it gets its name back.
    const ref = (x: number) => parsePick({ partId: "box1", ref: { kind: "edge", a: [x, 0, 5], b: [x + 10, 0, 5], mid: [x + 5, 0, 5], curve: "LINE" } })!;
    let three = def;
    for (const x of [0, 10, 20]) three = togglePathEdge(three, ref(x), same);
    const names = three.edges!.map((e) => e.key);
    expect(new Set(names).size).toBe(3);
    const two = togglePathEdge(three, ref(10), same);
    expect(two.edges!.map((e) => e.key)).toEqual([names[0], names[2]]);
    expect(togglePathEdge(two, ref(10), same).edges!.map((e) => e.key)).toEqual([names[0], names[2], names[1]]);
    expect(edgeKeyFor(ref(0), [edgeKeyFor(ref(0))])).not.toBe(edgeKeyFor(ref(0)));
    const c = togglePathCurve(def, "h1");
    expect(c.curves).toEqual(["h1"]);
    expect(togglePathCurve(c, "h1")).toEqual(def);
  });

  it("says at once when what was clicked comes after the frame", () => {
    const list = [{ id: "a" }, { id: "fr" }, { id: "h" }];
    expect(laterPathMessage(list, "fr", "h")).toMatch(/comes after this frame/);
    expect(laterPathMessage(list, "fr", "a")).toBeNull();
    // A new frame (not in the list yet) comes after everything.
    expect(laterPathMessage(list, "new", "h")).toBeNull();
  });

  it("knows a frame needs its curves and edges' parts: losing one of several keeps it, losing them all takes it", () => {
    const sk = { id: "s1", type: "sketch", name: "Sketch 1" } as Feature;
    const h = { id: "h1", type: "curve", name: "Helix 1" } as Feature;
    const box = { id: "box1", type: "box", name: "Box 1" } as Feature;
    const fr = { id: "fr", type: "frame", name: "Frame 1", frame: { paths: [{ sketch: "s1" }], curves: ["h1"], edges: [{ ...pick, key: "e1" }], profile: { kind: "extrusion", size: "2020" } } } as Feature;
    const all = [sk, h, box, fr];
    expect(JSON.stringify(findDependents(all, ["h1"]).partial)).toContain('"fr"');
    expect(findDependents(all, ["h1"]).dependents).toEqual([]);
    const tidied = withoutGone({ ...fr, frame: { ...fr.frame!, edges: [{ ...pick, key: "e1" }] } }, new Set(["h1", "box1"]));
    expect(tidied.frame).toEqual({ paths: [{ sketch: "s1" }], profile: { kind: "extrusion", size: "2020" } });
    const onlyCurve = { ...fr, frame: { paths: [], curves: ["h1"], profile: { kind: "extrusion", size: "2020" } } } as Feature;
    expect(findDependents([h, onlyCurve], ["h1"]).dependents).toEqual(["fr"]);
  });
});

describe("cut list table on a drawing", () => {
  const member = (id: string, length: number, studioId = "main"): PartMesh =>
    ({ id, name: id, studioId, featureIds: [], vertices: new Float32Array(), normals: new Float32Array(), triangles: new Uint32Array(), edges: new Float32Array(), frame: { frame: "fr", member: 1, profile: "2020 aluminium extrusion", length, ends: [45, 45] } }) as unknown as PartMesh;
  const parts = [member("a", 420), member("b", 420), member("c", 320), member("x", 100, "other")];

  it("rows: heading, a line per length, a total per profile", () => {
    const rows = cutListRows(parts.slice(0, 3).map((p) => ({ id: p.id, name: p.name, frame: p.frame })));
    expect(rows[0]).toEqual(["Item", "Qty", "Profile", "Length (mm)", "End cuts"]);
    expect(rows[1]).toEqual(["1", "2", "2020 aluminium extrusion", "420.0", "45° / 45°"]);
    expect(rows[2]).toEqual(["2", "1", "2020 aluminium extrusion", "320.0", "45° / 45°"]);
    expect(rows[3]).toEqual(["", "3", "2020 aluminium extrusion in all", "1160.0", ""]);
    expect(cutListRows([])[1][2]).toBe(NO_MEMBERS);
    // An inch design's table is in inches.
    const inch = cutListRows(parts.slice(0, 1).map((p) => ({ id: p.id, name: p.name, frame: p.frame })), "in");
    expect(inch[0][3]).toBe("Length (in)");
    expect(inch[1][3]).toBe("16.54");
  });

  it("a sheet lists its part's Part Studio, the studio it names, or every copy in its assembly", () => {
    const note = { id: "n", at: [10, 10] as [number, number], text: "", cutList: {} };
    expect(sheetCutList({ source: { kind: "part", id: "a" }, notes: [] }, parts)).toBeUndefined();
    expect(sheetCutList({ source: { kind: "part", id: "a" }, notes: [note] }, parts)!.length).toBe(4);
    expect(sheetCutList({ source: { kind: "part", id: "a" }, notes: [{ ...note, cutList: { studio: "other" } }] }, parts)![1][3]).toBe("100.0");
    const asm = sheetCutList({ source: { kind: "assembly", id: "A" }, notes: [note] }, parts, ["c", "c", "c", "zz"])!;
    expect(asm[1].slice(0, 4)).toEqual(["1", "3", "2020 aluminium extrusion", "320.0"]);
  });
});

describe("cut list table drawn on the sheet", () => {
  it("draws the rows it's given, saves and reads back, and comes out in the SVG, DXF and PDF", async () => {
    const { addDrawing, parseDrawings, putNote } = await import("../src/drawing/drawing");
    const { layoutSheet } = await import("../src/drawing/sheet");
    const { sheetDxf, sheetPdf, sheetSvg } = await import("../src/drawing/export");
    const { emptyDocument } = await import("../src/model/document");
    const { cutListNote } = await import("../src/drawing/cutListTable");
    const view = { kind: "front" as const, visible: [[0, 0, 40, 0, 40, 20, 0, 20, 0, 0]], hidden: [], circles: [], points: [], bounds: [0, 0, 40, 20] as [number, number, number, number] };
    const d = putNote(addDrawing(emptyDocument(), "d1", { kind: "part", id: "f1" }).drawings![0], cutListNote("c1", [20, 190]));
    const rows = cutListRows([{ id: "a", name: "a", frame: { frame: "fr", member: 1, profile: "2020 aluminium extrusion", length: 420.04, ends: [45, 45] } }]);
    const info = { designName: "Frame", subject: "Frame", date: "14/11/2026", cutList: rows };
    const l = layoutSheet(d, { front: view }, info);
    const texts = l.prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    for (const w of ["Item", "Qty", "2020 aluminium extrusion", "420.0", "45° / 45°"]) expect(texts).toContain(w);
    expect(l.notes.some((n) => n.id === "c1")).toBe(true);
    // A decimal comma on the lengths when asked.
    const comma = layoutSheet({ ...d, decimalComma: true }, { front: view }, info).prims.flatMap((p) => (p.kind === "text" ? [p.text] : []));
    expect(comma).toContain("420,0");
    const [read] = parseDrawings(JSON.parse(JSON.stringify([d])));
    expect(read.notes).toEqual(d.notes);
    expect(sheetSvg(l.prims, l.size, "Frame")).toContain("2020 aluminium extrusion");
    expect(sheetDxf(l.prims)).toContain("420.0");
    expect(new TextDecoder("latin1").decode(sheetPdf(l.prims, l.size, "Frame"))).toContain("2020 aluminium extrusion");
  });
});
