import { describe, expect, it } from "vitest";
import { featureForEngine, featuresForEngine } from "../src/kernel/buildInput";
import type { Feature } from "../src/model/types";
import { emptySketch } from "../src/sketch/types";

const sketch = (id: string, extra: Partial<Feature> = {}): Feature => ({
  id,
  name: id,
  type: "sketch",
  operation: "new",
  suppressed: false,
  params: {},
  sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() },
  ...extra,
});

describe("what the geometry engine is given", () => {
  it("leaves out folders, pictures and the eye, so changing them doesn't rebuild anything", () => {
    const plain = [sketch("s1"), sketch("s2")];
    expect(featuresForEngine(plain)).toBe(plain);
    // The engine's cache key is the features as JSON: the same whatever the eye, folder or pictures say.
    const key = JSON.stringify(featuresForEngine(plain));
    const shown = [sketch("s1", { visible: true }), sketch("s2", { visible: false, folder: "Sketches" })];
    expect(JSON.stringify(featuresForEngine(shown))).toBe(key);
    const pictured = [sketch("s1", { sketch: { plane: { kind: "default", name: "Top" }, data: { ...emptySketch(), images: [] } } }), sketch("s2")];
    expect(JSON.stringify(featuresForEngine(pictured))).toBe(key);
    // Worked out once per list.
    expect(featuresForEngine(shown)).toBe(featuresForEngine(shown));
    // The feature being edited too.
    expect(JSON.stringify(featureForEngine(sketch("s1", { visible: false })))).toBe(JSON.stringify(sketch("s1")));
    expect(featureForEngine(null)).toBeNull();
  });
});
