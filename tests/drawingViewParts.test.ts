import { describe, expect, it } from "vitest";

import { autoDimensions, autoDimensionSheet } from "../src/drawing/autoDimension";
import { addDrawing, parseDrawings, toggleView } from "../src/drawing/drawing";
import { holeTableView } from "../src/drawing/holeTable";
import { changePage, pageOf } from "../src/drawing/pages";
import { addSection, sectionRequests, viewKey } from "../src/drawing/sections";
import { layoutSheet, type Projections, type SheetInfo } from "../src/drawing/sheet";
import { finishProjections, projectionPlan, sheetParts, withViewParts } from "../src/drawing/sheetSource";
import { addViewOf, keyGroup, partDrawings, rekeyed, removeViewOf, setViewSource, splitKey, toggleProjected, viewParts } from "../src/drawing/viewParts";
import type { PartMesh, ViewProjection } from "../src/kernel/protocol";
import { emptyDocument } from "../src/model/document";
import type { Assembly, Drawing, JuraCADDocument } from "../src/model/types";

/** A view of a w × h block (view mm, from its bottom-left corner), with a ⌀`hole` hole in the middle when given. */
const block = (kind: string, w: number, h: number, hole?: number): ViewProjection => ({
  kind,
  visible: [[0, 0, w, 0, w, h, 0, h, 0, 0]],
  hidden: [],
  circles: hole ? [{ cx: w / 2, cy: h / 2, r: hole / 2, hidden: false, full: true }] : [],
  points: [0, 0, w, 0, w, h, 0, h, ...(hole ? [w / 2, h / 2] : [])],
  bounds: [0, 0, w, h],
});

const part = (id: string, name: string): PartMesh =>
  ({ id, name, featureIds: [id], vertices: new Float32Array([0, 0, 0, 10, 10, 10]), normals: new Float32Array(), triangles: new Uint32Array(), faceGroups: [], lines: new Float32Array(), edgeGroups: [], faceRefs: [], edgeRefs: [], volume: 1000 }) as PartMesh;
const parts = [part("p1", "Base"), part("p2", "Bolt")];
const asm: Assembly = {
  id: "a1",
  name: "Assembly 1",
  instances: [
    { id: "i1", partId: "p1", name: "Base <1>", placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
    { id: "i2", partId: "p2", name: "Bolt <1>", placement: { position: [50, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true },
  ],
};
const doc: JuraCADDocument = { ...emptyDocument(), assemblies: [asm] };
const info: SheetInfo = { designName: "D", subject: "Base", date: "1/1/2026" };

/** A drawing of p1 (front and top at 1:1), with a front view of p2 ("vw1") and its top view. */
function twoParts(): Drawing {
  const d: Drawing = { ...addDrawing(doc, "d1", { kind: "part", id: "p1" }).drawings![0], scale: 1 };
  const plain = { ...d, views: d.views.filter((v) => v.kind === "front" || v.kind === "top") };
  const made = addViewOf(plain, "vw1", { kind: "part", id: "p2" });
  expect(made.key).toBe("front@vw1");
  return toggleProjected(made.drawing, "vw1", "top");
}

/** What the engine gives the sheet: p1's front 40 × 30 and top 40 × 20; p2's front 20 × 10 (⌀4 hole) and top 20 × 8. */
const both: Projections = { front: block("front", 40, 30), top: block("top", 40, 20), "front@vw1": block("front@vw1", 20, 10, 4), "top@vw1": block("top@vw1", 20, 8) };

describe("views of other parts: editing", () => {
  it("adds a view of another part, with views projected from it, keyed by that view", () => {
    const d = twoParts();
    expect(d.views.slice(2)).toEqual([
      { id: "vw1", kind: "front", source: { kind: "part", id: "p2" } },
      { id: "vw1-top", kind: "top", parent: "vw1" },
    ]);
    expect(d.views.map(viewKey)).toEqual(["d1-front", "d1-top", "vw1", "vw1-top"].map((_, i) => ["front", "top", "front@vw1", "top@vw1"][i]));
    expect(viewParts(d)).toEqual([{ id: "vw1", kind: "front", source: { kind: "part", id: "p2" } }]);
    expect(splitKey("top@vw1")).toEqual({ kind: "top", group: "vw1" });
    expect(splitKey("section:s@x")).toEqual({ kind: "section:s@x", group: null });
  });

  it("of the sheet's own part, just ticks that view of it", () => {
    const d = addDrawing(doc, "d1", { kind: "part", id: "p1" }).drawings![0];
    const noFront = { ...d, views: d.views.filter((v) => v.kind !== "front") };
    const made = addViewOf(noFront, "vw9", { kind: "part", id: "p1" });
    expect(made.key).toBe("front");
    expect(made.drawing.views.at(-1)).toEqual({ id: "d1-front", kind: "front" });
  });

  it("ticking the sheet's own views leaves the views of other parts alone (and the other way round)", () => {
    const d = twoParts();
    const noTop = toggleView(d, "top");
    expect(noTop.views.map(viewKey)).toEqual(["front", "front@vw1", "top@vw1"]);
    const back = toggleProjected(noTop, "vw1", "top");
    expect(back.views.map(viewKey)).toEqual(["front", "front@vw1"]);
    // The view placed can't be unticked as a projected one: it's removed instead.
    expect(toggleProjected(d, "vw1", "front")).toBe(d);
  });

  it("removes a view of another part with its projected views, sections, details and dimensions", () => {
    let d = twoParts();
    d = addSection(d, { id: "s1", host: "top@vw1", a: [0.5, -0.1], b: [0.5, 1.1] });
    d = { ...d, details: [{ id: "t1", letter: "B", host: "front@vw1", centre: [0.5, 0.5], radius: 3, zoom: 2 }], views: [...d.views, { id: "vt", kind: "detail", detail: "t1" }] };
    d = { ...d, breakouts: [{ id: "b1", host: "front@vw1", a: [0, 0], b: [0.5, 0.5], depth: 2 }], shortened: [{ id: "h1", host: "front", axis: "x", from: 0.4, to: 0.6 }] };
    const dim = (id: string, view: string) => ({ id, view, type: "horizontal" as const, a: { at: [0, 0] as [number, number], rel: [0, 0] as [number, number] }, b: { at: [20, 0] as [number, number], rel: [1, 0] as [number, number] }, offset: 8 });
    d = { ...d, dimensions: [dim("m1", "front"), dim("m2", "front@vw1"), dim("m3", "section:s1"), dim("m4", "detail:t1")] };
    expect(keyGroup(d, "section:s1")).toBe("vw1");
    expect(keyGroup(d, "detail:t1")).toBe("vw1");
    const gone = removeViewOf(d, "vw1");
    expect(gone.views.map(viewKey)).toEqual(["front", "top"]);
    expect(gone.sections).toBeUndefined();
    expect(gone.details).toBeUndefined();
    expect(gone.breakouts).toBeUndefined();
    expect(gone.shortened).toEqual([{ id: "h1", host: "front", axis: "x", from: 0.4, to: 0.6 }]);
    expect(gone.dimensions!.map((x) => x.id)).toEqual(["m1"]);
  });

  it("can show something else, keeping its views", () => {
    const d = setViewSource(twoParts(), "vw1", { kind: "assembly", id: "a1" });
    expect(d.views[2]).toEqual({ id: "vw1", kind: "front", source: { kind: "assembly", id: "a1" } });
    expect(d.views[3]).toEqual({ id: "vw1-top", kind: "top", parent: "vw1" });
  });
});

describe("views of other parts: saving", () => {
  it("keeps them, and what's drawn on them, when saved and opened", () => {
    let d = addSection(twoParts(), { id: "s1", host: "top@vw1", a: [0.5, -0.1], b: [0.5, 1.1] });
    d = { ...d, dimensions: [{ id: "m2", view: "front@vw1", type: "diameter", a: { at: [10, 5], rel: [0.5, 0.5] }, r: 2, offset: 8, angle: 45 }] };
    const back = parseDrawings(JSON.parse(JSON.stringify([d])))[0];
    expect(back.views).toEqual(d.views);
    expect(back.sections).toEqual([{ id: "s1", letter: "A", host: "top@vw1", a: [0.5, -0.1], b: [0.5, 1.1] }]);
    expect(back.dimensions!.map((x) => x.view)).toEqual(["front@vw1"]);
  });

  it("drops projected views, sections and dimensions whose view of another part has gone", () => {
    const d = addSection(twoParts(), { id: "s1", host: "top@vw1", a: [0.5, -0.1], b: [0.5, 1.1] });
    const raw = JSON.parse(JSON.stringify([{ ...d, views: d.views.filter((v) => v.id !== "vw1"), dimensions: [{ id: "m", view: "top@vw1", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [1, 0], rel: [1, 0] }, offset: 8 }] }]));
    const back = parseDrawings(raw)[0];
    expect(back.views.map(viewKey)).toEqual(["front", "top"]);
    expect(back.sections).toBeUndefined();
    expect(back.dimensions).toBeUndefined();
  });

  it("drops a projected view whose view of another part is missing, even when the sheet hasn't that view of its own", () => {
    const d = addDrawing(doc, "d1", { kind: "part", id: "p1" }).drawings![0];
    const own = { ...d, views: d.views.filter((v) => v.kind === "front") };
    const raw = JSON.parse(
      JSON.stringify([{ ...own, views: [...own.views, { id: "vw1-iso", kind: "iso", parent: "vw1" }, { id: "x-right", kind: "right", parent: "nope" }, { id: "y-top", kind: "top", parent: 7 }, { id: "z", kind: "left", parent: "z" }] }]),
    );
    const back = parseDrawings(raw)[0];
    expect(back.views).toEqual([{ id: "d1-front", kind: "front" }]);
  });

  it("keeps them per sheet", () => {
    const d = addDrawing(doc, "d1", { kind: "part", id: "p1" }).drawings![0];
    const two = { ...d, pages: [{ id: "p2", sheet: "A4" as const, views: [] }] };
    const after = changePage(two, "p2", (p) => addViewOf(p, "vw1", { kind: "assembly", id: "a1" }).drawing);
    expect(after.views).toEqual(d.views);
    expect(after.pages![0].views).toEqual([{ id: "vw1", kind: "front", source: { kind: "assembly", id: "a1" } }]);
    const read = parseDrawings(JSON.parse(JSON.stringify([after])))[0];
    expect(pageOf(read, "p2").views).toEqual([{ id: "vw1", kind: "front", source: { kind: "assembly", id: "a1" } }]);
  });
});

describe("views of other parts: what the engine is asked for", () => {
  it("asks once per part, each with its own views named as usual", () => {
    const d = addSection(twoParts(), { id: "s1", host: "top@vw1", a: [0.5, -0.1], b: [0.5, 1.1], flip: true });
    const [own, other] = partDrawings(d);
    expect(own.group).toBe(null);
    expect(own.drawing.source).toEqual({ kind: "part", id: "p1" });
    expect(projectionPlan(own.drawing).kinds).toEqual(["front", "top"]);
    expect(sectionRequests(own.drawing)).toEqual([]);
    expect(other.group).toBe("vw1");
    expect(other.drawing.source).toEqual({ kind: "part", id: "p2" });
    expect(projectionPlan(other.drawing).kinds).toEqual(["front", "top"]);
    expect(sectionRequests(other.drawing)).toEqual([{ key: "section:s1", host: "top", a: [0.5, -0.1], b: [0.5, 1.1], flip: true, aux: false }]);
    // Their answers come back under the sheet's keys.
    expect(rekeyed([block("front", 1, 1), block("section:s1", 1, 1)], "vw1").map((p) => p.kind)).toEqual(["front@vw1", "section:s1"]);
    // A sheet whose part is p1 draws p2 in that view.
    const drawn = sheetParts(d, doc, parts);
    expect(drawn.map((p) => [p.group, p.subject?.name, p.subject?.partIds])).toEqual([
      [null, "Base", ["p1"]],
      ["vw1", "Bolt", ["p2"]],
    ]);
  });

  it("works details out from the view of the part they're drawn on", () => {
    const d: Drawing = { ...twoParts(), details: [{ id: "t1", letter: "B", host: "front@vw1", centre: [0.5, 0.5], radius: 3, zoom: 2 }] };
    d.views = [...d.views, { id: "vt", kind: "detail", detail: "t1" }];
    const p = finishProjections(Object.values(both) as ViewProjection[], d);
    // The ⌀4 hole at (10, 5) on p2's front, inside the circle of radius 3.
    expect(p["detail:t1"]!.circles).toEqual([{ cx: 10, cy: 5, r: 2, hidden: false, full: true }]);
    expect(p["detail:t1"]!.zoom).toBe(2);
  });
});

describe("views of other parts: on the sheet", () => {
  it("lines each part's views up with its own front view, beside the sheet's part", () => {
    const l = layoutSheet(twoParts(), both, info);
    const at = (k: string) => l.views.find((v) => v.key === k)!;
    expect(l.scale).toBe(1);
    // p2's views: 15 mm to the right of p1's (its front's middle 40/2 + 15 + 20/2 = 45 mm along)…
    expect(at("front@vw1").centre[0] - at("front").centre[0]).toBeCloseTo(45, 9);
    expect(at("top@vw1").centre[0]).toBeCloseTo(at("front@vw1").centre[0], 9);
    // …tops of the arrangements level (fronts 30 and 10 tall), each top view 15 mm under its own front (first-angle).
    expect(at("front").box[3]).toBeCloseTo(at("front@vw1").box[3], 9);
    expect(at("front").box[1] - at("top").box[3]).toBeCloseTo(15, 9);
    expect(at("front@vw1").box[1] - at("top@vw1").box[3]).toBeCloseTo(15, 9);
    expect(at("top@vw1").box[2] - at("top@vw1").box[0]).toBeCloseTo(20, 9);
    expect(at("top@vw1").box[3] - at("top@vw1").box[1]).toBeCloseTo(8, 9);
  });

  it("moves a part's projected views with its front view, and leaves the others where they were", () => {
    const d = twoParts();
    const before = layoutSheet(d, both, info);
    const moved = { ...d, views: d.views.map((v) => (v.id === "vw1" ? { ...v, at: [250, 150] as [number, number] } : v)) };
    const after = layoutSheet(moved, both, info);
    const at = (l: typeof after, k: string) => l.views.find((v) => v.key === k)!.centre;
    expect(at(after, "front@vw1")).toEqual([250, 150]);
    expect(at(after, "top@vw1")[0]).toBe(250);
    expect(at(after, "top@vw1")[1] - at(after, "front@vw1")[1]).toBeCloseTo(at(before, "top@vw1")[1] - at(before, "front@vw1")[1], 9);
    expect(at(after, "front")).toEqual(at(before, "front"));
    expect(at(after, "top")).toEqual(at(before, "top"));
  });

  it("draws dimensions and the cutting line on the view of the part they belong to", () => {
    let d = twoParts();
    d = addSection(d, { id: "s1", host: "front@vw1", a: [0.5, -0.1], b: [0.5, 1.1] });
    d = { ...d, dimensions: [{ id: "m2", view: "front@vw1", type: "horizontal", a: { at: [0, 0], rel: [0, 0] }, b: { at: [20, 0], rel: [1, 0] }, offset: -8 }] };
    const l = layoutSheet(d, { ...both, "section:s1": block("section:s1", 8, 10) }, info);
    const host = l.views.find((v) => v.key === "front@vw1")!;
    const dim = l.dims[0];
    expect(dim.a).toEqual([host.box[0], host.box[1]]);
    expect(dim.b).toEqual([host.box[2], host.box[1]]);
    const texts = l.prims.filter((p) => p.kind === "text").map((p) => (p.kind === "text" ? p.text : ""));
    expect(texts).toContain("20");
    expect(texts).toContain("SECTION A-A");
    // The cutting line runs down through the middle of p2's front (x = 10 on it): 10% past its top and bottom.
    const cut = l.prims.find((p) => p.kind === "path" && p.style === "centre" && p.points.length === 4 && Math.abs(p.points[0] - (host.box[0] + 10)) < 1e-9);
    expect(cut).toBeDefined();
  });

  it("gives thread symbols and hole callouts the tapped holes of the view's own part", () => {
    const d: Drawing = { ...twoParts(), dimensions: [{ id: "c", view: "front@vw1", type: "diameter", a: { at: [10, 5], rel: [0.5, 0.5] }, r: 2, offset: 8, angle: 45, callout: true }] };
    d.views = d.views.filter((v) => v.kind !== "top");
    const p = { front: both.front, "front@vw1": { ...both["front@vw1"]!, holes: [{ cx: 10, cy: 5, d: 4, through: true, depth: 10 }] } };
    const texts = (i: SheetInfo) => layoutSheet(d, p, i).prims.flatMap((x) => (x.kind === "text" ? [x.text] : []));
    const thin = (i: SheetInfo) => layoutSheet(d, p, i).prims.filter((x) => x.kind === "path" && x.style === "thin").length;
    const m5 = [{ drill: 4, thread: "M5 × 0.8", major: 5 }];
    // The sheet's part has an M5 tapped hole, p2 none: p2's ⌀4 isn't called M5.
    expect(texts({ ...info, taps: m5 }).some((t) => t.includes("M5"))).toBe(false);
    expect(texts({ ...info, taps: [], groupTaps: { vw1: m5 } }).some((t) => t.includes("M5 × 0.8"))).toBe(true);
    // And its thread is drawn (one three-quarter circle) only with p2's own taps.
    expect(thin({ ...info, taps: [], groupTaps: { vw1: m5 } }) - thin({ ...info, taps: m5 })).toBe(1);
  });

  it("tags the holes of a view of another part in the hole table when the sheet's part has none", () => {
    const d: Drawing = { ...twoParts(), holeTable: true };
    expect(holeTableView(d, both)).toBe("front@vw1");
    const l = layoutSheet(d, both, info);
    const host = l.views.find((v) => v.key === "front@vw1")!;
    const tag = l.prims.find((p) => p.kind === "text" && p.text === "A1");
    // Beside the hole's centre (10, 5) on p2's front: 0.7 r + 0.8 up and right.
    expect(tag && tag.kind === "text" ? [tag.x, tag.y] : null).toEqual([host.box[0] + 10 + 0.7 * 2 + 0.8, host.box[1] + 5 + 0.7 * 2 + 0.8]);
  });

  it("puts the parts list and balloons of a view of an assembly on that view", () => {
    let d = addViewOf(twoParts(), "vw2", { kind: "assembly", id: "a1" }, "iso").drawing;
    d = { ...d, views: d.views.filter((v) => v.id !== "vw1" && v.parent !== "vw1") };
    const drawn = sheetParts(d, doc, parts);
    expect(drawn[1].subject!.instances!.map((i) => i.position)).toEqual([
      [0, 0, 0],
      [50, 0, 0],
    ]);
    const full = withViewParts(info, doc, parts, drawn);
    expect(full.bom).toEqual([
      { item: 1, name: "Base", quantity: 1, partId: "p1" },
      { item: 2, name: "Bolt", quantity: 1, partId: "p2" },
    ]);
    expect(full.balloonGroup).toBe("vw2");
    expect(full.balloons!.map((b) => b.item)).toEqual([1, 2]);
    const p = { front: both.front, top: both.top, "iso@vw2": block("iso@vw2", 60, 10) };
    const l = layoutSheet(d, p, full);
    const iso = l.views.find((v) => v.key === "iso@vw2")!;
    const balloonNumbers = l.prims.filter((x) => x.kind === "text" && (x.text === "1" || x.text === "2") && x.size === 3.5);
    expect(balloonNumbers.length).toBe(2);
    // Each balloon sits round the assembly's 3D view, not p1's views.
    for (const b of balloonNumbers) if (b.kind === "text") expect(b.x > iso.box[0] - 30 && b.x < iso.box[2] + 30).toBe(true);
    // The sheet's own part isn't an assembly: without the view, no parts list.
    expect(withViewParts(info, doc, parts, sheetParts(removeViewOf(d, "vw2"), doc, parts))).toBe(info);
  });

  it("auto-dimensions each part's views as it would that part on its own", () => {
    const d = twoParts();
    let n = 0;
    const all = autoDimensionSheet(both, d, [], 1, () => `a${n++}`);
    let k = 0;
    const own = autoDimensions(both, ["front", "top"], [], 1, () => `a${k++}`);
    const alone = autoDimensions({ front: both["front@vw1"], top: both["top@vw1"] }, ["front", "top"], [], 1, () => `a${k++}`);
    expect(all).toEqual([...own, ...alone.map((x) => ({ ...x, view: `${x.view}@vw1` }))]);
    // p2's width 20 and height 10 among them, on its own views.
    const sizes = layoutSheet({ ...d, dimensions: all }, both, info).dims.filter((x) => all.find((y) => y.id === x.id)!.view.endsWith("@vw1"));
    expect(sizes.length).toBe(alone.length);
    expect(alone.length).toBeGreaterThan(0);
  });
});
