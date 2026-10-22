/**
 * Checks the Claude extension the way Claude's desktop app would use it:
 *   node scripts/check-claude-extension.mjs dist/juracad-claude.mcpb
 * Unpacks the .mcpb (a zip), checks its manifest, starts its server with Node
 * and talks MCP to it over stdin/stdout: lists the tools, builds the example
 * bracket (plate, four M4 holes, rounded corners), checks the volume, looks at
 * it and saves a .juracad file — then checks that file.
 * Fails (exit code 1, with GitHub annotations in CI) if anything is wrong.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

const inCI = process.env.GITHUB_ACTIONS === "true";
const fail = (msg) => {
  if (inCI) console.log(`::error title=Claude extension check failed::${String(msg).replace(/%/g, "%25").replace(/\r?\n/g, "%0A")}`);
  console.error(`FAILED: ${msg}`);
  process.exit(1);
};
const check = (cond, msg) => cond || fail(msg);

/** Unpack a zip file (stored or deflated entries) into a folder. */
function unzip(file, into) {
  const zip = readFileSync(file);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end--;
  check(end >= 0, `${file} isn't a zip file.`);
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    check(zip.readUInt32LE(at) === 0x02014b50, "The zip's directory is damaged.");
    const method = zip.readUInt16LE(at + 10);
    const size = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    at += 46 + nameLen + extraLen + commentLen;
    check(!name.includes("..") && !name.startsWith("/"), `Unsafe path in the zip: ${name}`);
    names.push(name);
    if (name.endsWith("/")) continue;
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const raw = zip.subarray(start, start + size);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : fail(`Unsupported zip method ${method} for ${name}`);
    mkdirSync(dirname(join(into, name)), { recursive: true });
    writeFileSync(join(into, name), data);
  }
  return names;
}

const target = process.argv[2] ?? "dist/juracad-claude.mcpb";
check(existsSync(target), `${target} doesn't exist — the extension wasn't built.`);
const work = mkdtempSync(join(tmpdir(), "juracad-ext-"));
let dir = target;
if (statSync(target).isFile()) {
  dir = join(work, "unpacked");
  const names = unzip(target, dir);
  console.log(`${target}: ${(statSync(target).size / 1e6).toFixed(1)} MB, ${names.length} entries`);
  check(!names.some((n) => n.startsWith("node_modules/")), "The bundle shouldn't need node_modules.");
}

// The manifest.
const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
check(typeof manifest.manifest_version === "string", "manifest_version is missing.");
check(manifest.name === "juracad", "The manifest's name should be juracad.");
check(manifest.version === pkg.version, `The manifest's version (${manifest.version}) should be the app's (${pkg.version}).`);
check(manifest.author?.name && manifest.description, "The manifest needs an author and a description.");
check(manifest.server?.type === "node" && existsSync(join(dir, manifest.server.entry_point)), "The server's entry point is missing.");
check(existsSync(join(dir, "server", "replicad_single.wasm")), "The geometry engine (replicad_single.wasm) is missing.");
check(existsSync(join(dir, manifest.icon)), "The icon is missing.");
check(manifest.user_config?.design_folder?.type === "directory", "The design folder setting should be a directory.");
check(manifest.server.mcp_config.args.includes("${user_config.design_folder}"), "The server should be given the design folder.");
check(Array.isArray(manifest.tools) && manifest.tools.length >= 10, "The manifest should list the tools.");

// Start the server and talk to it.
const designs = join(work, "My designs");
const child = spawn(process.execPath, [join(dir, manifest.server.entry_point), designs], { stdio: ["pipe", "pipe", "pipe"] });
let stderr = "";
child.stderr.on("data", (d) => (stderr += d));
const waiting = new Map();
let buffer = "";
child.stdout.on("data", (d) => {
  buffer += d;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      fail(`The server printed something that isn't MCP on stdout: ${line.slice(0, 200)}`);
    }
    if (msg.id !== undefined && waiting.has(msg.id)) {
      waiting.get(msg.id)(msg);
      waiting.delete(msg.id);
    }
  }
});
child.on("exit", (code) => waiting.size && fail(`The server stopped (code ${code}).\n${stderr.slice(-2000)}`));
let nextId = 1;
const send = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const timer = setTimeout(() => fail(`Timed out talking to the server.\n${stderr.slice(-2000)}`), 180_000);

const init = await send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "juracad-check", version: "1" } });
check(init.result?.serverInfo?.name === "juracad", `initialize failed: ${JSON.stringify(init).slice(0, 500)}`);
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
const listed = await send("tools/list", {});
const tools = listed.result?.tools ?? [];
check(tools.length === manifest.tools.length, `The server has ${tools.length} tools; the manifest lists ${manifest.tools.length}.`);
for (const t of manifest.tools) check(tools.some((x) => x.name === t.name), `The manifest's tool ${t.name} isn't on the server.`);

const call = async (name, args) => {
  const r = await send("tools/call", { name, arguments: args });
  check(!r.error && !r.result?.isError, `${name} failed: ${JSON.stringify(r.error ?? r.result).slice(0, 800)}`);
  return r.result.content;
};
const text = (content) => content.filter((c) => c.type === "text").map((c) => c.text).join("\n");

await call("new_design", { name: "CI bracket" });
await call("add_sketch", { plane: "Top", shapes: [{ type: "rectangle", corner: [0, 0], width: 60, height: 40 }] });
await call("add_feature", { type: "extrude", depth: 3 });
await call("add_sketch", { on_face: "top", shapes: [[5, 5], [55, 5], [5, 35], [55, 35]].map((at) => ({ type: "point", at })) });
await call("add_feature", { type: "hole", size: "M4" });
await call("add_feature", { type: "fillet", edges: ["along z"], radius: 4 });
const described = text(await call("describe_design", {}));
const expected = 60 * 40 * 3 - 4 * Math.PI * 2.25 ** 2 * 3 - 4 * 3 * (16 - 4 * Math.PI);
const volume = Number(/volume ([\d.]+) mm³/.exec(described)?.[1]);
check(Math.abs(volume - expected) < 0.05, `The bracket's volume is ${volume}, expected ${expected.toFixed(2)}.\n${described}`);
check(/valid closed solid/.test(described), `The bracket isn't a valid solid:\n${described}`);
const views = await call("get_views", {});
const png = views.find((c) => c.type === "image");
check(png?.mimeType === "image/png" && Buffer.from(png.data, "base64").subarray(1, 4).toString() === "PNG", "get_views didn't return a PNG.");
// Nothing outside the chosen folder.
const escape = await send("tools/call", { name: "save_design", arguments: { filename: "../outside" } });
check(escape.result?.isError, "Saving outside the folder should be refused.");
await call("save_design", {});
const saved = join(designs, "CI bracket.juracad");
check(existsSync(saved), `No design was saved at ${saved}.`);
const file = JSON.parse(readFileSync(saved, "utf8"));
check(file.format === "partsmith" && file.features.length === 5, "The saved design isn't a JuraCAD file with the 5 features.");

clearTimeout(timer);
child.kill();
rmSync(work, { recursive: true, force: true });
console.log(`The Claude extension works: ${tools.length} tools; built the bracket (${volume} mm³), drew it and saved ${file.features.length} features.`);
