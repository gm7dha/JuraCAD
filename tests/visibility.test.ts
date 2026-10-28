import { describe, expect, it } from "vitest";
import { createFeature, emptyDocument, parseDocument } from "../src/model/document";
import { readDocumentFile, serializeDocument } from "../src/model/fileFormat";
import { addStudio } from "../src/model/studios";
import { resolveParams, visibleParamKeys } from "../src/model/features";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { emptySketch } from "../src/sketch/types";
import {
  anyPlaneShown,
  featureVisible,
  hiddenDatumsOf,
  keepVisibility,
  parseHiddenDatums,
  planeVisible,
  setAllPlanesVisible,
  setAllSketchesVisible,
  setDatumHidden,
  setFeaturesVisible,
  sketchVisible,
  toggleAllPlanes,
  usedSketches,
} from "../src/model/visibility";

const f = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({
  id,
  name: id,
  type,
  operation: "new",
  suppressed: false,
  params: {},
  ...(type === "sketch" ? { sketch: { plane: { kind: "default" as const, name: "Top" as const }, data: emptySketch() } } : {}),
  ...extra,
});
const doc = (features: Feature[]): JuraCADDocument => ({ ...emptyDocument(), features });
const roundTrip = (d: JuraCADDocument) => {
  const read = readDocumentFile(serializeDocument(d));
  if (!read.ok) throw new Error(read.error);
  return read.doc;
};

describe("sketch visibility (like Onshape)", () => {
  // Sketches: profile, path, loft sections, hole points, an unused one, and one used only by a suppressed extrude.
  const features = [
    f("s1", "sketch"),
    f("s2", "sketch"),
    f("s3", "sketch"),
    f("s4", "sketch"),
    f("s5", "sketch"),
    f("s6", "sketch"),
    f("s7", "sketch"),
    f("e1", "extrude", { sketchRef: "s1" }),
    f("w1", "sweep", { sketchRef: "s2", pathRef: "s3" }),
    f("l1", "loft", { sections: ["s4"] }),
    f("h1", "hole", { hole: { sketchRef: "s5" } as Feature["hole"] }),
    f("e2", "extrude", { sketchRef: "s7", suppressed: true }),
  ];

  it("hides a sketch by itself once a feature uses it", () => {
    const used = usedSketches(features);
    expect([...used].sort()).toEqual(["s1", "s2", "s3", "s4", "s5"]);
    expect(features.filter((x) => x.type === "sketch" && sketchVisible(x, used)).map((x) => x.id)).toEqual(["s6", "s7"]);
    // Worked out once per list.
    expect(usedSketches(features)).toBe(used);
  });

  it("the eye overrides that either way, and is saved", () => {
    let d = doc(features);
    d = setFeaturesVisible(d, ["s1", "s6"], true);
    d = setFeaturesVisible(d, ["s7"], false);
    const vis = (x: JuraCADDocument) => x.features.filter((y) => y.type === "sketch" && featureVisible(y, x.features)).map((y) => y.id);
    expect(vis(d)).toEqual(["s1", "s6"]);
    // Features without an eye are left alone, and a no-op change gives the same document.
    expect(setFeaturesVisible(d, ["e1"], false)).toBe(d);
    expect(setFeaturesVisible(d, ["s1"], true)).toBe(d);
    const back = roundTrip(d);
    expect(back.features.find((x) => x.id === "s1")!.visible).toBe(true);
    expect(back.features.find((x) => x.id === "s7")!.visible).toBe(false);
    expect(back.features.find((x) => x.id === "s2")!.visible).toBeUndefined();
    expect(vis(back)).toEqual(["s1", "s6"]);
  });

  it("shows or hides all sketches at once", () => {
    const all = setAllSketchesVisible(doc(features), true);
    expect(all.features.filter((x) => x.type === "sketch").every((x) => featureVisible(x, all.features))).toBe(true);
    expect(all.features.find((x) => x.id === "e1")!.visible).toBeUndefined();
    const none = setAllSketchesVisible(all, false);
    expect(none.features.filter((x) => x.type === "sketch").some((x) => featureVisible(x, none.features))).toBe(false);
  });

  it("an edit that was open keeps the eye as it is now", () => {
    const d = setFeaturesVisible(doc(features), ["s1"], true);
    const draft = { ...features[0], name: "renamed" };
    expect(keepVisibility(d, draft)).toEqual({ ...draft, visible: true });
    const d2 = setFeaturesVisible(d, ["s1"], false);
    expect(keepVisibility(d2, { ...draft, visible: true }).visible).toBe(false);
    // Nothing set in the document: nothing set on the draft either.
    expect("visible" in keepVisibility(doc(features), { ...draft, visible: true })).toBe(false);
  });
});

describe("plane and default-plane visibility", () => {
  it("planes are shown until hidden, saved in the file", () => {
    const base = emptyDocument();
    const plane = { ...createFeature(base, "plane"), id: "p1" };
    expect(planeVisible(plane)).toBe(true);
    const d = setFeaturesVisible({ ...base, features: [plane] }, ["p1"], false);
    expect(planeVisible(d.features[0])).toBe(false);
    expect(roundTrip(d).features[0].visible).toBe(false);
  });

  it("hides the Origin and Top/Front/Right per Part Studio, saved in the file", () => {
    let d = addStudio(emptyDocument(), "ps2");
    expect(hiddenDatumsOf(d, "main")).toEqual([]);
    expect(hiddenDatumsOf(d, "main")).toBe(hiddenDatumsOf(d, "ps2")); // same empty list: safe in selectors
    d = setDatumHidden(d, "main", "Right", true);
    d = setDatumHidden(d, "main", "Origin", true);
    d = setDatumHidden(d, "ps2", "Top", true);
    expect(hiddenDatumsOf(d, "main")).toEqual(["Origin", "Right"]);
    expect(hiddenDatumsOf(d, "ps2")).toEqual(["Top"]);
    expect(setDatumHidden(d, "main", "Right", true)).toBe(d);
    const back = roundTrip(d);
    expect(hiddenDatumsOf(back, "main")).toEqual(["Origin", "Right"]);
    expect(hiddenDatumsOf(back, "ps2")).toEqual(["Top"]);
    // Showing everything again leaves nothing behind in the file.
    let shown = setDatumHidden(setDatumHidden(back, "main", "Right", false), "main", "Origin", false);
    shown = setDatumHidden(shown, "ps2", "Top", false);
    expect("hiddenDatums" in shown).toBe(false);
    expect("hiddenDatums" in shown.partStudios![0]).toBe(false);
    expect(serializeDocument(shown)).not.toMatch(/hiddenDatums/);
  });

  it("cleans up what it reads", () => {
    expect(parseHiddenDatums(["Right", "Top", "Nonsense", "Top", 3])).toEqual(["Top", "Right"]);
    expect(parseHiddenDatums([])).toBeUndefined();
    expect(parseHiddenDatums("Top")).toBeUndefined();
  });
});

describe("P: show or hide all planes (like Onshape)", () => {
  const studioDoc = (): JuraCADDocument => {
    const d = addStudio(emptyDocument(), "ps2");
    return {
      ...d,
      features: [f("p1", "plane"), f("p2", "plane", { visible: false }), f("s1", "sketch"), f("p3", "plane", { suppressed: true })],
      partStudios: d.partStudios!.map((s) => ({ ...s, features: [f("q1", "plane")] })),
    };
  };
  const planesOf = (d: JuraCADDocument) => d.features.filter((x) => x.type === "plane").map((x) => x.visible);

  it("hides Top, Front, Right and every Plane feature when any is shown, leaving the Origin, sketches and other studios alone", () => {
    const d = setDatumHidden(studioDoc(), "main", "Origin", true);
    expect(anyPlaneShown(d, "main")).toBe(true);
    const { doc: hidden, visible } = toggleAllPlanes(d, "main");
    expect(visible).toBe(false);
    expect(hiddenDatumsOf(hidden, "main")).toEqual(["Origin", "Top", "Front", "Right"]);
    expect(planesOf(hidden)).toEqual([false, false, false]);
    expect(hidden.features.find((x) => x.id === "s1")!.visible).toBeUndefined();
    expect(anyPlaneShown(hidden, "main")).toBe(false);
    // The other Part Studio is untouched.
    expect(hiddenDatumsOf(hidden, "ps2")).toEqual([]);
    expect(hidden.partStudios![0]).toBe(d.partStudios![0]);
  });

  it("shows them all again when none is shown, and the Origin stays as it was", () => {
    const d = setDatumHidden(studioDoc(), "main", "Origin", true);
    const hidden = toggleAllPlanes(d, "main").doc;
    const { doc: shown, visible } = toggleAllPlanes(hidden, "main");
    expect(visible).toBe(true);
    expect(hiddenDatumsOf(shown, "main")).toEqual(["Origin"]);
    expect(planesOf(shown)).toEqual([true, true, true]);
  });

  it("counts one shown plane, of any kind, as 'some shown'", () => {
    let d = setAllPlanesVisible(studioDoc(), "main", false);
    expect(anyPlaneShown(d, "main")).toBe(false);
    // Just one default plane back on → P hides it.
    const oneDatum = setDatumHidden(d, "main", "Front", false);
    expect(anyPlaneShown(oneDatum, "main")).toBe(true);
    expect(toggleAllPlanes(oneDatum, "main").visible).toBe(false);
    // Just one Plane feature back on → P hides it.
    const oneFeature = setFeaturesVisible(d, ["p2"], true);
    expect(toggleAllPlanes(oneFeature, "main").visible).toBe(false);
    // A suppressed plane isn't drawn, so it doesn't count.
    d = setFeaturesVisible(d, ["p3"], true);
    expect(anyPlaneShown(d, "main")).toBe(false);
  });

  it("works on the Part Studio asked for", () => {
    const d = studioDoc();
    const { doc: out, visible } = toggleAllPlanes(d, "ps2");
    expect(visible).toBe(false);
    expect(hiddenDatumsOf(out, "ps2")).toEqual(["Top", "Front", "Right"]);
    expect(out.partStudios![0].features[0].visible).toBe(false);
    expect(out.features).toBe(d.features);
    expect(hiddenDatumsOf(out, "main")).toEqual([]);
  });

  it("changes nothing when everything is already as asked (no empty undo step)", () => {
    const d = setAllPlanesVisible(studioDoc(), "main", false);
    expect(setAllPlanesVisible(d, "main", false)).toBe(d);
  });
});

describe("older files", () => {
  it("open unchanged: no visibility saved, sweeps without a twist", () => {
    const old = {
      format: "partsmith",
      version: 1,
      name: "Old",
      features: [
        { id: "s1", name: "Sketch 1", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } },
        { id: "s2", name: "Sketch 2", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Right" }, data: emptySketch() } },
        { id: "w1", name: "Sweep 1", type: "sweep", operation: "new", suppressed: false, params: {}, sketchRef: "s2", pathRef: "s1" },
        // A "visible" on something without an eye is ignored.
        { id: "b1", name: "Box 1", type: "box", operation: "add", suppressed: false, params: {}, visible: false },
      ],
    };
    const d = parseDocument(old)!;
    expect(d.hiddenDatums).toBeUndefined();
    expect(d.features.map((x) => x.visible)).toEqual([undefined, undefined, undefined, undefined]);
    // Both sketches are used by the sweep, so (as in Onshape) they're tucked away.
    expect(d.features.filter((x) => x.type === "sketch").map((x) => featureVisible(x, d.features))).toEqual([false, false]);
    const sweep = d.features[2];
    expect(sweep.sweepControl).toBeUndefined();
    expect(resolveParams(sweep).values.twist).toBe(0);
  });

  it("saves and reads a sweep's twist and Keep profile orientation", () => {
    const sweep = f("w1", "sweep", { params: { twist: "90" }, sweepControl: { lockOrientation: true }, sketchRef: "s2", pathRef: "s1" });
    const back = roundTrip(doc([sweep]));
    expect(back.features[0].params.twist).toBe("90");
    expect(back.features[0].sweepControl).toEqual({ lockOrientation: true });
    // Kept facing one way, the twist box is hidden (and its value not used).
    expect(visibleParamKeys(back.features[0]).has("twist")).toBe(false);
    expect(visibleParamKeys({ ...back.features[0], sweepControl: undefined }).has("twist")).toBe(true);
    // Rubbish in the file is dropped.
    const raw = JSON.parse(serializeDocument(doc([sweep])));
    raw.features[0].sweepControl = { lockOrientation: "yes" };
    expect(parseDocument(raw)!.features[0].sweepControl).toBeUndefined();
  });
});
