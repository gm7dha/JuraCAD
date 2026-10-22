/**
 * JuraCAD for Claude: an MCP server (run by the Claude desktop app from the
 * JuraCAD extension) that lets Claude build parts with JuraCAD's own geometry
 * engine and save them as .juracad files.
 *
 * Started as: node server/index.mjs <folder for designs>
 * Talks MCP over stdin/stdout, so nothing else may be printed to stdout:
 * all logging goes to stderr.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import opencascade from "replicad-opencascadejs";
import { setOC } from "replicad";
import { DesignFolder } from "./files";
import { Session } from "./session";
import { callTool, FORMAT_GUIDE, TOOLS } from "./tools";

/** Set when the extension is bundled (scripts/build-mcpb.mjs). */
declare const __JURACAD_VERSION__: string | undefined;
const VERSION = typeof __JURACAD_VERSION__ === "string" ? __JURACAD_VERSION__ : "0.0.0";

// stdout carries the conversation with Claude: anything else printed there would break it.
const log = (...args: unknown[]) => process.stderr.write(`[juracad] ${args.map(String).join(" ")}\n`);
console.log = log;
console.info = log;
console.warn = log;

/** The folder chosen when the extension was installed (or Documents/JuraCAD). */
function folderPath(): string {
  const given = process.argv[2] || process.env.JURACAD_FOLDER;
  // An unfilled setting arrives as the literal placeholder: fall back to the default.
  if (given && !given.includes("${")) return given;
  return join(homedir(), "Documents", "JuraCAD");
}

/** Load OpenCascade (the geometry engine) from the .wasm file shipped beside this script. */
async function loadEngine(): Promise<void> {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const wasmBinary = readFileSync(join(here, "replicad_single.wasm"));
  const OC = await opencascade({ wasmBinary, print: log, printErr: log });
  setOC(OC);
}

async function main() {
  const folder = new DesignFolder(folderPath());
  log(`JuraCAD ${VERSION}: designs folder ${folder.root}`);
  // Start loading the engine now; tools wait for it (it takes a few seconds).
  const engineReady = loadEngine();
  engineReady.catch((e) => log("The geometry engine failed to load:", e));
  let session: Session | null = null;

  const server = new Server(
    { name: "juracad", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: `JuraCAD builds 3D parts for the user, step by step, with a real CAD engine; the result is a .juracad file they open at https://gm7dha.github.io/JuraCAD/ where everything stays editable.\n${FORMAT_GUIDE}`,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      annotations: { title: t.title, readOnlyHint: !!t.readOnly, destructiveHint: !!t.destructive, openWorldHint: false },
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      await engineReady;
    } catch (e) {
      return { content: [{ type: "text" as const, text: `JuraCAD's geometry engine couldn't start (${e instanceof Error ? e.message : String(e)}). Try restarting Claude; if it keeps happening, reinstall the JuraCAD extension.` }], isError: true };
    }
    session ??= new Session(folder);
    const result = await callTool(session, request.params.name, request.params.arguments ?? {});
    return { content: result.content, ...(result.isError ? { isError: true } : {}) };
  });

  await server.connect(new StdioServerTransport());
  log("ready");
}

main().catch((e) => {
  log("Failed to start:", e instanceof Error ? e.stack ?? e.message : e);
  process.exit(1);
});
