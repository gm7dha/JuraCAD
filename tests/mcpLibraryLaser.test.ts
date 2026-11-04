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
});
