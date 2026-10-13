import { describe, expect, it } from "vitest";

import {
  addFeature,
  commit,
  createFeature,
  emptyDocument,
  featuresWithDraft,
  historyOf,
  nextFeatureName,
  parseDocument,
  redo,
  removeFeature,
  renameFeature,
  replaceFeature,
  setSuppressed,
  undo,
} from "../src/model/document";
import { defaultParams, describeParamErrors, resolveParams } from "../src/model/features";

describe("documents", () => {
  it("names features Box 1, Box 2… and reuses gaps", () => {
    let doc = emptyDocument();
    const a = createFeature(doc, "box");
    doc = addFeature(doc, a);
    const b = createFeature(doc, "box");
    doc = addFeature(doc, b);
    expect([a.name, b.name]).toEqual(["Box 1", "Box 2"]);
    expect(nextFeatureName(doc, "cylinder")).toBe("Cylinder 1");
    doc = removeFeature(doc, a.id);
    expect(nextFeatureName(doc, "box")).toBe("Box 1");
  });

  it("gives every feature a unique id", () => {
    const doc = emptyDocument();
    const ids = new Set(Array.from({ length: 500 }, () => createFeature(doc, "sphere").id));
    expect(ids.size).toBe(500);
  });

  it("edits without changing the original document", () => {
    const doc = addFeature(emptyDocument(), createFeature(emptyDocument(), "box"));
    const f = doc.features[0];
    const edited = replaceFeature(doc, { ...f, params: { ...f.params, width: "99" } });
    expect(doc.features[0].params.width).toBe("40");
    expect(edited.features[0].params.width).toBe("99");
    expect(renameFeature(edited, f.id, "  Base  ").features[0].name).toBe("Base");
    expect(renameFeature(edited, f.id, "   ")).toBe(edited);
    expect(setSuppressed(edited, f.id, true).features[0].suppressed).toBe(true);
  });

  it("previews a draft in place or at the end", () => {
    const doc = addFeature(emptyDocument(), createFeature(emptyDocument(), "box"));
    const existing = { ...doc.features[0], name: "Changed" };
    expect(featuresWithDraft(doc.features, existing).map((f) => f.name)).toEqual(["Changed"]);
    const fresh = createFeature(doc, "cylinder");
    expect(featuresWithDraft(doc.features, fresh)).toHaveLength(2);
    expect(featuresWithDraft(doc.features, null)).toBe(doc.features);
  });

  it("undoes and redoes", () => {
    let h = historyOf(emptyDocument());
    const f = createFeature(h.present, "box");
    h = commit(h, addFeature(h.present, f));
    h = commit(h, removeFeature(h.present, f.id));
    expect(h.present.features).toHaveLength(0);
    h = undo(h);
    expect(h.present.features).toHaveLength(1);
    h = undo(h);
    expect(h.present.features).toHaveLength(0);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present.features).toHaveLength(1);
    // A new change clears the redo stack.
    h = commit(h, emptyDocument("Other"));
    expect(h.future).toHaveLength(0);
    expect(redo(h)).toBe(h);
  });

  it("ignores no-op commits", () => {
    const h = historyOf(emptyDocument());
    expect(commit(h, h.present)).toBe(h);
  });

  it("loads saved documents safely", () => {
    const doc = addFeature(emptyDocument("Bracket"), createFeature(emptyDocument(), "cylinder"));
    const roundTrip = parseDocument(JSON.parse(JSON.stringify(doc)));
    expect(roundTrip).toEqual(doc);

    expect(parseDocument(null)).toBeNull();
    expect(parseDocument({ format: "other" })).toBeNull();
    expect(parseDocument({ ...doc, features: [{ ...doc.features[0], type: "teapot" }] })).toBeNull();
    expect(parseDocument({ ...doc, features: [doc.features[0], doc.features[0]] })).toBeNull();

    // Numbers are accepted and missing parameters fall back to defaults.
    const loose = parseDocument({
      ...doc,
      features: [{ ...doc.features[0], params: { diameter: 12 } }],
    });
    expect(loose?.features[0].params.diameter).toBe("12");
    expect(loose?.features[0].params.height).toBe(defaultParams("cylinder").height);
  });
});

describe("feature parameters", () => {
  it("resolves expressions and rejects bad sizes", () => {
    const ok = resolveParams({ type: "box", params: { ...defaultParams("box"), width: "10 + 5", x: "-3" } });
    expect(ok.errors).toEqual({});
    expect(ok.values.width).toBe(15);
    expect(ok.values.x).toBe(-3);

    const bad = resolveParams({ type: "box", params: { ...defaultParams("box"), width: "0", depth: "oops" } });
    expect(Object.keys(bad.errors).sort()).toEqual(["depth", "width"]);
  });

  it("summarises the first problem for the feature list", () => {
    const f = createFeature(emptyDocument(), "sphere");
    expect(describeParamErrors(f)).toBeNull();
    expect(describeParamErrors({ ...f, params: { ...f.params, diameter: "-1" } })).toMatch(/Diameter/);
  });
});

describe("revolve and shell features", () => {
  it("revolve picks the latest sketch and its construction line", async () => {
    const { addLine, addRectangle } = await import("../src/sketch/ops");
    const { emptySketch } = await import("../src/sketch/types");
    let data = addRectangle(emptySketch(), { x: 0, y: 0 }, { x: 10, y: 10 }).sketch;
    const axis = addLine(data, { x: -5, y: 0 }, { x: 15, y: 0 }, { construction: true });
    data = axis.sketch;
    let doc = emptyDocument();
    const sk = createFeature(doc, "sketch");
    sk.sketch = { plane: { kind: "default", name: "Top" }, data };
    doc = addFeature(doc, sk);
    const rev = createFeature(doc, "revolve");
    expect(rev.sketchRef).toBe(sk.id);
    expect(rev.revolve).toEqual({ axis: axis.lineId, flip: false });
    expect(rev.params.angle).toBe("360");

    const shell = createFeature(addFeature(doc, rev), "shell");
    expect(shell.picks).toEqual([]);
    expect(shell.params.thickness).toBe("2");

    // Both survive saving and loading.
    const saved = parseDocument(JSON.parse(JSON.stringify(addFeature(addFeature(doc, rev), shell))));
    expect(saved?.features.map((f) => f.type)).toEqual(["sketch", "revolve", "shell"]);
    expect(saved?.features[1].revolve).toEqual(rev.revolve);
  });
});

describe("mirror and pattern features", () => {
  it("start with the latest solid feature, and survive saving", () => {
    let doc = emptyDocument();
    const box = createFeature(doc, "box");
    doc = addFeature(doc, box);
    const mirror = createFeature(doc, "mirror");
    expect(mirror.mirror).toEqual({ sources: [box.id], plane: { kind: "default", name: "Right" } });
    const circ = createFeature(doc, "circularPattern");
    expect(circ.pattern).toEqual({ sources: [box.id], axis: "z", flip: false });
    expect(circ.params).toEqual({ count: "6", angle: "360" });
    const saved = parseDocument(JSON.parse(JSON.stringify(addFeature(addFeature(doc, mirror), circ))));
    expect(saved?.features[1].mirror).toEqual(mirror.mirror);
    expect(saved?.features[2].pattern).toEqual(circ.pattern);
  });
});
