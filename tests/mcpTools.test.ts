/**
 * The JuraCAD tools Claude uses (src/mcp/tools.ts), run as plain functions
 * with the real OpenCascade engine: the example bracket from start to a saved
 * file, and the ways things can go wrong.
 */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { GeometryEngine } from "../src/kernel/engine";
import { parseDocument } from "../src/model/document";
import type { Feature } from "../src/model/types";
import { addLine } from "../src/sketch/ops";
import { emptySketch } from "../src/sketch/types";
import { readDocumentFile } from "../src/model/fileFormat";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, fileNameFor, TOOLS, type ToolResult } from "../src/mcp/tools";

beforeAll(async () => {
  setOC(await opencascade());
});

const dirs: string[] = [];
const sessions: Session[] = [];
afterEach(() => {
  sessions.splice(0).forEach((s) => s.dispose());
  dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true }));
});

function newSession() {
  const dir = mkdtempSync(join(tmpdir(), "juracad-mcp-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return { s, dir, folder: join(dir, "JuraCAD") };
}

const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : `[${c.mimeType}]`)).join("\n");

async function ok(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  if (r.isError) throw new Error(`${name} failed: ${textOf(r)}`);
  return textOf(r);
}

async function fails(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  expect(r.isError).toBe(true);
  return textOf(r);
}

const exactVolume = (s: Session) => s.withEngine((e) => e.check("normal").parts.map((p) => p.exactVolume!));

// 60 × 40 × 3 plate, four M4 clearance holes (4.5 mm) 5 mm in from the corners, corners rounded 4 mm.
const PLATE = 60 * 40 * 3;
const HOLES = 4 * Math.PI * 2.25 * 2.25 * 3;
const CORNERS = 4 * 3 * (16 - 4 * Math.PI);
const BRACKET = PLATE - HOLES - CORNERS;

async function buildBracket(s: Session) {
  await ok(s, "new_design", { name: "Mounting bracket" });
  await ok(s, "add_sketch", { name: "Plate outline", plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 60, height: 40 }] });
  await ok(s, "add_feature", { type: "extrude", sketch: "Plate outline", depth: 3 });
  const onTop = await ok(s, "add_sketch", {
    name: "Hole positions",
    on_face: "top",
    shapes: [
      { type: "point", at: [5, 5] },
      { type: "point", at: [55, 5] },
      { type: "point", at: [5, 35] },
      { type: "point", at: [55, 35] },
    ],
  });
  await ok(s, "add_feature", { type: "hole", sketch: "Hole positions", size: "M4", fit: "clearance" });
  await ok(s, "add_feature", { type: "fillet", edges: ["along z"], radius: 4, name: "Round corners" });
  return onTop;
}

describe("JuraCAD tools for Claude", () => {
  it("lists every tool with a description and an input schema", () => {
    const names = TOOLS.map((t) => t.name);
    for (const n of ["new_design", "add_sketch", "add_feature", "edit_feature", "delete_feature", "undo", "describe_design", "list_faces", "list_edges", "get_views", "save_design", "open_design", "format_guide"]) expect(names).toContain(n);
    for (const t of TOOLS) {
      expect(t.description.length).toBeGreaterThan(30);
      expect(t.inputSchema.type).toBe("object");
      expect(/^[a-z_]+$/.test(t.name)).toBe(true);
    }
    // Default file names from a design's name work on every computer.
    expect(fileNameFor('Bracket: v2 "final".')).toBe("Bracket- v2 -final-");
    expect(fileNameFor("CON")).toBe("design");
    expect(fileNameFor("...")).toBe("design");
  });

  it("builds the example bracket, checks it and saves a file the app opens to the same part", async () => {
    const { s, folder } = newSession();
    const onTop = await buildBracket(s);
    // The sketch on the plate's top face: its axes and origin are explained.
    expect(onTop).toMatch(/sketch x runs along world \+X, sketch y along world \+Y, the sketch origin \(0, 0\) is at world \(0, 0, 3\)/);
    expect(onTop).toMatch(/fully defined/);

    const [vol] = exactVolume(s);
    expect(vol).toBeCloseTo(BRACKET, 2);

    const described = await ok(s, "describe_design");
    expect(described).toMatch(/Plate outline/);
    expect(described).toMatch(/M4 clearance hole/);
    expect(described).toMatch(/valid closed solid/);
    expect(described).toMatch(/size 60 × 40 × 3 mm/);
    expect(described).toMatch(/No problems/);

    const saved = await ok(s, "save_design", {});
    const path = join(folder, "Mounting bracket.juracad");
    expect(saved).toContain(path);
    const fileText = readFileSync(path, "utf8");
    // The file is an ordinary JuraCAD design: it parses and rebuilds to the same part.
    const read = readDocumentFile(fileText, "Mounting bracket.juracad");
    expect(read.ok).toBe(true);
    const doc = parseDocument(JSON.parse(fileText))!;
    expect(doc.features.map((f) => f.type)).toEqual(["sketch", "extrude", "sketch", "hole", "fillet"]);
    const values = doc.features[0].sketch!.data.constraints.filter((c) => c.value !== undefined).map((c) => c.value);
    expect(values).toContain("60");
    expect(values).toContain("40");
    const engine = new GeometryEngine();
    try {
      const r = engine.rebuild(doc.features);
      expect(r.featureErrors).toEqual({});
      expect(engine.check("normal").parts[0].exactVolume!).toBeCloseTo(BRACKET, 2);
    } finally {
      engine.dispose();
    }

    // Editing a size later works, like in the app: a 5 mm plate.
    const edited = await ok(s, "edit_feature", { feature: "Extrude 1", depth: 5 });
    // The hole sketch stays where the top face was (as in the app), and Claude is told so…
    expect(edited).toMatch(/Hole positions is drawn where a face was/);
    // …and re-placing it on the new top face drills right through again.
    await ok(s, "edit_feature", { feature: "Hole positions", on_face: "top" });
    expect(exactVolume(s)[0]).toBeCloseTo((BRACKET * 5) / 3, 2);
    await ok(s, "undo");
    await ok(s, "undo");
    expect(exactVolume(s)[0]).toBeCloseTo(BRACKET, 2);
  });

  it("opens a saved design again", async () => {
    const { s } = newSession();
    await buildBracket(s);
    await ok(s, "save_design", { filename: "bracket" });
    await ok(s, "new_design", { name: "Other" });
    expect(s.doc.features).toHaveLength(0);
    const opened = await ok(s, "open_design", { filename: "bracket" });
    expect(opened).toMatch(/Opened bracket\.juracad: "Mounting bracket", 5 features/);
    expect(exactVolume(s)[0]).toBeCloseTo(BRACKET, 2);
    expect(await ok(s, "list_designs")).toMatch(/bracket\.juracad/);
  });

  it("lists faces and edges, and draws a picture", async () => {
    const { s } = newSession();
    await buildBracket(s);
    const faces = await ok(s, "list_faces");
    expect(faces).toMatch(/flat face, facing \+Z \(top\), centre \(30, 20, 3\)/);
    const round = await ok(s, "list_edges", { along: "round" });
    // 4 holes × 2 rims, and 4 fillets × 2 arcs.
    expect(round).toMatch(/16 round/);
    const r = await callTool(s, "get_views", { views: ["iso", "top"], size: 200 });
    expect(r.isError).toBeFalsy();
    const img = r.content.find((c) => c.type === "image");
    expect(img && img.type === "image" && img.mimeType).toBe("image/png");
    const bytes = Buffer.from(img!.type === "image" ? img!.data : "", "base64");
    expect([...bytes.subarray(1, 4)].map((b) => String.fromCharCode(b)).join("")).toBe("PNG");
    expect(bytes.readUInt32BE(16)).toBe(400); // two 200 px views side by side
  });

  it("revolves, patterns, mirrors and shells with exact volumes", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Shapes" });
    // A 20 × 10 rectangle 10 mm out from the Front plane's vertical axis, spun round it: a ring.
    await ok(s, "add_sketch", { plane: "Front", shapes: [{ type: "rectangle", corner: [10, 0], width: 20, height: 10 }] });
    await ok(s, "add_feature", { type: "revolve", axis: "vertical" });
    expect(exactVolume(s)[0]).toBeCloseTo(Math.PI * (30 * 30 - 10 * 10) * 10, 1);

    await ok(s, "new_design", { name: "Pattern" });
    await ok(s, "add_feature", { type: "box", width: 100, depth: 20, height: 5 });
    await ok(s, "add_sketch", { on_face: "top", shapes: [{ type: "circle", center: [10, 10], diameter: 6 }] });
    await ok(s, "add_feature", { type: "extrude", end: "through_all", operation: "remove", name: "Cut" });
    await ok(s, "add_feature", { type: "linear_pattern", features: ["Cut"], direction: "x", count: 4, spacing: 20 });
    expect(exactVolume(s)[0]).toBeCloseTo(100 * 20 * 5 - 4 * Math.PI * 9 * 5, 2);
    await ok(s, "add_feature", { type: "mirror", features: ["Cut"], plane: "Right", offset: 50 });
    expect(exactVolume(s)[0]).toBeCloseTo(100 * 20 * 5 - 5 * Math.PI * 9 * 5, 2);

    await ok(s, "new_design", { name: "Cup" });
    await ok(s, "add_feature", { type: "box", width: 40, depth: 30, height: 20 });
    await ok(s, "add_feature", { type: "shell", faces: ["top"], thickness: 2 });
    expect(exactVolume(s)[0]).toBeCloseTo(40 * 30 * 20 - 36 * 26 * 18, 1);
    await ok(s, "add_feature", { type: "chamfer", edges: [{ near: [20, 0, 0] }], distance: 1 });
    expect(exactVolume(s)[0]).toBeCloseTo(40 * 30 * 20 - 36 * 26 * 18 - 0.5 * 40, 1);
  });

  describe("planes and axes picked in the app (Live with Claude)", () => {
    /** A 100 × 20 × 5 plate with a 6 mm hole at (10, 10) named "Cut". */
    async function plate(s: Session) {
      await ok(s, "new_design", { name: "Picked" });
      await ok(s, "add_feature", { type: "box", width: 100, depth: 20, height: 5 });
      await ok(s, "add_sketch", { on_face: "top", shapes: [{ type: "circle", center: [10, 10], diameter: 6 }] });
      await ok(s, "add_feature", { type: "extrude", end: "through_all", operation: "remove", name: "Cut" });
    }
    const HOLE = Math.PI * 9 * 5;
    /** Change one feature as the app would (as if the user clicked something), as a new design version. */
    const appEdit = (s: Session, name: string, change: (f: Feature) => Feature, before?: Feature) => {
      const list = s.doc.features.map((f) => (f.name === name ? change(f) : f));
      if (before) list.splice(list.findIndex((f) => f.name === name), 0, before);
      s.commit({ ...s.doc, features: list });
    };

    it("mirror: a plane given by Claude replaces a sketch line picked in the app", async () => {
      const { s } = newSession();
      await plate(s);
      await ok(s, "add_feature", { type: "mirror", features: ["Cut"], plane: "Right", offset: 50, name: "Flip" });
      // In the app: mirror across a construction line at x = 30 on the Top plane instead (the hole goes to x = 50).
      const drawn = addLine(emptySketch(), { x: 30, y: 0 }, { x: 30, y: 20 }, { construction: true });
      const sk: Feature = { id: "app-sketch", name: "Mirror line", type: "sketch", operation: "new", suppressed: false, params: {}, sketch: { plane: { kind: "default", name: "Top" }, data: drawn.sketch } };
      appEdit(s, "Flip", (f) => ({ ...f, mirror: { ...f.mirror!, line: { sketch: sk.id, line: drawn.lineId } } }), sk);
      expect(exactVolume(s)[0]).toBeCloseTo(10000 - 2 * HOLE, 2);
      expect(await ok(s, "describe_design")).toMatch(/across the plane through construction line 1 in Mirror line \(picked in the app; setting "plane" replaces it\)/);
      // Claude asks for the Right plane moved 70 along: the line is dropped, and the hole really goes to x = 130… off the plate.
      const said = await ok(s, "edit_feature", { feature: "Flip", plane: "Right", offset: 70 });
      expect(said).toMatch(/Changed Flip/);
      expect(said).not.toMatch(/picked in the app/);
      const flip = s.doc.features.find((f) => f.name === "Flip")!;
      expect(flip.mirror?.line).toBeUndefined();
      expect(exactVolume(s)[0]).toBeCloseTo(10000 - HOLE, 2);
      // And a clicked face is replaced the same way.
      appEdit(s, "Flip", (f) => ({ ...f, mirror: { ...f.mirror!, planePick: { partId: s.doc.features[0].id, ref: { kind: "face", surface: "PLANE", center: [100, 10, 2.5], normal: [1, 0, 0] } } } }));
      expect(await ok(s, "describe_design")).toMatch(/flat face of Box 1 \(picked in the app/);
      await ok(s, "edit_feature", { feature: "Flip", plane: "Front" });
      expect(s.doc.features.find((f) => f.name === "Flip")!.mirror).toEqual({ sources: flip.mirror!.sources, plane: { kind: "default", name: "Front" } });
    });

    it("circular pattern: an axis given by Claude replaces 'nothing chosen yet' or a clicked face", async () => {
      const { s } = newSession();
      await plate(s);
      await ok(s, "add_feature", { type: "circular_pattern", features: ["Cut"], axis: "z", count: 2, center: [30, 10, 0], name: "Ring" });
      expect(exactVolume(s)[0]).toBeCloseTo(10000 - 2 * HOLE, 2);
      // Accepted in the app with nothing chosen: it can't build.
      appEdit(s, "Ring", (f) => ({ ...f, pattern: { ...f.pattern!, unset: true } }));
      expect(s.build().errors[s.doc.features.find((f) => f.name === "Ring")!.id]).toMatch(/Choose the axis/);
      expect(await ok(s, "describe_design")).toMatch(/round nothing yet \(no axis chosen — set "axis"\)/);
      const said = await ok(s, "edit_feature", { feature: "Ring", axis: "z" });
      expect(said).not.toMatch(/already has those settings/);
      expect(s.build().errors).toEqual({});
      expect(exactVolume(s)[0]).toBeCloseTo(10000 - 2 * HOLE, 2);
      // A round face clicked in the app (the hole itself), then Z again from Claude.
      appEdit(s, "Ring", (f) => ({ ...f, pattern: { ...f.pattern!, along: { partId: s.doc.features[0].id, ref: { kind: "face", surface: "CYLINDRE", center: [10, 10, 2.5], normal: [0, 0, 1] } } } }));
      expect(await ok(s, "describe_design")).toMatch(/round round face of Box 1 \(picked in the app/);
      await ok(s, "edit_feature", { feature: "Ring", axis: "z" });
      expect(s.doc.features.find((f) => f.name === "Ring")!.pattern?.along).toBeUndefined();
    });

    it("linear pattern: directions given by Claude replace edges or sketch lines picked in the app", async () => {
      const { s } = newSession();
      await plate(s);
      await ok(s, "add_feature", { type: "linear_pattern", features: ["Cut"], direction: "x", count: 2, spacing: 20, name: "Row" });
      const edge = { partId: s.doc.features[0].id, ref: { kind: "edge" as const, curve: "LINE", a: [0, 0, 5] as [number, number, number], b: [0, 20, 5] as [number, number, number], mid: [0, 10, 5] as [number, number, number] } };
      appEdit(s, "Row", (f) => ({ ...f, pattern: { ...f.pattern!, along: edge, line2: { sketch: "x", line: "y" } } }));
      expect(await ok(s, "describe_design")).toMatch(/along straight edge of Box 1 \(picked in the app; setting "direction" replaces it\)/);
      await ok(s, "edit_feature", { feature: "Row", direction: "x", direction2: "y" });
      const p = s.doc.features.find((f) => f.name === "Row")!.pattern!;
      expect(p.along).toBeUndefined();
      expect(p.line2).toBeUndefined();
      expect(p.axis).toBe("x");
      expect(exactVolume(s)[0]).toBeCloseTo(10000 - 2 * HOLE, 2);
    });
  });

  it("explains mistakes in plain English and leaves the design unchanged", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Mistakes" });
    expect(await fails(s, "add_feature", { type: "extrude", depth: 5 })).toMatch(/no sketch to use yet.*add_sketch/);
    expect(await fails(s, "add_feature", { type: "fillet", edges: ["all"], radius: 1 })).toMatch(/no parts yet/);
    expect(await fails(s, "add_feature", { type: "drill" })).toMatch(/type must be one of "extrude"/);
    await ok(s, "add_sketch", { shapes: [{ type: "rectangle", corner: [0, 0], width: 20, height: 20 }] });
    expect(await fails(s, "add_feature", { type: "extrude" })).toMatch(/"depth" is missing/);
    expect(await fails(s, "add_feature", { type: "extrude", depth: 5, dpeth: 3 })).toMatch(/"dpeth" isn't a setting here/);
    await ok(s, "add_feature", { type: "extrude", depth: 5 });
    const before = JSON.stringify(s.doc);
    // A fillet far too big for a 5 mm plate fails to build: nothing is added.
    expect(await fails(s, "add_feature", { type: "fillet", edges: ["top"], radius: 30 })).toMatch(/Couldn't add the fillet[\s\S]*Nothing was changed/);
    expect(await fails(s, "add_feature", { type: "fillet", edges: ["E99"], radius: 1 })).toMatch(/edges E1 to E12/);
    expect(await fails(s, "add_feature", { type: "hole", size: "M7" })).toMatch(/size must be one of/);
    expect(await fails(s, "delete_feature", { feature: "Sketch 1" })).toMatch(/used by Extrude 1/);
    expect(await fails(s, "edit_feature", { feature: "Extrude 9" })).toMatch(/no feature "Extrude 9".*Sketch 1/);
    expect(JSON.stringify(s.doc)).toBe(before);
    expect(await fails(s, "unknown_tool")).toMatch(/no tool called/);
  });

  it("refuses cuts and holes that miss the part, and says how to fix them", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Misses" });
    await ok(s, "add_sketch", { shapes: [{ type: "rectangle", corner: [0, 0], width: 60, height: 40 }] });
    const made = await ok(s, "add_feature", { type: "extrude", depth: 3 });
    expect(made).toMatch(/Volume change: Part 1: new, 7200 mm³/);
    await ok(s, "add_sketch", { name: "Pocket", on_face: "top", shapes: [{ type: "circle", center: [30, 20], diameter: 10 }] });
    // Going up, away from the plate, the cut misses it.
    const missed = await fails(s, "add_feature", { type: "extrude", sketch: "Pocket", depth: 2, operation: "remove", flip: false });
    expect(missed).toMatch(/would cut nothing from the part — it misses it[\s\S]*towards \+Z[\s\S]*"flip": true[\s\S]*Nothing was changed/);
    // Left to itself, a cut on a face goes into the part.
    const cut = await ok(s, "add_feature", { type: "extrude", sketch: "Pocket", depth: 2, operation: "remove" });
    expect(cut).toMatch(/flipped/);
    expect(cut).toMatch(/Volume change: Part 1: 7200 → 7042\.92 mm³ \(−157\.08\)/);
    expect(exactVolume(s)[0]).toBeCloseTo(7200 - Math.PI * 25 * 2, 3);
    // Hole points on the Top plane (the plate's bottom) drill downwards, away from it.
    await ok(s, "add_sketch", { name: "Wrong face", plane: "Top", shapes: [{ type: "point", at: [10, 10] }] });
    expect(await fails(s, "add_feature", { type: "hole", sketch: "Wrong face", size: "M4" })).toMatch(/holes miss the part[\s\S]*on_face/);
    expect(exactVolume(s)[0]).toBeCloseTo(7200 - Math.PI * 25 * 2, 3);
    // Through all goes both ways: from a plane in the middle of a block, right through it.
    await ok(s, "new_design", { name: "Through" });
    await ok(s, "add_feature", { type: "box", width: 20, depth: 20, height: 20 });
    await ok(s, "add_sketch", { plane: "Top", offset: 10, shapes: [{ type: "circle", center: [10, 10], diameter: 4 }] });
    await ok(s, "add_feature", { type: "extrude", end: "through_all", operation: "remove" });
    expect(exactVolume(s)[0]).toBeCloseTo(8000 - Math.PI * 4 * 20, 3);
  });

  it("keeps a thin trim, with a note, and keeps variables within the limits", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Trim" });
    await ok(s, "add_sketch", { shapes: [{ type: "rectangle", corner: [0, 0], width: 60, height: 40 }] });
    await ok(s, "add_feature", { type: "extrude", depth: 3 });
    // A 20 × 60 block from 10 mm up, coming down 50 mm, trims 0.5 mm off the plate's end.
    await ok(s, "add_sketch", { name: "Trim", plane: "Top", offset: 10, shapes: [{ type: "rectangle", corner: [59.5, -10], width: 20, height: 60 }] });
    const trimmed = await ok(s, "add_feature", { type: "extrude", sketch: "Trim", depth: 50, flip: true, operation: "remove" });
    expect(trimmed).toMatch(/Note: This cut removed only 60 mm³ \(0\.1% of the cutting shape\), going towards −Z; if you meant to cut more/);
    expect(exactVolume(s)[0]).toBeCloseTo(59.5 * 40 * 3, 3);

    // A pattern count, or a size, set by a variable can't go past the limits either.
    await ok(s, "set_variables", { variables: [{ name: "n", value: 5 }] });
    await ok(s, "add_feature", { type: "cylinder", diameter: 1, height: 3, x: 2, y: 2, operation: "remove", name: "Pin hole" });
    await ok(s, "add_feature", { type: "linear_pattern", features: ["Pin hole"], direction: "x", count: "n", spacing: 2 });
    expect(await fails(s, "set_variables", { variables: [{ name: "n", value: 5000 }] })).toMatch(/Linear pattern 1: a pattern can have at most 100 copies in each direction \(this would be 5000\)[\s\S]*Nothing was changed/);
    expect(await fails(s, "set_variables", { variables: [{ name: "big", value: 1e9 }] })).toMatch(/big would be 1000000000 — too big/);
    await ok(s, "set_variables", { variables: [{ name: "w", value: 60 }] });
    await ok(s, "edit_feature", { feature: "Extrude 1", depth: "w / 20" });
    expect(await fails(s, "set_variables", { variables: [{ name: "w", value: "9000 * 3" }] })).toMatch(/too big/);
    expect(await fails(s, "edit_feature", { feature: "Extrude 1", depth: "w * 200" })).toMatch(/depth is 12000 mm — too big/);
    expect(s.doc.variables!.map((v) => `${v.name}=${v.value}`)).toEqual(["n=5", "w=60"]);
  });

  it("keeps requests to a size that builds quickly", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Limits" });
    expect(await fails(s, "add_sketch", { shapes: [{ type: "rectangle", corner: [0, 0], width: 20000, height: 10 }] })).toMatch(/width is 20000 mm — too big.*10000 mm/);
    const ring = Array.from({ length: 101 }, (_, i) => [Math.cos(i / 16), Math.sin(i / 16)]);
    expect(await fails(s, "add_sketch", { shapes: [{ type: "outline", points: ring }] })).toMatch(/at most 100 points/);
    expect(await fails(s, "add_sketch", { shapes: Array.from({ length: 101 }, (_, i) => ({ type: "point", at: [i, 0] })) })).toMatch(/at most 100 shapes/);
    await ok(s, "add_feature", { type: "box", width: 100, depth: 100, height: 2 });
    await ok(s, "add_feature", { type: "cylinder", diameter: 1, height: 2, x: 1, y: 1, operation: "remove", name: "Pin hole" });
    expect(await fails(s, "add_feature", { type: "linear_pattern", features: ["Pin hole"], direction: "x", count: 101, spacing: 0.5 })).toMatch(/at most 100 copies in each direction/);
    expect(await fails(s, "add_feature", { type: "linear_pattern", features: ["Pin hole"], direction: "x", count: 30, spacing: 2, direction2: "y", count2: 20, spacing2: 2 })).toMatch(/at most 400 copies in all \(asked for 30 × 20 = 600\)/);
    expect(await fails(s, "add_feature", { type: "circular_pattern", features: ["Pin hole"], count: 500, center: [50, 50, 0] })).toMatch(/at most 100 copies/);
  });

  it("only reads and writes inside its own folder", async () => {
    const { s, dir, folder } = newSession();
    await ok(s, "new_design", { name: "Safe" });
    await ok(s, "add_feature", { type: "box", width: 10, depth: 10, height: 10 });
    expect(await fails(s, "save_design", { filename: "../escape" })).toMatch(/isn't a plain file name/);
    expect(await fails(s, "save_design", { filename: "/tmp/escape" })).toMatch(/isn't a plain file name/);
    expect(await fails(s, "save_design", { filename: "C:evil" })).toMatch(/isn't a plain file name/);
    expect(await fails(s, "save_design", { filename: ".hidden" })).toMatch(/hidden file/);
    expect(await fails(s, "open_design", { filename: "..\\x" })).toMatch(/isn't a plain file name/);
    expect(await fails(s, "open_design", { filename: "nothing-here" })).toMatch(/no file called "nothing-here.juracad"/);
    // A link inside the folder pointing outside it is refused.
    writeFileSync(join(dir, "outside.juracad"), "{}");
    symlinkSync(join(dir, "outside.juracad"), join(folder, "link.juracad"));
    expect(await fails(s, "open_design", { filename: "link" })).toMatch(/shortcut/);
    // Names that don't work on Windows (or would write somewhere else there).
    for (const [name, why] of [
      ["bracket:v2", /can't contain \(:\)/],
      ["what?", /can't contain \(\?\)/],
      ['say "hi"', /can't contain \("\)/],
      ["tab\there", /control character/],
      ["bracket.", /ends with a dot or a space/],
      ["CON", /Windows keeps for itself/],
      ["com1.juracad", /Windows keeps for itself/],
      ["Lpt9.txt", /Windows keeps for itself|should end in/],
    ] as const) expect(await fails(s, "save_design", { filename: name })).toMatch(why);
    // A link planted where the save goes first is never followed.
    writeFileSync(join(dir, "victim.txt"), "keep me");
    symlinkSync(join(dir, "victim.txt"), join(folder, ".a.juracad.saving"));
    await ok(s, "save_design", { filename: "a" });
    expect(readFileSync(join(dir, "victim.txt"), "utf8")).toBe("keep me");
    expect(readdirSync(folder).filter((n) => n.endsWith(".saving"))).toEqual([".a.juracad.saving"]);
    // A folder isn't a design.
    mkdirSync(join(folder, "parts.juracad"));
    expect(await fails(s, "open_design", { filename: "parts.juracad" })).toMatch(/is a folder/);
    expect(await ok(s, "list_designs")).not.toMatch(/parts\.juracad/);
    // Saving twice to a name it didn't come from asks first.
    await ok(s, "save_design", { filename: "a" });
    await ok(s, "new_design", { name: "Other" });
    await ok(s, "add_feature", { type: "box", width: 5, depth: 5, height: 5 });
    expect(await fails(s, "save_design", { filename: "a" })).toMatch(/already a file called "a.juracad"/);
    await ok(s, "save_design", { filename: "a", overwrite: true });
    const exported = await ok(s, "export_model", { format: "stl", filename: "cube" });
    expect(exported).toMatch(/cube\.stl/);
    expect(readFileSync(join(folder, "cube.stl")).length).toBe(84 + 50 * 12);
  });

  it("uses variables in sizes, and they stay editable", async () => {
    const { s } = newSession();
    await ok(s, "new_design", { name: "Vars" });
    await ok(s, "set_variables", { variables: [{ name: "t", value: 4 }, { name: "w", value: "t * 10" }] });
    await ok(s, "add_sketch", { shapes: [{ type: "rectangle", center: [0, 0], width: "w", height: 20 }] });
    await ok(s, "add_feature", { type: "extrude", depth: "t" });
    expect(exactVolume(s)[0]).toBeCloseTo(40 * 20 * 4, 3);
    await ok(s, "set_variables", { variables: [{ name: "t", value: 2 }] });
    expect(exactVolume(s)[0]).toBeCloseTo(20 * 20 * 2, 3);
    expect(await fails(s, "set_variables", { variables: [{ name: "2bad", value: 1 }] })).toMatch(/Use letters/);
  });
});
