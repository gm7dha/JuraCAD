/**
 * Move face on a hole: the arrow stays put while the parts on show lag a drag by a rebuild, and after an earlier change
 * moved the hole back against the move by more than half of it (the parts were built with the move: it's found there).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { manipulatorsFor, shownMoveValue } from "../src/model/manipulators";
import { noteShownDraft, shownDraftFor } from "../src/model/shownDraft";
import type { Feature } from "../src/model/types";
import { feature, loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);

function parts(features: Feature[]) {
  const e = new GeometryEngine();
  try {
    return e.rebuild(features).parts;
  } finally {
    e.dispose();
  }
}

const box = feature("box", { width: 40, depth: 30, height: 10, x: -20, y: -15 });
const hole = feature("cylinder", { diameter: 10, height: 6, x: -8, y: 0, z: 4 }, "remove");
let picked: ReturnType<typeof parts>[number];
let picks: Feature["picks"] = [];
beforeAll(() => {
  picked = parts([box, hole])[0];
  picks = [picked.faceRefs.find((f) => f.surface !== "PLANE")!, picked.faceRefs.find((f) => f.surface === "PLANE" && Math.abs(f.center[2] - 4) < 1e-6)!].map((ref) => ({ partId: picked.id, ref }));
});
const mf = (d: number): Feature => ({ ...feature("moveFace", { distance: d }), id: "mf", moveFace: { mode: "translate", axis: "x" }, picks });
const arrow = (draft: Feature, shownParts: ReturnType<typeof parts>, shown?: Feature | null) => manipulatorsFor(draft, { sketch: null, parts: shownParts, shown }).find((m) => m.id === "distance")!;

describe("Move face's hole arrow and the parts on show", () => {
  it("keeps the arrow where it starts while the shown parts lag the value", () => {
    for (const [shownAt, now] of [[2, 3], [2, 9], [6, 12], [9, 2], [6, 0.5]]) {
      const shown = parts([box, hole, mf(shownAt)]);
      const m = arrow(mf(now), shown, mf(shownAt));
      expect(m.origin[0]).toBeCloseTo(-8, 6);
      expect(m.origin[2]).toBeCloseTo(10, 6);
      expect(m.value).toBe(now);
    }
    // Built without it (it failed): the hole is where it was picked.
    expect(arrow(mf(4), parts([box, hole]), null).origin[0]).toBeCloseTo(-8, 6);
  });

  it("finds the hole moved even when an earlier change put it back by more than half the move", () => {
    for (const ux of [-10, -9.5, -9, -7]) {
      const h2 = { ...hole, params: { ...hole.params, x: String(ux) } };
      const shown = parts([box, h2, mf(2)]);
      expect(arrow(mf(2), shown, mf(2)).origin[0]).toBeCloseTo(ux, 6);
      // Not knowing what the parts were built with, as before: moved back by over half the move, the hole is taken as unmoved.
      if (ux < -9) expect(arrow(mf(2), shown).origin[0]).toBeCloseTo(ux + 2, 6);
    }
  });

  it("knows the shown value only for the same feature, picks and direction", () => {
    const ax = { dir: [1, 0, 0] as [number, number, number], through: [0, 0, 0] as [number, number, number] };
    expect(shownMoveValue(mf(3), undefined, ax)).toBeUndefined();
    expect(shownMoveValue(mf(3), null, ax)).toBe(0);
    expect(shownMoveValue(mf(3), mf(2), ax)).toBe(2);
    expect(shownMoveValue(mf(3), { ...mf(2), id: "other" }, ax)).toBeUndefined();
    expect(shownMoveValue(mf(3), { ...mf(2), moveFace: { mode: "translate", axis: "y" } }, ax)).toBeUndefined();
    noteShownDraft(mf(2), true);
    expect(shownDraftFor(mf(5))?.params.distance).toBe(mf(2).params.distance);
    noteShownDraft(mf(2), false);
    expect(shownDraftFor(mf(5))).toBeNull();
    noteShownDraft(null, false);
    expect(shownDraftFor(mf(5))).toBeUndefined();
  });
});
