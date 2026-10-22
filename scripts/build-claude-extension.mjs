/**
 * Builds the JuraCAD extension for the Claude desktop app (an .mcpb bundle,
 * see claude-extension/manifest.json) into build/claude-extension:
 *   server/index.mjs        the MCP server (src/mcp/server.ts) and everything it uses, in one file
 *   server/replicad_single.wasm   the OpenCascade geometry engine
 *   manifest.json, icon.png, licences
 * CI then packs that folder into dist/juracad-claude.mcpb with the official
 * packer (`mcpb pack`), so it's downloadable from the live site.
 *
 * Needs esbuild and @modelcontextprotocol/sdk (devDependencies), so it runs in CI.
 */
import { build } from "esbuild";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const out = join(root, "build", "claude-extension");
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const require = createRequire(join(root, "package.json"));

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, "server"), { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node18",
  // Licence notices of the bundled packages, kept in server/index.mjs.LEGAL.txt.
  legalComments: "external",
  logLevel: "warning",
  define: { __JURACAD_VERSION__: JSON.stringify(version) },
  // Some bundled packages use require(); give the ES module one.
  banner: { js: "import { createRequire as __juracadRequire } from 'node:module'; const require = __juracadRequire(import.meta.url);" },
};

const bundled = await build({ ...common, metafile: true, entryPoints: [join(root, "src/mcp/server.ts")], outfile: join(out, "server", "index.mjs") });

// Licences of every package bundled into the server, in one file.
const packages = new Map();
for (const input of Object.keys(bundled.metafile.inputs)) {
  const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (!m || packages.has(m[1])) continue;
  try {
    const info = JSON.parse(readFileSync(join(root, m[1], "package.json"), "utf8"));
    const licenceFile = ["LICENSE", "LICENSE.md", "LICENSE.txt", "license", "LICENCE"].map((f) => join(root, m[1], f)).find((f) => existsSync(f));
    packages.set(m[1], { name: info.name, version: info.version, license: info.license, text: licenceFile ? readFileSync(licenceFile, "utf8").trim() : "" });
  } catch {
    // not a package folder
  }
}
const notices = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(
  join(out, "THIRD-PARTY-NOTICES.txt"),
  `JuraCAD for Claude includes these open-source packages:\n\n${notices.map((p) => `== ${p.name} ${p.version} (${p.license ?? "see below"})\n${p.text}`).join("\n\n")}\n\nOpenCascade (replicad_single.wasm) is under the LGPL 2.1: see LICENSE-OpenCascade.txt.\n`,
);

// The geometry engine itself.
const ocDir = dirname(require.resolve("replicad-opencascadejs/package.json"));
copyFileSync(join(ocDir, "dist", "replicad_single.wasm"), join(out, "server", "replicad_single.wasm"));
copyFileSync(join(ocDir, "LICENSE"), join(out, "LICENSE-OpenCascade.txt"));
copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));
copyFileSync(join(root, "public", "icon-512.png"), join(out, "icon.png"));
writeFileSync(join(out, "package.json"), JSON.stringify({ name: "juracad-claude", version, private: true, type: "module", license: "MIT" }, null, 2) + "\n");

// The manifest lists the tools (their names and what they do), straight from the server's own list.
const metaFile = join(root, "build", "tool-list.mjs");
await build({ ...common, entryPoints: [join(root, "src/mcp/tools.ts")], outfile: metaFile });
const { TOOLS } = await import(pathToFileURL(metaFile).href);
rmSync(metaFile);
const manifest = JSON.parse(readFileSync(join(root, "claude-extension", "manifest.json"), "utf8"));
manifest.version = version;
manifest.tools = TOOLS.map((t) => ({ name: t.name, description: t.title }));
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

console.log(`Built the Claude extension ${version} in ${out} (${TOOLS.length} tools; licences of ${notices.length} bundled packages noted).`);
