/**
 * Feature dialogs' starting values and Accept (pure + the app's store): a Remove from a sketch on a part's face points
 * into the part; Accept waits until what must be picked is picked; a new Hole starts with no old sketch and a clicked
 * face places its holes; nothing stays selected after Accept; a Linear pattern's spacing clears what it repeats.
 */
import { beforeEach, describe, expect, it } from "vitest";

import type { PartMesh } from "../src/kernel/protocol";
import { emptyDocument, historyOf } from "../src/model/document";
import { acceptBlocker, missingPick } from "../src/model/draftReady";
import { aimedFlip, clearSpacing, holeSketchFor, materialBehind, sizeAlong, suggestedSpacing, translateDirection } from "../src/model/newFeatureDefaults";
import { activeFeatures, useStore } from "../src/model/store";
import type { Feature, JuraCADDocument } from "../src/model/types";
import { addCircle, addPoint } from "../src/sketch/ops";
import { planeOnFace, type SketchPlane } from "../src/sketch/planes";
import { emptySketch } from "../src/sketch/types";

const s = () => useStore.getState();
const feat = (id: string, type: Feature["type"], extra: Partial<Feature> = {}): Feature => ({ id, name: id, type, operation: "new", suppressed: false, params: {}, ...extra });
const docOf = (features: Feature[]): JuraCADDocument => ({ ...emptyDocument("T"), features });
const topFace: SketchPlane = { kind: "face", origin: [0, 0, 20], u: [1, 0, 0], v: [0, 1, 0], label: "Face of Part 1", face: { partId: "b", ref: { kind: "face", surface: "PLANE", center: [20, 15, 20], normal: [0, 0, 1] } } };
const circleOn = (id: string, plane: SketchPlane | null): Feature => feat(id, "sketch", { sketch: { plane, data: addCircle(emptySketch(), { x: 20, y: 15 }, 5).sketch } });
const mesh = (id: string, lo: [number, number, number], hi: [number, number, number]): PartMesh =>
  ({ id, name: id, featureIds: [id.split("~")[0]], vertices: new Float32Array([...lo, ...hi]), normals: new Float32Array(), triangles: new Uint32Array(), faceGroups: [], lines: new Float32Array(), edgeGroups: [], faceRefs: [], edgeRefs: [] }) as unknown as PartMesh;

const reset = (features: Feature[], extra: Record<string, unknown> = {}) =>
  useStore.setState({ history: historyOf(docOf(features)), editing: null, sketch: null, parts: [], selection: [], selectedParts: [], selectedPlane: null, selectedFeatureId: null, rollbackTo: null, areaSelection: null, sketchLinks: {}, ...extra });

describe("which way an Extrude from a part's face starts", () => {
  it("knows the part is behind a sketch on its face, and nothing about plain planes", () => {
    expect(materialBehind(topFace)).toBe(true);
    expect(materialBehind({ kind: "default", name: "Top" })).toBeNull();
    expect(materialBehind({ ...topFace, face: undefined })).toBeNull();
    const ext = { type: "extrude" as const, extrude: { end: "blind" as const, flip: false } };
    expect(aimedFlip({ ...ext, operation: "remove" }, topFace)).toBe(true);
    expect(aimedFlip({ ...ext, operation: "intersect" }, topFace)).toBe(true);
    expect(aimedFlip({ ...ext, operation: "add" }, topFace)).toBe(false);
    expect(aimedFlip({ ...ext, operation: "remove" }, { kind: "default", name: "Top" })).toBeNull();
    // A sketch on the bottom face (its normal points down, out of the part): a Remove still goes up into it.
    const bottom = planeOnFace([0, 0, -1], [20, 15, 0], "Face of Part 1", { partId: "b", ref: { kind: "face", surface: "PLANE", center: [20, 15, 0], normal: [0, 0, -1] } });
    expect(materialBehind(bottom)).toBe(true);
    expect(aimedFlip({ ...ext, operation: "remove" }, bottom)).toBe(true);
  });

  it("points a Remove into the part when chosen, back out for Add, and leaves a direction the user chose", () => {
    reset([feat("b", "box"), circleOn("sk", topFace)], { selectedFeatureId: "sk" });
    s().startCreate("extrude");
    expect(s().editing!.draft.sketchRef).toBe("sk");
    expect(s().editing!.draft.extrude!.flip).toBe(false);
    s().setDraftField({ operation: "remove" });
    expect(s().editing!.draft.extrude!.flip).toBe(true);
    s().setDraftField({ operation: "add" });
    expect(s().editing!.draft.extrude!.flip).toBe(false);
    s().setDraftField({ operation: "remove" });
    // Flipped back by hand: switching to Intersect leaves it.
    s().setDraftField({ extrude: { ...s().editing!.draft.extrude!, flip: false } });
    s().setDraftField({ operation: "intersect" });
    expect(s().editing!.draft.extrude!.flip).toBe(false);
    s().cancelDraft();
  });

  it("leaves an existing Extrude's direction alone when its operation is changed", () => {
    const e = feat("e", "extrude", { operation: "add", sketchRef: "sk", extrude: { end: "blind", flip: false }, params: { depth: "5" } });
    reset([feat("b", "box"), circleOn("sk", topFace), e]);
    s().startEdit("e");
    s().setDraftField({ operation: "remove" });
    expect(s().editing!.draft.extrude!.flip).toBe(false);
    s().cancelDraft();
  });
});

describe("Accept waits for what must be picked", () => {
  it("says what to click for each kind of feature", () => {
    expect(missingPick(feat("f", "fillet", { picks: [] }))).toMatch(/Click the edges/);
    expect(missingPick(feat("f", "chamfer", { picks: [] }))).toMatch(/bevel/);
    expect(missingPick(feat("f", "shell", { picks: [] }))).toMatch(/Pick the faces to leave open/);
    expect(missingPick(feat("f", "shell", { picks: [], hollow: true }))).toBeNull();
    expect(missingPick(feat("f", "draft", { picks: [] }))).toMatch(/faces/);
    expect(missingPick(feat("f", "moveFace", { picks: [] }))).toMatch(/faces/);
    expect(missingPick(feat("f", "split", { splitDef: { mode: "face", plane: { kind: "default", name: "Top" }, keep: "both" } as Feature["splitDef"] }))).toMatch(/faces to split/);
    expect(missingPick(feat("f", "split", { splitDef: { plane: { kind: "default", name: "Top" }, keep: "both" } as Feature["splitDef"] }))).toBeNull();
    expect(missingPick(feat("f", "composite", { compositeParts: ["a"] }))).toMatch(/two or more/);
    expect(missingPick(feat("f", "hole", { hole: { kind: "simple", standard: "M3", fit: "clearance", end: "throughAll", flip: false } }))).toMatch(/Click a face/);
    expect(missingPick(feat("f", "extrude", { sketchRef: "s" }))).toBeNull();
    const edge = { partId: "b", ref: { kind: "edge" as const, curve: "LINE", a: [0, 0, 0] as [number, number, number], b: [1, 0, 0] as [number, number, number], mid: [0.5, 0, 0] as [number, number, number] } };
    expect(missingPick(feat("f", "fillet", { picks: [edge] }))).toBeNull();
    // Shell's faces only: an edge clicked by mistake doesn't count.
    expect(missingPick(feat("f", "shell", { picks: [edge] }))).toMatch(/Pick the faces/);
  });

  it("refuses a fillet with nothing picked instead of adding a failed one", () => {
    reset([feat("b", "box")]);
    s().startCreate("fillet");
    expect(s().commitDraft()).toBe(false);
    expect(s().editing).not.toBeNull();
    expect(activeFeatures(s()).length).toBe(1);
    s().cancelDraft();
  });
});

describe("Accept never traps an existing feature", () => {
  it("lets a feature that was already missing its picks be accepted again (an old Open shell, edges lost upstream)", () => {
    const oldShell = feat("sh", "shell");
    expect(acceptBlocker(oldShell, oldShell)).toBeNull();
    expect(acceptBlocker(oldShell, null)).toMatch(/Pick the faces/);
    const edge = { partId: "b", ref: { kind: "edge" as const, curve: "LINE", a: [0, 0, 0] as [number, number, number], b: [1, 0, 0] as [number, number, number], mid: [0.5, 0, 0] as [number, number, number] } };
    // Had its picks when opened, all taken off in the dialog: waits again.
    expect(acceptBlocker(feat("f", "fillet"), feat("f", "fillet", { picks: [edge] }))).toMatch(/Click the edges/);
    reset([feat("b", "box"), oldShell]);
    s().startEdit("sh");
    s().setDraftParam("thickness", "3");
    expect(s().commitDraft()).toBe(true);
  });
});

describe("nothing stays selected after Accept", () => {
  it("leaves no feature, part or face picked (a sketch stays highlighted for the next Extrude)", () => {
    reset([]);
    s().startCreate("box");
    expect(s().commitDraft()).toBe(true);
    expect(s().selectedFeatureId).toBeNull();
    expect(s().selectedParts).toEqual([]);
    expect(s().selection).toEqual([]);
    s().startSketch({ kind: "default", name: "Top" });
    const id = s().editing!.draft.id;
    expect(s().commitDraft()).toBe(true);
    expect(s().selectedFeatureId).toBe(id);
  });
});

describe("a new Hole's sketch", () => {
  const withPoint = (id: string) => feat(id, "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: addPoint(emptySketch(), { x: 1, y: 1 }).sketch } });
  const count = (f: Feature) => (f.sketch?.data.points.some((p) => p.standalone) ? 1 : 0);

  it("is the one highlighted, else the sketch just made, else none (never an old, used one)", () => {
    const used = new Set(["s1"]);
    const e = feat("e", "extrude", { sketchRef: "s1" });
    expect(holeSketchFor([withPoint("s1"), e], null, used, count)).toBeUndefined();
    expect(holeSketchFor([withPoint("s1"), e, withPoint("s2")], null, used, count)).toBe("s2");
    expect(holeSketchFor([withPoint("s1"), e], "s1", used, count)).toBe("s1");
    // Just made but with nothing to drill at: none.
    expect(holeSketchFor([withPoint("s1"), e, feat("s3", "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: emptySketch() } })], null, used, count)).toBeUndefined();
  });

  it("is made by clicking a face — points added by more clicks, in with the hole as one undo step", () => {
    const e = feat("e", "extrude", { sketchRef: "s1", params: { depth: "20" }, extrude: { end: "blind", flip: false } });
    reset([withPoint("s1"), e]);
    s().startCreate("hole");
    expect(s().editing!.draft.hole!.sketchRef).toBeUndefined();
    const steps = s().history.past.length;
    s().placeHoleAt(topFace, [10, 10, 20]);
    s().placeHoleAt(topFace, [30, 20, 20]);
    const ref = s().editing!.draft.hole!.sketchRef!;
    const made = activeFeatures(s()).find((f) => f.id === ref)!;
    expect(made.type).toBe("sketch");
    expect(made.sketch!.data.points.filter((p) => p.standalone).map((p) => [Math.round(p.x), Math.round(p.y)])).toEqual([
      [10, 10],
      [30, 20],
    ]);
    // Not an undo step of its own while the dialog is open.
    expect(s().history.past.length).toBe(steps);
    // Another face: refused (one Hole's holes go on one face).
    s().placeHoleAt({ kind: "face", origin: [0, 0, 0], u: [1, 0, 0], v: [0, 0, 1], label: "Side" }, [5, 0, 5]);
    expect(activeFeatures(s()).find((f) => f.id === ref)!.sketch!.data.points.length).toBe(2);
    expect(s().commitDraft()).toBe(true);
    const list = activeFeatures(s()).map((f) => f.type);
    expect(list).toEqual(["sketch", "extrude", "sketch", "hole"]);
    expect(s().history.past.length).toBe(steps + 1);
    s().undo();
    expect(activeFeatures(s()).map((f) => f.id)).toEqual(["s1", "e"]);
  });

  it("goes away again when the Hole is cancelled", () => {
    reset([withPoint("s1")]);
    s().startCreate("hole");
    s().placeHoleAt(topFace, [10, 10, 20]);
    expect(activeFeatures(s()).length).toBe(2);
    s().cancelDraft();
    expect(activeFeatures(s()).map((f) => f.id)).toEqual(["s1"]);
  });
});

describe("a Hole's face clicks never put an older design back", () => {
  const withPoint = (id: string) => feat(id, "sketch", { sketch: { plane: { kind: "default", name: "Top" }, data: addPoint(emptySketch(), { x: 1, y: 1 }).sketch } });
  it("keeps a change made while the dialog is open (the design renamed between clicks), on Cancel and on Accept", () => {
    for (const accept of [false, true]) {
      reset([withPoint("s1")]);
      s().startCreate("hole");
      s().placeHoleAt(topFace, [10, 10, 20]);
      s().renameDocument("Renamed");
      s().placeHoleAt(topFace, [30, 20, 20]);
      expect(s().history.present.name).toBe("Renamed");
      if (accept) {
        expect(s().commitDraft()).toBe(true);
        expect(activeFeatures(s()).map((f) => f.type)).toEqual(["sketch", "sketch", "hole"]);
        expect(activeFeatures(s())[1].sketch!.data.points.length).toBe(2);
      } else {
        s().cancelDraft();
        expect(activeFeatures(s()).map((f) => f.id)).toEqual(["s1"]);
      }
      expect(s().history.present.name).toBe("Renamed");
    }
  });

  it("forgets the sketch when another design is opened mid-dialog, without bringing the old one back later", () => {
    reset([withPoint("s1")]);
    s().startCreate("hole");
    s().placeHoleAt(topFace, [10, 10, 20]);
    s().newDocument();
    s().startCreate("box");
    expect(s().commitDraft()).toBe(true);
    expect(activeFeatures(s()).map((f) => f.type)).toEqual(["box"]);
    s().startCreate("box");
    s().cancelDraft();
    expect(activeFeatures(s()).map((f) => f.type)).toEqual(["box"]);
  });
});

describe("a Linear pattern's spacing", () => {
  it("clears what it repeats along the direction", () => {
    const block = mesh("a", [0, 0, 0], [60, 30, 10]);
    expect(sizeAlong([block], [1, 0, 0])).toBe(60);
    expect(sizeAlong([block], [0, 1, 0])).toBe(30);
    expect(clearSpacing(60)).toBe("72");
    expect(clearSpacing(60, "in")).toBe("3 in");
    const p = { type: "linearPattern" as const, pattern: { sources: [], axis: "x" as const, flip: false, of: "part" as const, parts: ["a"] } };
    expect(suggestedSpacing(p, [block], [])).toBe("72");
    expect(suggestedSpacing({ ...p, pattern: { ...p.pattern, parts: [] } }, [block], [])).toBeNull();
  });

  it("starts from the part's size and follows a new direction, until the user types one", () => {
    reset([feat("a", "box")], { parts: [mesh("a", [0, 0, 0], [60, 30, 10])], selectedParts: ["a"] });
    s().startCreate("linearPattern");
    expect(s().editing!.draft.params.spacing).toBe("72");
    s().setDraftField({ pattern: { ...s().editing!.draft.pattern!, axis: "y" } });
    expect(s().editing!.draft.params.spacing).toBe("36");
    s().setDraftParam("spacing", "50");
    s().setDraftField({ pattern: { ...s().editing!.draft.pattern!, axis: "z" } });
    expect(s().editing!.draft.params.spacing).toBe("50");
    s().cancelDraft();
    // A feature pattern of the feature that made the part, too.
    reset([feat("a", "box")], { parts: [mesh("a", [0, 0, 0], [60, 30, 10])] });
    s().startCreate("linearPattern");
    expect(s().editing!.draft.pattern!.sources).toEqual(["a"]);
    expect(s().editing!.draft.params.spacing).toBe("72");
    s().cancelDraft();
  });
});

beforeEach(() => reset([]));

describe("a Move face Translate's direction", () => {
  const side = { partId: "a", ref: { kind: "face" as const, surface: "PLANE", center: [40, 15, 5] as [number, number, number], normal: [1, 0, 0] as [number, number, number] } };
  const slant = { partId: "a", ref: { kind: "face" as const, surface: "PLANE", center: [20, 15, 8] as [number, number, number], normal: [0.6, 0, 0.8] as [number, number, number] } };
  // A whole cylinder's face keeps no normal: its axis comes from the mesh (tests/engineMovePiece), so with none known: no opinion.
  const holeWall = { partId: "a", ref: { kind: "face" as const, surface: "CYLINDRE", center: [15, 15, 5] as [number, number, number], normal: [0, 0, 0] as [number, number, number] } };

  it("starts straight out of the first picked face, not along Z", () => {
    const mf = (picks: Feature["picks"]) => ({ type: "moveFace" as const, moveFace: { mode: "translate" as const }, picks });
    expect(translateDirection(mf([side]))).toEqual({ axis: "x" });
    expect(translateDirection(mf([slant]))).toEqual({ along: slant });
    expect(translateDirection(mf([holeWall]))).toBeNull();
    expect(translateDirection(mf([]))).toBeNull();
    expect(translateDirection({ ...mf([side]), moveFace: { mode: "offset" } })).toBeNull();
  });

  it("follows the picks in the dialog until a direction is chosen", () => {
    reset([feat("a", "box")]);
    s().startCreate("moveFace");
    s().setDraftField({ moveFace: { mode: "translate" } });
    s().toggleDraftPick(side);
    expect(s().editing!.draft.moveFace).toEqual({ mode: "translate", axis: "x" });
    s().toggleDraftPick(side);
    s().toggleDraftPick(slant);
    expect(s().editing!.draft.moveFace).toEqual({ mode: "translate", along: slant });
    // Chosen by hand: a later pick leaves it.
    s().setDraftField({ moveFace: { mode: "translate", axis: "z" } });
    s().toggleDraftPick(slant);
    s().toggleDraftPick(side);
    expect(s().editing!.draft.moveFace).toEqual({ mode: "translate", axis: "z" });
    s().cancelDraft();
    // Faces picked first, Translate chosen after.
    reset([feat("a", "box")]);
    s().startCreate("moveFace");
    s().toggleDraftPick(side);
    s().setDraftField({ moveFace: { mode: "translate" } });
    expect(s().editing!.draft.moveFace).toEqual({ mode: "translate", axis: "x" });
    s().cancelDraft();
  });
});
