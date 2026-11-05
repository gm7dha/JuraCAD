/** Laser library designs through Claude's tools: words as inputs, and Export for laser of a stencil and a stamp (real OCCT). */
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DesignFolder } from "../src/mcp/files";
import { Session } from "../src/mcp/session";
import { callTool, type ToolResult } from "../src/mcp/tools";

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
  const dir = mkdtempSync(join(tmpdir(), "juracad-liblaser-"));
  dirs.push(dir);
  const s = new Session(new DesignFolder(join(dir, "JuraCAD")));
  sessions.push(s);
  return { s, folder: join(dir, "JuraCAD") };
}
const textOf = (r: ToolResult) => r.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
async function call(s: Session, name: string, args: unknown = {}) {
  const r = await callTool(s, name, args);
  return { text: textOf(r), error: !!r.isError };
}

describe("laser library designs for Claude", () => {
  it("list words inputs plainly", async () => {
    const { s } = newSession();
    const r = await call(s, "list_library_designs", { category: "laser" });
    expect(r.text).toContain("stencil —");
    expect(r.text).toContain("rubber-stamp —");
    expect(r.text).toMatch(/words: Words \(words, several lines split by "\\n", up to 40 letters, default "HELLO"\)/);
  });

  it("insert a stencil with words, and export it for laser: a red outline and blue letter holes", async () => {
    const { s, folder } = newSession();
    const r = await call(s, "insert_library_design", { design: "stencil", sizes: { words: "HELLO", height: 25 } });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/1 letter middle held by 1 bridge/);
    const letters = s.doc.features.find((f) => f.name === "Letters sketch")!;
    expect(letters.sketch!.data.texts!.map((t) => t.value)).toEqual(["HELLO"]);
    const out = await call(s, "export_for_laser", { parts: ["Stencil"], filename: "hello" });
    expect(out.error).toBe(false);
    const svg = readFileSync(join(folder, "hello.svg"), "utf8");
    expect(svg).toContain("#FF0000");
    expect(svg).toContain("#0000FF");
    expect(out.text).toMatch(/1 outer cut/);
    expect(out.text).toMatch(/5 inner cuts/);
  });

  it("refuse words the design can't take, changing nothing", async () => {
    const { s } = newSession();
    const bad = await call(s, "insert_library_design", { design: "name-tag", sizes: { words: "A NAME FAR TOO LONG FOR A TAG" } });
    expect(bad.error).toBe(true);
    expect(bad.text).toMatch(/don't fit on the tag/);
    expect((await call(s, "insert_library_design", { design: "stencil", sizes: { words: "" } })).text).toMatch(/type some words/);
    expect(s.doc.features).toHaveLength(0);
  });

  it("export a rubber stamp's sketch with its background engraved, by itself", async () => {
    const { s, folder } = newSession();
    expect((await call(s, "insert_library_design", { design: "rubber-stamp", sizes: { words: "JO\nSMITH" } })).error).toBe(false);
    const out = await call(s, "export_for_laser", { sketch: "Stamp sketch", filename: "stamp" });
    expect(out.error).toBe(false);
    expect(out.text).toMatch(/engraved area/);
    expect(out.text).toMatch(/1 outer cut/);
    const svg = readFileSync(join(folder, "stamp.svg"), "utf8");
    expect(svg).toMatch(/fill-rule="evenodd"/);
    // Asked not to, it's the plain sketch again: everything cut, nothing engraved but the words.
    const plain = await call(s, "export_for_laser", { sketch: "Stamp sketch", background: false, filename: "plain" });
    expect(plain.text).toMatch(/inner cut/);
  });

  it("insert a jigsaw puzzle with its own pattern number, and export its cuts: blue between the pieces, a red border", async () => {
    const { s, folder } = newSession();
    const r = await call(s, "insert_library_design", { design: "jigsaw", sizes: { width: 120, height: 90, rows: 3, columns: 4, seed: 12 } });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/12 pieces/);
    const out = await call(s, "export_for_laser", { sketch: "Puzzle sketch", filename: "puzzle" });
    expect(out.error).toBe(false);
    expect(out.text).toMatch(/1 outer cut/);
    const svg = readFileSync(join(folder, "puzzle.svg"), "utf8");
    expect(svg).toContain('width="120mm" height="90mm"');
    expect(svg).toContain("#0000FF");
    expect(svg).toContain("#FF0000");
    // The same number again gives the very same cuts.
    const again = newSession();
    await call(again.s, "insert_library_design", { design: "jigsaw", sizes: { width: 120, height: 90, rows: 3, columns: 4, seed: 12 } });
    await call(again.s, "export_for_laser", { sketch: "Puzzle sketch", filename: "puzzle" });
    expect(readFileSync(join(again.folder, "puzzle.svg"), "utf8")).toBe(svg);
  });

  it("insert a name puzzle, and export the board (a hole per letter) and a letter for laser", async () => {
    const { s, folder } = newSession();
    const r = await call(s, "insert_library_design", { design: "name-puzzle", sizes: { words: "SAM", height: 40, backing: false } });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/3 letter pieces/);
    const board = await call(s, "export_for_laser", { parts: ["Name puzzle board"], filename: "board" });
    expect(board.error).toBe(false);
    expect(board.text).toMatch(/1 outer cut/);
    expect(board.text).toMatch(/3 inner cuts/);
    const letter = await call(s, "export_for_laser", { parts: ["Name puzzle letter A"], filename: "a" });
    expect(letter.error).toBe(false);
    expect(letter.text).toMatch(/1 outer cut/);
    expect(letter.text).toMatch(/1 inner cut/);
    expect(readFileSync(join(folder, "board.svg"), "utf8")).toContain("#FF0000");
  });

  it("insert a bird box for house sparrows, and export its front (the 32 mm hole) and floor (drainage holes) for laser", async () => {
    const { s, folder } = newSession();
    const r = await call(s, "insert_library_design", { design: "bird-box", sizes: { bird: "house-sparrow" } });
    expect(r.error).toBe(false);
    expect(r.text).toMatch(/32 mm hole/);
    expect(s.build().parts).toHaveLength(7);
    const front = await call(s, "export_for_laser", { parts: ["Bird box front"], filename: "front" });
    expect(front.error).toBe(false);
    expect(front.text).toMatch(/1 outer cut/);
    expect(front.text).toMatch(/1 inner cut/);
    const floor = await call(s, "export_for_laser", { parts: ["Bird box floor"], filename: "floor" });
    expect(floor.text).toMatch(/4 inner cuts/);
    const svg = readFileSync(join(folder, "front.svg"), "utf8");
    expect(svg).toContain("#FF0000");
    expect(svg).toContain("#0000FF");
  });
});
