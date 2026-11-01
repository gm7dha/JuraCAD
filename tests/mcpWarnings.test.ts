/**
 * Claude's tools and features that build with a warning (not a failure): the
 * change goes ahead, and the warning is passed on as a note.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, expect, it } from "vitest";

import { emptyDocument } from "../src/model/document";
import { defaultParams } from "../src/model/features";
import type { Feature } from "../src/model/types";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool } from "../src/mcp/tools";
import { pickOf, sketchAreas } from "../src/sketch/areas";
import { addCircle } from "../src/sketch/ops";
import { emptySketch, type SketchData } from "../src/sketch/types";
import { loadOpenCascade } from "./support/engineHelpers";

beforeAll(loadOpenCascade);
const cleanup: (() => void)[] = [];
afterEach(() => cleanup.splice(0).forEach((f) => f()));

const sketch = (id: string, name: string, data: SketchData): Feature => ({ id, name, type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data } });
const inside = (data: SketchData) => pickOf(sketchAreas(data).areas[0]);

it("deleting an extra sketch of an extrude goes ahead, and Claude is told what was left out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "juracad-warn-"));
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  cleanup.push(() => {
    s.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const small = addCircle(emptySketch(), { x: 0, y: 0 }, 5).sketch;
  const big = addCircle(emptySketch(), { x: 40, y: 0 }, 15).sketch;
  const extrude: Feature = {
    id: "e1",
    name: "Extrude 1",
    type: "extrude",
    operation: "new",
    suppressed: false,
    params: { ...defaultParams("extrude"), depth: "10" },
    sketchRef: "s1",
    extrude: { end: "blind", flip: false },
    apart: true,
    areas: [inside(small)],
    moreAreas: [{ sketch: "s2", areas: [inside(big)] }],
  };
  s.commit({ ...emptyDocument("Warnings"), features: [sketch("s1", "Sketch 1", small), sketch("s2", "Sketch 2", big), extrude] });
  expect(s.build().warnings).toEqual({});
  const r = await callTool(s, "delete_feature", { feature: "Sketch 2" });
  const text = r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
  expect(r.isError).toBeFalsy();
  expect(text).toMatch(/Note: Extrude 1: One of its other sketches has been deleted, so its areas are left out of this extrude/);
  // A warning isn't a failure: nothing is listed as failed.
  expect(s.build().errors).toEqual({});
  expect(Object.keys(s.build().warnings)).toEqual(["e1"]);
});
