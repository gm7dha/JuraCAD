/** Frames (pure): profiles, members, corners (mitre, butt, coped, T), cut lengths, gussets and the cut list. */
import { describe, expect, it } from "vitest";
import { builtInProfile, placedProfile, profileArea, profileBox, PROFILE_KINDS, type ProfileShape } from "../src/model/frameProfiles";
import { buildMembers, cutList, cutListCsv, gussetOutline, gussetVolume, memberInfo, planFrame, sketchPathSegments, straightMember, trimmedInfo, type FramePlan, type PathSeg } from "../src/model/frame";
import { emptySketch, type SketchData } from "../src/sketch/types";
import type { Feature } from "../src/model/types";
import { emptyDocument, parseDocument } from "../src/model/document";
import { findDependents } from "../src/model/dependents";
import { polySketch } from "./support/frameSketch";

const rect = (w: number, h: number) => polySketch([[0, 0], [w, 0], [w, h], [0, h]]);
const shape = (kind: Parameters<typeof builtInProfile>[0], size: string) => {
  const s = builtInProfile(kind, size);
  if (typeof s === "string") throw new Error(s);
  return placedProfile(s, undefined, false, 0);
};
const plan = (segs: PathSeg[], s: ProfileShape, corners?: { key: string; type: "mitre" | "butt" | "coped" | "none"; through?: string }[], gap = 0): FramePlan => {
  const p = planFrame(segs, { corners }, s, gap);
  if (typeof p === "string") throw new Error(p);
  return p;
};

describe("frame profiles", () => {
  it("every built-in size makes a sound outline centred on its box", () => {
    for (const k of PROFILE_KINDS) {
      for (const sz of k.sizes) {
        const s = builtInProfile(k.kind, sz.key);
        expect(typeof s).toBe("object");
        const box = profileBox(s as ProfileShape);
        expect(Math.abs(box[0] + box[2])).toBeLessThan(1e-9);
        expect(Math.abs(box[1] + box[3])).toBeLessThan(1e-9);
        expect(profileArea(s as ProfileShape)).toBeGreaterThan(0);
      }
    }
  });
  it("2020 is 20 × 20 with slots and a bore, about 0.5 kg/m", () => {
    const s = builtInProfile("extrusion", "2020") as ProfileShape;
    expect(profileBox(s)).toEqual([-10, -10, 10, 10]);
    const a = profileArea(s);
    expect(a).toBeGreaterThan(170);
    expect(a).toBeLessThan(240);
    const r = s.regions[0].outer;
    expect(r.kind === "poly" && r.pts.length).toBe(4 + 4 * 8);
    expect(s.regions[0].holes).toHaveLength(1);
  });
  it("box section area and custom sizes", () => {
    const s = builtInProfile("box", "40x40x2") as ProfileShape;
    expect(profileArea(s)).toBeCloseTo(40 * 40 - 36 * 36, 6);
    expect(builtInProfile("box", "custom", { width: 30, height: 20, wall: 12 })).toMatch(/wall/);
    const t = builtInProfile("tube", "custom", { width: 30, height: 0, wall: 2 }) as ProfileShape;
    expect(profileArea(t)).toBeCloseTo(Math.PI * (15 * 15 - 13 * 13), 6);
  });
  it("anchors and mirror move the profile", () => {
    const s = builtInProfile("angle", "40x40x4") as ProfileShape;
    const tl = placedProfile(s, "bottomLeft", false, 0);
    profileBox(tl).forEach((v, i) => expect(v).toBeCloseTo([0, 0, 40, 40][i], 9));
    const m = placedProfile(s, "bottomLeft", true, 0);
    expect(profileBox(m)[0]).toBeCloseTo(-40, 9);
  });
});

describe("frame members and corners", () => {
  const segs = sketchPathSegments("s", { kind: "default", name: "Top" }, rect(400, 300)).segs;
  it("a rectangle: 4 members, 4 mitred corners, cut lengths to the outside", () => {
    const p = plan(segs, shape("extrusion", "2020"));
    expect(p.members).toHaveLength(4);
    expect(p.corners.map((c) => c.type)).toEqual(["mitre", "mitre", "mitre", "mitre"]);
    const lens = p.members.map((_, i) => memberInfo(p, i, shape("extrusion", "2020"), "f").length).sort((a, b) => a - b);
    expect(lens[0]).toBeCloseTo(320, 6);
    expect(lens[3]).toBeCloseTo(420, 6);
    const info = memberInfo(p, 0, shape("extrusion", "2020"), "f");
    expect(info.ends).toEqual([45, 45]);
  });
  it("butt corners: one runs through, one stops at its side; a gap shortens it", () => {
    const s = shape("box", "40x40x2");
    const keys = plan(segs, s).corners.map((c) => c.key);
    const p = plan(segs, s, keys.map((key) => ({ key, type: "butt" as const })));
    const lens = p.members.map((_, i) => memberInfo(p, i, s, "f").length);
    // The longer members run through at every corner: two pairs.
    expect(lens.map((l) => Math.round(l * 100) / 100)).toEqual([440, 260, 440, 260]);
    const g = plan(segs, s, keys.map((key) => ({ key, type: "butt" as const })), 2);
    expect(Math.min(...g.members.map((_, i) => memberInfo(g, i, s, "f").length))).toBeCloseTo(256, 6);
    // Swapping which runs through at one corner.
    const flipped = plan(segs, s, [{ key: keys[0], type: "butt", through: "s/l3" }]);
    expect(flipped.corners[0].through).toBe(3);
  });
  it("coped round tubes are measured to the longest point", () => {
    const s = shape("tube", "25x2");
    const keys = plan(segs, s).corners.map((c) => c.key);
    const p = plan(segs, s, keys.map((key) => ({ key, type: "coped" as const })));
    const short = Math.min(...p.members.map((_, i) => memberInfo(p, i, s, "f").length));
    // Square tube joints: a cope of equal tubes reaches the other's centre line at its sides.
    expect(short).toBeCloseTo(300, 1);
    expect(memberInfo(p, 3, s, "f").ends).toEqual(["coped", "coped"]);
    expect(memberInfo(p, 3, s, "f").length).toBeCloseTo(300, 1);
  });
  it("a T: a member ending on another's side is butted against it", () => {
    const shelf = sketchPathSegments("t", { kind: "default", name: "Top" }, polySketch([[0, 0], [400, 0], [400, 300], [0, 300]].concat() as [number, number][])).segs;
    const mid = sketchPathSegments("m", { kind: "default", name: "Top" }, polySketch([[200, 0], [200, 300]], false)).segs;
    const s = shape("box", "20x20x2");
    const p = plan([...shelf, ...mid], s);
    const tees = p.corners.filter((c) => c.on !== undefined);
    expect(tees).toHaveLength(2);
    expect(memberInfo(p, 4, s, "f").length).toBeCloseTo(280, 6);
  });
  it("merges lines and arcs that carry on smoothly, unless asked not to", () => {
    const data: SketchData = {
      points: [
        { id: "a", x: 0, y: 0 },
        { id: "b", x: 100, y: 0 },
        { id: "c", x: 100, y: 50 },
        { id: "d", x: 150, y: 50 },
        { id: "e", x: 150, y: 150 },
      ],
      curves: [
        { id: "l1", type: "line", p1: "a", p2: "b", construction: false },
        { id: "a1", type: "arc", center: "c", start: "b", end: "d", construction: false },
        { id: "l2", type: "line", p1: "d", p2: "e", construction: false },
      ],
      constraints: [],
    };
    const segs2 = sketchPathSegments("s", { kind: "default", name: "Top" }, data).segs;
    expect(buildMembers(segs2, true)).toHaveLength(1);
    expect(buildMembers(segs2, false)).toHaveLength(3);
    const s = shape("tube", "20x2");
    const p = plan(segs2, s);
    expect(p.corners).toHaveLength(0);
    const info = memberInfo(p, 0, s, "f");
    expect(info.curved).toBe(true);
    expect(info.length).toBeCloseTo(100 + (Math.PI / 2) * 50 + 100, 2);
  });
  it("refuses a very sharp corner", () => {
    const sharp = sketchPathSegments("s", { kind: "default", name: "Top" }, polySketch([[0, 0], [100, 0], [0, 5]], false)).segs;
    expect(planFrame(sharp, {}, shape("flat", "20x3"), 0)).toMatch(/very sharp/);
  });
});

describe("trims, gussets and the cut list", () => {
  const segs = sketchPathSegments("s", { kind: "default", name: "Top" }, rect(400, 300)).segs;
  it("trimming to a slanted plane changes the length and the end's angle", () => {
    const s = shape("box", "40x40x2");
    const p = plan(segs, s);
    const m = straightMember(p, 0, s)!;
    const info = memberInfo(p, 0, s, "f");
    // Member 0 runs from (0,0) along +x; trim its far end with a 30° plane through x = 300.
    const n: [number, number, number] = [-Math.cos(Math.PI / 6), Math.sin(Math.PI / 6), 0];
    const t = trimmedInfo(info, m, s, { n, o: [300, 0, 0] });
    expect(t.info.ends[1]).toBeCloseTo(30, 6);
    expect(t.info.length).toBeLessThan(info.length);
  });
  it("a gusset sits in the inside corner", () => {
    const s = shape("box", "40x40x2");
    const p = plan(segs, s, plan(segs, s).corners.map((c) => ({ key: c.key, type: "butt" as const })));
    const a = straightMember(p, 0, s)!;
    const b = straightMember(p, 3, s)!;
    const g = gussetOutline(a, b, s, s, 80, 10);
    if (typeof g === "string") throw new Error(g);
    expect(g.pts).toHaveLength(4);
    // Inner corner at (20, 20): legs along +x and +y.
    expect(g.pts[0][0]).toBeCloseTo(30, 6);
    expect(g.pts[0][1]).toBeCloseTo(20, 6);
    expect(gussetVolume(80, 10, g.angle, 5)).toBeCloseTo(0.5 * (6400 - 100) * 5, 6);
  });
  it("groups identical members and totals each profile", () => {
    const s = shape("extrusion", "2020");
    const p = plan(segs, s);
    const parts = p.members.map((_, i) => ({ id: `f~${i + 1}`, name: `Frame 1 member ${i + 1}`, frame: memberInfo(p, i, s, "f"), volume: 1000 }));
    const list = cutList(parts, (x) => (x.volume! / 1000) * 2.7);
    expect(list.rows).toHaveLength(2);
    expect(list.rows[0].quantity).toBe(2);
    expect(list.rows[0].length).toBe(420);
    expect(list.rows[0].ends).toBe("45° / 45°");
    expect(list.totals).toEqual([{ profile: "2020 aluminium extrusion", quantity: 4, length: 1480, mass: 10.8 }]);
    const csv = cutListCsv(list);
    expect(csv.split("\n")[1]).toBe("1,2,2020 aluminium extrusion,420.0,45° / 45°,2.7,Frame 1 member 1; Frame 1 member 3");
  });
});

describe("frames in files and Delete with dependents", () => {
  const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
  const sk = (id: string) => feat(id, "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } });
  const reread = (features: Feature[]) => parseDocument(JSON.parse(JSON.stringify({ ...emptyDocument("x"), features })))!.features;
  const fr = feat("f", "frame", { frame: { paths: [{ sketch: "s1" }, { sketch: "s2", items: ["l1"] }], profile: { kind: "box", size: "40x40x2" }, anchor: "topLeft", mirror: true, noMerge: true, corners: [{ key: "a+b", type: "coped", through: "s1/l0" }] } });
  const tr = feat("t", "trimFrame", { trimFrame: { parts: ["f~2"], plane: { kind: "default", name: "Right" }, flip: true } });
  const gu = feat("g", "gusset", { params: { size: "50" }, gusset: { parts: ["f", "f~2"], chamfer: true } });
  it("reads them back as saved, and old files are untouched", () => {
    const [, , a, b, c] = reread([sk("s1"), sk("s2"), fr, tr, gu]);
    expect(a.frame).toEqual(fr.frame);
    expect(b.trimFrame).toEqual(tr.trimFrame);
    expect(c.gusset).toEqual(gu.gusset);
    const plain = reread([sk("s1"), feat("b", "box")]);
    expect(plain[1].frame).toBeUndefined();
    expect(Object.keys(plain[1]).sort()).toEqual(["id", "name", "operation", "params", "suppressed", "type"]);
  });
  it("Delete with dependents follows sketches and members", () => {
    const list = [sk("s1"), sk("s2"), fr, tr, gu];
    expect(findDependents(list, ["s1"]).partial.map((p) => p.id)).toEqual(["f"]);
    expect(findDependents(list, ["s1", "s2"]).dependents).toEqual(["f", "t", "g"]);
    expect(findDependents(list, ["f"]).dependents).toEqual(["t", "g"]);
    expect(findDependents([sk("s1"), sk("s2"), feat("p", "frame", { frame: { paths: [{ sketch: "s1" }], profile: { kind: "sketch", sketch: "s2" } } })], ["s2"]).dependents).toEqual(["p"]);
  });
});

describe("clicking path lines", () => {
  it("leaves a line out of a whole sketch, puts it back, and adds another sketch's line", async () => {
    const { togglePathLine } = await import("../src/model/frame");
    const feats = [{ id: "s", type: "sketch", sketch: { data: polySketch([[0, 0], [1, 0], [1, 1]]) } }];
    const def = { paths: [{ sketch: "s" }], profile: { kind: "flat" as const, size: "20x3" } };
    const out = togglePathLine(def, feats, "s", "l1");
    expect(out.paths).toEqual([{ sketch: "s", items: ["l0", "l2"] }]);
    expect(togglePathLine(out, feats, "s", "l1").paths).toEqual([{ sketch: "s" }]);
    expect(togglePathLine(def, feats, "t", "x").paths).toEqual([{ sketch: "s" }, { sketch: "t", items: ["x"] }]);
  });
});
