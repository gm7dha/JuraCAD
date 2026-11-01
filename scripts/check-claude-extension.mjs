/**
 * Checks the Claude extension the way Claude's desktop app would use it:
 *   node scripts/check-claude-extension.mjs dist/juracad-claude.mcpb
 * Unpacks the .mcpb (a zip), checks its manifest, starts its server with Node
 * and talks MCP to it over stdin/stdout: lists the tools, builds the example
 * bracket (plate, four M4 holes, rounded corners), checks the volume, looks at
 * it and saves a .juracad file — then checks that file. It fastens the bracket
 * onto a plate in an assembly and checks it, makes a dimensioned drawing and
 * saves its PDF, and cancels a call (nothing may change). Then it connects to
 * the live link (Live with Claude) as the JuraCAD tab would, builds over it,
 * and checks the extension stops when Claude closes it.
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
for (const f of ["LICENSE", "LICENSE-OpenCascade.txt", "THIRD-PARTY-NOTICES.txt"]) check(existsSync(join(dir, f)), `${f} is missing.`);
check(!manifest.compatibility?.platforms?.includes("linux"), "Claude's desktop app runs on macOS and Windows only.");
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

// An assembly: the bracket fastened onto a base plate, checked for clashes and looked at.
const isPng = (content) => {
  const img = content.find((c) => c.type === "image");
  return img?.mimeType === "image/png" && Buffer.from(img.data, "base64").subarray(1, 4).toString() === "PNG";
};
await call("add_feature", { type: "box", width: 80, depth: 60, height: 4, x: 0, y: 60, z: 0, operation: "new" });
await call("rename_part", { part: "Part 2", name: "Base plate" });
await call("create_assembly", { name: "Bracket on plate" });
await call("insert_into_assembly", { part: "Base plate" });
await call("insert_into_assembly", { part: "Part 1" });
const mated = text(await call("add_mate", { type: "fasten", first: { instance: "Base plate <1>", face: "top" }, second: { instance: "Part 1 <1>", face: "bottom" } }));
check(/Added Fasten 1/.test(mated) && /places Part 1 <1> at/.test(mated), `The mate wasn't made:\n${mated}`);
const clashes = text(await call("check_assembly", {}));
check(/Everything fits: 2 parts, no clashes/.test(clashes), `The assembly check found problems:\n${clashes}`);
check(isPng(await call("get_views", { assembly: "Bracket on plate" })), "get_views of the assembly didn't return a PNG.");
await call("export_model", { assembly: "Bracket on plate", format: "step" });
check(existsSync(join(designs, "CI bracket Bracket on plate.step")), "The assembly's STEP file wasn't saved.");

// A drawing of the bracket, dimensioned, looked at and saved as a PDF.
const drawn = text(await call("create_drawing", { part: "Part 1", title: { title: "CI bracket", drawn_by: "CI" } }));
check(/Made Drawing 1/.test(drawn) && /- Top — across = X, up = Y; from \(0, 0\) to \(60, 40\) mm/.test(drawn), `The drawing wasn't made as expected:\n${drawn}`);
const dims = text(await call("auto_dimension", {}));
check(/Added \d+ dimensions/.test(dims), `Auto dimension added nothing:\n${dims}`);
check(/Added a horizontal dimension on Front: 60/.test(text(await call("add_dimension", { view: "front", from: [0, 0, 0], to: [60, 0, 0] }))), "add_dimension didn't measure the 60 mm width.");
check(isPng(await call("view_drawing", {})), "view_drawing didn't return a PNG.");
await call("export_drawing", { format: "pdf" });
const pdfFile = join(designs, "CI bracket Drawing 1.pdf");
check(existsSync(pdfFile) && readFileSync(pdfFile, "latin1").startsWith("%PDF-") && readFileSync(pdfFile, "latin1").includes("(CI bracket) Tj"), "The drawing's PDF wasn't saved with its title block.");

// Cancelling a call (as Claude does when the user stops it): no reply, and nothing changed or written.
const cancelId = nextId++;
let cancelledReply = null;
waiting.set(cancelId, (msg) => (cancelledReply = msg));
child.stdin.write(
  JSON.stringify({ jsonrpc: "2.0", id: cancelId, method: "tools/call", params: { name: "export_drawing", arguments: { format: "dxf", filename: "cancelled" } } }) +
    "\n" +
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: cancelId, reason: "The user stopped it." } }) +
    "\n",
);
const afterCancel = text(await call("describe_drawing", {}));
await new Promise((resolve) => setTimeout(resolve, 1000));
check(cancelledReply === null, `A cancelled call was still answered: ${JSON.stringify(cancelledReply).slice(0, 300)}`);
waiting.delete(cancelId);
check(!existsSync(join(designs, "cancelled.dxf")), "A cancelled export still wrote its file.");
check(/Drawing 1: part "Part 1"/.test(afterCancel), "The extension didn't carry on normally after a cancelled call.");

// Live with Claude: the extension listens on 127.0.0.1 for the JuraCAD tab. Talk to it the way the app does
// (src/live/protocol.ts), from the JuraCAD site's origin, using Node's own WebSocket.
const LIVE_PORTS = Array.from({ length: 10 }, (_, i) => 47615 + i);
const openSocket = (port, origin) =>
  new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/juracad-live`, { protocols: ["juracad-live.1"], headers: { origin } });
    ws.onopen = () => resolve(ws);
    ws.onerror = () => resolve(null);
  });
check(!(await openSocket(LIVE_PORTS[0], "https://evil.example")), "A page from another website could open the live link.");
// Pages served on this computer (a dev server, another program) are kept out too, unless JURACAD_LIVE_DEV=1.
for (const origin of ["http://localhost:5173", "http://127.0.0.1:1234", "https://localhost"]) {
  check(!(await openSocket(LIVE_PORTS[0], origin)), `A page from ${origin} could open the live link.`);
}
let ws = null;
let livePort = 0;
for (const port of LIVE_PORTS) if ((ws = await openSocket(port, "https://gm7dha.github.io"))) {
  livePort = port;
  break;
}
check(ws, `The live link isn't listening on 127.0.0.1 (ports ${LIVE_PORTS.join(", ")}).\n${stderr.slice(-2000)}`);
const fromExtension = [];
let answer = null;
const nextMessage = () => new Promise((resolve) => (answer = resolve));
ws.onmessage = (e) => {
  const msg = JSON.parse(String(e.data));
  fromExtension.push(msg);
  if (msg.type === "change") ws.send(JSON.stringify({ type: "applied", id: msg.id, version: msg.base + 1 }));
  answer?.(msg);
};
const liveFile = (name, features = []) => JSON.stringify({ format: "partsmith", version: 1, name, features });
const welcome = nextMessage();
ws.send(JSON.stringify({ type: "hello", protocol: 1, app: pkg.version, version: 1, studio: "main", file: liveFile("Live check") }));
check((await welcome).type === "welcome", `The live link didn't welcome JuraCAD: ${JSON.stringify(fromExtension)}`);
check(/Live: connected/.test(text(await call("live_status", {}))), "live_status doesn't say it's connected.");
const live = text(await call("add_feature", { type: "box", width: 20, depth: 10, height: 5 }));
check(/Live: this now shows in the user's open JuraCAD tab/.test(live), `A live change didn't say it was shown:\n${live}`);
let changes = fromExtension.filter((m) => m.type === "change");
check(changes.length === 1 && changes[0].base === 1 && /^Claude: added /.test(changes[0].label), `Expected one change based on version 1: ${JSON.stringify(changes).slice(0, 500)}`);
const liveDoc = JSON.parse(changes[0].file);
check(liveDoc.name === "Live check" && liveDoc.features.length === 1 && liveDoc.features[0].type === "box", "The live change isn't the open design plus a box.");
// The user changes the design in the app (version 3): Claude's next change is made on top of it.
ws.send(JSON.stringify({ type: "doc", version: 3, studio: "main", file: liveFile("Renamed in the app", liveDoc.features) }));
await call("add_feature", { type: "cylinder", diameter: 4, height: 10 });
changes = fromExtension.filter((m) => m.type === "change");
const second = JSON.parse(changes[1]?.file ?? "{}");
check(changes.length === 2 && changes[1].base === 3 && second.name === "Renamed in the app" && second.features?.length === 2, "Claude's second live change wasn't made on the user's latest design.");
ws.close();

// Safari's link window: served over plain http on 127.0.0.1 (only under that name), and its origin may open the live link.
const relayPage = await fetch(`http://127.0.0.1:${livePort}/juracad-relay`);
const relayHtml = await relayPage.text();
check(relayPage.status === 200 && relayHtml.includes('<script src="/juracad-relay.js"></script>'), `The link window page isn't served: ${relayPage.status} ${relayHtml.slice(0, 200)}`);
check(/frame-ancestors 'none'/.test(relayPage.headers.get("content-security-policy") ?? "") && relayPage.headers.get("x-frame-options") === "DENY", "The link window page may be framed.");
const relayJs = await fetch(`http://127.0.0.1:${livePort}/juracad-relay.js`);
const relaySource = await relayJs.text();
check(relayJs.status === 200 && /javascript/.test(relayJs.headers.get("content-type") ?? ""), `The link window script isn't served: ${relayJs.status}`);
// Other sites can't load them to find out whether the extension is running.
for (const r of [relayPage, relayJs]) check(r.headers.get("cross-origin-resource-policy") === "same-origin", `The link window's ${r.url} may be loaded by other sites.`);
try {
  new Function(relaySource);
} catch (e) {
  check(false, `The link window script doesn't parse: ${e}`);
}
check(relaySource.includes('"site":"https://gm7dha.github.io"') && relaySource.includes('"allowLocal":false'), "The shipped link window script must obey only the JuraCAD site.");
const relaySocket = await openSocket(livePort, `http://127.0.0.1:${livePort}`);
check(relaySocket, "The link window's origin couldn't open the live link.");
relaySocket?.close();
check(!(await openSocket(livePort, `http://localhost:${livePort}`)), "A page on http://localhost could open the live link.");

clearTimeout(timer);
// When Claude closes the extension (its input), it must stop, freeing the live link's port.
const stopped = new Promise((resolve) => child.once("exit", () => resolve(true)));
child.stdin.end();
const exited = await Promise.race([stopped, new Promise((resolve) => setTimeout(() => resolve(false), 5000))]);
if (!exited) child.kill();
check(exited, "The extension kept running after Claude closed it (it would keep the live link's port busy).");
rmSync(work, { recursive: true, force: true });
console.log(`The Claude extension works: ${tools.length} tools; built the bracket (${volume} mm³), drew it and saved ${file.features.length} features; fastened it onto a plate in an assembly (no clashes), made and dimensioned a drawing and saved its PDF; a cancelled call changed nothing; built live over the local link (${changes.length} changes, each applied once); served Safari's link window.`);
