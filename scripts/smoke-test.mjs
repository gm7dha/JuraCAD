/**
 * Browser smoke test: serves the production build, opens it in headless
 * Chromium and walks through the main flow like a person would:
 *   add a box → drill a hole with a cylinder (Remove) → check model → export STL.
 * Fails on any console error. Run after `npm run build`.
 *
 * In GitHub Actions, problems are reported as annotations. With
 * SMOKE_SCREENSHOTS=1 it also attaches small screenshots (as base64 notices)
 * so they can be reviewed without downloading artifacts.
 */
import { execFileSync, spawn } from "node:child_process";
import { createServer as createHttpsServer } from "node:https";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { preview } from "vite";

const inCI = process.env.GITHUB_ACTIONS === "true";
const wantShots = process.env.SMOKE_SCREENSHOTS === "1";
// GitHub keeps only 50 annotations per job (about 12 screenshots), so SMOKE_SHOW can name just the ones wanted.
const showOnly = (process.env.SMOKE_SHOW ?? "").split(",").map((x) => x.trim()).filter(Boolean);
const shotDir = "smoke-screenshots";
mkdirSync(shotDir, { recursive: true });

const annotate = (level, title, message) => {
  if (inCI) console.log(`::${level} title=${title}::${String(message).replace(/%/g, "%25").replace(/\r?\n/g, "%0A")}`);
  else console.log(`[${level}] ${title}: ${message}`);
};

let autoDims = 0;
let holeCallout = "";
let step = "starting";
const server = await preview({ preview: { port: 4173, strictPort: true }, logLevel: "warn" });
// The site's base path (e.g. "/JuraCAD/"), the same one vite.config.ts builds and previews with.
const basePath = server.config.base;
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, acceptDownloads: true });
// Use the download / file-picker way of saving and opening (the Save-as windows can't be driven headless).
await page.addInitScript(() => {
  for (const k of ["showSaveFilePicker", "showOpenFilePicker"]) Object.defineProperty(window, k, { value: undefined, configurable: true });
});
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(e.message));

/** Click a toolbar tool by name — straight away, or from the ▾ list of its family when another of them is showing. */
async function tool(name) {
  const direct = page.getByRole("button", { name, exact: true });
  if (await direct.count()) return direct.first().click();
  await page.locator(`.tool-split-arrow[data-items*="|${name}|"]`).first().click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}

let shotNumber = 0;
async function shot(name) {
  shotNumber++;
  const base = `${shotDir}/${shotNumber}-${name}`;
  const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
  writeFileSync(`${base}.jpg`, buffer);
  if (wantShots && (showOnly.length === 0 || showOnly.includes(name) || name === "failure")) {
    // A small copy, sent back as annotations by the next CI steps.
    const small = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/jpeg;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = 560;
      c.height = Math.round((img.height / img.width) * 560);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return c.toDataURL("image/jpeg", 0.5).split(",")[1];
    }, buffer.toString("base64"));
    writeFileSync(`${base}.b64`, small);
  }
}

/**
 * Live with Claude looks for Claude chats on its ports; the browser logs each one nothing answers on (even a try
 * still on its way when the test disconnects). Expected, not a fault: only refused connections to those ports.
 */
const liveProbeRefused = (e) => /^WebSocket connection to 'ws:\/\/127\.0\.0\.1:476(1[5-9]|2[0-4])\/juracad-live' failed: .*net::ERR_CONNECTION_REFUSED/.test(e);

const statusText = () => page.locator(".status-strip").innerText();

try {
  step = "loading the app";
  await page.goto(`http://localhost:4173${basePath}?smoke`);
  await page.waitForSelector(".topbar", { timeout: 30_000 });

  step = "waiting for the geometry engine";
  await page.waitForSelector(".engine-status", { state: "detached", timeout: 120_000 });

  step = "adding a box";
  await tool("Box");
  await page.locator("#param-width").fill("40");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForFunction(() => document.querySelector(".part-list")?.textContent?.includes("Part 1"), null, {
    timeout: 30_000,
  });

  step = "drilling a hole with a cylinder";
  await page.locator('.tool-split-arrow[data-items*="|Cylinder|"]').click();
  await page.waitForSelector('[role="menu"] >> text=Coil');
  await shot("toolmenu");
  await page.keyboard.press("Escape");
  await page.waitForSelector('[role="menu"]', { state: "detached" });
  await tool("Cylinder");
  await page.getByRole("radio", { name: "Remove" }).click();
  await page.locator("#param-diameter").fill("10");
  await page.locator("#param-height").fill("20");
  await page.locator("#param-x").fill("40 / 2");
  await page.locator("#param-y").fill("15");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForTimeout(1500);
  const failed = await page.locator(".feature-row.failed").count();
  if (failed > 0) throw new Error(`${failed} feature(s) failed to build`);
  const features = await page.locator(".feature-row:not(.datum)").count();
  if (features !== 2) throw new Error(`expected 2 features in the list, found ${features}`);

  step = "orbiting right over the top";
  {
    const vp = await page.locator(".viewport").boundingBox();
    const cx = vp.x + vp.width * 0.5;
    const cy = vp.y + vp.height * 0.5;
    await page.mouse.move(cx, cy - vp.height * 0.2);
    await page.mouse.down({ button: "right" });
    for (let i = 1; i <= 10; i++) await page.mouse.move(cx, cy - vp.height * 0.2 + vp.height * 0.04 * i);
    await page.mouse.up({ button: "right" });
    const up = await page.evaluate(() => window.juracadViewport.current.cameraUp());
    // From the starting (isometric) view, 0.4 of the view's height turns ~130°: past straight down onto the top.
    if (!(up[2] < 0)) throw new Error(`orbiting stopped at the top (screen up is ${up.map((n) => n.toFixed(2)).join(", ")})`);
    await page.evaluate(() => window.juracadViewport.current.setView("iso", false));
  }

  step = "hovering and selecting a face";
  const box = await page.locator(".viewport").boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.waitForTimeout(300);
  const selected = await statusText();
  await page.waitForSelector(".measure-panel td", { timeout: 10_000 });
  const measured = (await page.locator(".measure-panel tr").first().innerText()).replace(/\s+/g, " ");
  await shot("drilled-block");

  step = "colouring the part";
  await page.getByRole("button", { name: "Colour of Part 1" }).click();
  await page.getByRole("button", { name: "Blue", exact: true }).click();
  await page.waitForFunction(() => document.querySelector(".colour-swatch")?.getAttribute("style")?.includes("61, 127, 217"));

  step = "cutting the block open with a section view";
  await page.getByRole("button", { name: "Section", exact: true }).click();
  await page.waitForSelector(".section-panel");
  await page.getByRole("radio", { name: "Front" }).click();
  await page.waitForTimeout(400);
  await page.keyboard.press("Shift+Digit7");
  await page.waitForTimeout(500);
  await shot("section");
  await page.getByRole("button", { name: "Close section view" }).click();
  await page.waitForSelector(".section-panel", { state: "detached" });

  step = "checking it fits on a print bed";
  await page.getByRole("button", { name: "Print bed", exact: true }).click();
  await page.waitForSelector(".print-bed-panel >> text=Fits on the bed", { timeout: 5_000 });
  await page.locator("#print-bed-printer").selectOption("custom");
  await page.getByLabel("Bed X (width)").fill("10");
  await page.waitForSelector(".print-bed-panel >> text=too wide", { timeout: 5_000 });
  await shot("print-bed");
  await page.getByRole("button", { name: "Close print bed" }).click();
  await page.waitForSelector(".print-bed-panel", { state: "detached" });

  step = "switching to the top view";
  await page.keyboard.press("Shift+Digit5");
  await page.waitForTimeout(600);
  await shot("top-view");
  await page.keyboard.press("Shift+Digit4");
  await page.waitForTimeout(600);
  await shot("right-view");
  await page.keyboard.press("Shift+Digit7");
  await page.waitForTimeout(600);

  step = "checking the model";
  await page.getByRole("button", { name: "Check model" }).click();
  await page.waitForSelector(".check-headline", { timeout: 30_000 });
  const headline = await page.locator(".check-headline").innerText();
  await shot("check-model");
  if (!/Ready to export/.test(headline)) throw new Error(`check said: ${headline}`);
  await page.getByRole("button", { name: "Close", exact: true }).first().click();

  step = "exporting STL (typing a file name)";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("radio", { name: /STL/ }).check();
  const nameBox = page.locator("#export-name");
  await nameBox.click();
  await nameBox.press("Control+a");
  await page.keyboard.type("bracket v2", { delay: 25 });
  const typed = await nameBox.inputValue();
  if (typed !== "bracket v2") throw new Error(`the file name box lost the typing: it says "${typed}"`);
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Check & export" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const { statSync } = await import("node:fs");
  const bytes = statSync(path).size;
  if (bytes < 84 + 50 * 12) throw new Error(`STL file is suspiciously small (${bytes} bytes)`);
  if (download.suggestedFilename() !== "bracket v2.stl") throw new Error(`file was named ${download.suggestedFilename()}`);

  step = "exporting STEP";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  if (!(await page.getByRole("radio", { name: /STEP/ }).isChecked())) throw new Error("STEP isn't the default format");
  const stepPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Check & export" }).click();
  const stepDownload = await stepPromise;
  const { readFileSync } = await import("node:fs");
  const stepText = readFileSync(await stepDownload.path(), "utf8");
  if (!stepText.startsWith("ISO-10303-21")) throw new Error(`the STEP file doesn't look like STEP: ${stepText.slice(0, 40)}`);
  if (!stepDownload.suggestedFilename().endsWith(".step")) throw new Error(`STEP file was named ${stepDownload.suggestedFilename()}`);

  step = "exporting 3MF";
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.getByRole("radio", { name: /3MF/ }).check();
  const mfPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Check & export" }).click();
  const mfDownload = await mfPromise;
  const mfBytes = readFileSync(await mfDownload.path());
  if (mfBytes[0] !== 0x50 || mfBytes[1] !== 0x4b || !mfDownload.suggestedFilename().endsWith(".3mf")) {
    throw new Error(`the 3MF file doesn't look right (${mfDownload.suggestedFilename()})`);
  }

  step = "editing a feature three times, then undoing once";
  const boxRow = page.locator(".feature-row:not(.datum)").first();
  for (const x of ["10", "20", "30"]) {
    await boxRow.dblclick();
    await page.locator("#param-x").fill(x);
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForTimeout(400);
  }
  // Accepting without changes must not add an undo step.
  await boxRow.dblclick();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
  await boxRow.dblclick();
  const xAfterUndo = await page.locator("#param-x").inputValue();
  if (xAfterUndo !== "20") throw new Error(`one undo should go back one step (x = 20), but x = ${xAfterUndo}`);

  step = "pressing undo while a feature dialog is open";
  await page.getByRole("radio", { name: "Add" }).click(); // focus on a button, not a text box
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(400);
  if ((await page.locator(".feature-dialog").count()) !== 1) throw new Error("undo closed the open feature dialog");
  if ((await page.locator("#param-x").inputValue()) !== "20") throw new Error("undo changed the feature being edited");
  await page.getByRole("button", { name: "Cancel" }).click();

  step = "selecting, viewing and hiding the default planes";
  const topRow = page.locator(".feature-row.datum", { hasText: "Top" });
  await topRow.click();
  if (!(await topRow.getAttribute("class")).includes("selected")) throw new Error("clicking Top didn't select it");
  const planeStatus = await statusText();
  if (!planeStatus.includes("Top plane selected")) throw new Error(`status said: ${planeStatus}`);
  await page.keyboard.press("n");
  await page.waitForTimeout(600);
  await shot("top-plane-selected");
  await page.locator(".feature-row.datum", { hasText: "Front" }).dblclick();
  await page.waitForTimeout(500);
  const rightRow = page.locator(".feature-row.datum", { hasText: "Right" });
  await rightRow.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Hide", exact: true }).click();
  if (!(await rightRow.getAttribute("class")).includes("hidden")) throw new Error("hiding the Right plane didn't work");
  await rightRow.hover();
  await page.getByRole("button", { name: "Show Right" }).click();
  if ((await rightRow.getAttribute("class")).includes("hidden")) throw new Error("showing the Right plane didn't work");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Digit7");

  step = "scrolling the toolbar with the mouse wheel";
  {
    const bar = page.locator('.toolbar[aria-label="Tools"]');
    const wide = await bar.evaluate((b) => b.scrollWidth > b.clientWidth);
    if (wide) {
      await bar.evaluate((b) => (b.scrollLeft = 0));
      await page.getByLabel("Scroll tools right").waitFor({ timeout: 5_000 }).catch(async () => {
        const info = await bar.evaluate((b) => `scrollLeft ${b.scrollLeft}, client ${b.clientWidth}, scroll ${b.scrollWidth}, parent ${b.parentElement?.className}`);
        throw new Error(`no arrow to show more tools (${info})`);
      });
      const tb = await bar.boundingBox();
      await page.mouse.move(tb.x + tb.width / 2, tb.y + tb.height / 2);
      await page.mouse.wheel(0, 400);
      await page.waitForFunction(() => document.querySelector('.toolbar[aria-label="Tools"]').scrollLeft > 0);
      await page.getByLabel("Scroll tools left").waitFor();
      await bar.evaluate((b) => (b.scrollLeft = 0));
    }
  }

  step = "the Help screen's surprise";
  {
    await page.getByRole("button", { name: "Help and shortcuts" }).click();
    const win = page.getByRole("radio", { name: "Windows" });
    for (let i = 0; i < 10; i++) await win.click();
    await page.locator(".easter-egg img").waitFor({ timeout: 5_000 });
    await page.locator(".easter-egg").click();
    await page.locator(".easter-egg").waitFor({ state: "detached", timeout: 5_000 });
    step = "the Help screen's Claude extension download";
    // "Use JuraCAD with Claude": the link downloads the extension built into the site.
    const link = page.getByRole("link", { name: "Download the JuraCAD extension for Claude" });
    const href = await link.getAttribute("href");
    if (href !== `${basePath}juracad-claude.mcpb`) throw new Error(`The Claude extension link goes to ${href}`);
    const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
    const size = (await readFile(await download.path())).length;
    if (download.suggestedFilename() !== "juracad-claude.mcpb" || size < 1_000_000) throw new Error(`The Claude extension download is ${download.suggestedFilename()}, ${size} bytes`);
    await page.keyboard.press("Escape");
  }

  step = "Connect to Claude with no extension running";
  let liveReport = "not tried";
  {
    // Nothing is listening yet: a friendly "not connected" with what to do (and the file route).
    await page.getByRole("button", { name: "Connect to Claude" }).click();
    const dialog = page.getByRole("dialog", { name: "Claude isn't connected" });
    await dialog.waitFor({ timeout: 30_000 });
    const help = await dialog.innerText();
    if (!/Claude desktop app is open/.test(help) || !/\.juracad file/.test(help)) throw new Error(`The "not connected" message doesn't say what to do: ${help}`);
    await shot("live-not-connected");
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "detached" });
    liveReport = "Connect to Claude with no extension said what to do";
  }

  // With the extension built (CI builds it before this test): start it the way Claude does, connect, and let
  // "Claude" (this test, talking MCP to it) add a feature, which must appear in the open design.
  const extensionServer = "build/claude-extension/server/index.mjs";
  if (existsSync(extensionServer)) {
    step = "Live with Claude: starting two extensions (two Claude chats)";
    const designs = mkdtempSync(join(tmpdir(), "juracad-smoke-live-"));
    /** One extension process, as Claude starts one for each chat, and a little MCP client to drive it. */
    const startExtension = (name) => {
      // JURACAD_LIVE_DEV=1: this test serves JuraCAD from localhost, which the shipped extension otherwise turns away.
      const ext = spawn(process.execPath, [extensionServer, designs], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, JURACAD_LIVE_DEV: "1" } });
      let extLog = "";
      ext.stderr.on("data", (d) => (extLog += d));
      const replies = new Map();
      let pending = "";
      ext.stdout.on("data", (d) => {
        pending += d;
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, nl).trim();
          pending = pending.slice(nl + 1);
          if (!line) continue;
          const msg = JSON.parse(line);
          replies.get(msg.id)?.(msg);
        }
      });
      let nextId = 1;
      const mcp = (method, params) =>
        new Promise((resolve, reject) => {
          const id = nextId++;
          const timer = setTimeout(() => reject(new Error(`${name}'s extension didn't answer ${method}\n${extLog.slice(-1500)}`)), 120_000);
          replies.set(id, (m) => {
            clearTimeout(timer);
            resolve(m);
          });
          ext.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
        });
      const tool = async (toolName, args = {}) => {
        const r = await mcp("tools/call", { name: toolName, arguments: args });
        const text = (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
        if (r.error || r.result?.isError) throw new Error(`${name}: ${toolName} failed: ${JSON.stringify(r.error) ?? text}`);
        return text;
      };
      const ready = async () => {
        await mcp("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } });
        ext.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
        for (let i = 0; i < 100 && !/Live link ready/.test(extLog); i++) await page.waitForTimeout(100);
        if (!/Live link ready/.test(extLog)) throw new Error(`${name}'s live link didn't start:\n${extLog.slice(-1500)}`);
      };
      /** Wait until live_status says `want` (the tab links new chats every few seconds). */
      const waitStatus = async (want, seconds = 15) => {
        let status = "";
        for (let i = 0; i < seconds * 5; i++) {
          status = await tool("live_status");
          if (want.test(status)) return status;
          await page.waitForTimeout(200);
        }
        throw new Error(`${name}: live_status never matched ${want}: ${status}`);
      };
      return { tool, ready, waitStatus, log: () => extLog, kill: () => ext.kill() };
    };
    const chats = [];
    try {
      const chat1 = startExtension("chat 1");
      chats.push(chat1);
      await chat1.ready();
      const chat2 = startExtension("chat 2");
      chats.push(chat2);
      await chat2.ready();
      const tool = chat1.tool;

      step = "Live with Claude: connecting";
      await page.getByRole("button", { name: "Connect to Claude" }).click();
      await page.locator(".live-badge").waitFor({ timeout: 30_000 });
      await chat1.waitStatus(/Live: connected/);
      await chat2.waitStatus(/Live: connected/);
      await page.locator(".live-badge").click();
      const details = page.getByRole("dialog", { name: "Live with Claude" });
      await details.waitFor();
      if (!/2 Claude chats linked/.test(await details.innerText())) throw new Error(`the details don't say 2 chats are linked: ${await details.innerText()}`);
      await page.keyboard.press("Escape");
      await details.waitFor({ state: "detached" });
      const before = await page.locator(".feature-row:not(.datum)").count();

      step = "Live with Claude: Claude (in the second chat) adds a feature";
      const added = await chat2.tool("add_feature", { type: "box", name: "Box from Claude", width: 6, depth: 6, height: 6, x: -20, y: -20, z: 0, operation: "new" });
      if (!/Live: this now shows/.test(added)) throw new Error(`add_feature didn't reach the app: ${added}`);
      await page.locator(".feature-row", { hasText: "Box from Claude" }).waitFor({ timeout: 30_000 });
      await page.locator(".toast", { hasText: "Claude: added Box from Claude" }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(800);
      await shot("live-connected");
      // The first chat sees it too.
      let seen = "";
      for (let i = 0; i < 50 && !/Box from Claude/.test(seen); i++) {
        seen = await tool("describe_design");
        if (!/Box from Claude/.test(seen)) await page.waitForTimeout(100);
      }
      if (!/Box from Claude/.test(seen)) throw new Error("the first chat doesn't see the second chat's box");

      step = "Live with Claude: the user undoes it in the app";
      await page.getByRole("button", { name: "Undo", exact: true }).click();
      await page.locator(".feature-row", { hasText: "Box from Claude" }).waitFor({ state: "detached", timeout: 10_000 });
      const after = await page.locator(".feature-row:not(.datum)").count();
      if (after !== before) throw new Error(`after undo the feature list has ${after} features, not ${before}`);
      for (const chat of [chat1, chat2]) {
        let described = "";
        for (let i = 0; i < 50; i++) {
          described = await chat.tool("describe_design");
          if (!/Box from Claude/.test(described)) break;
          await page.waitForTimeout(100);
        }
        if (/Box from Claude/.test(described)) throw new Error("Claude still sees the box after the user undid it");
      }

      step = "Live with Claude: a chat started after connecting is linked by itself";
      const chat3 = startExtension("chat 3");
      chats.push(chat3);
      await chat3.ready();
      await chat3.waitStatus(/Live: connected/);
      // ...and when it stops, the others carry on.
      chat3.kill();
      await page.waitForTimeout(1500);
      await page.locator(".live-badge").waitFor();
      await chat1.waitStatus(/Live: connected/);

      step = "Live with Claude: disconnecting";
      await page.locator(".live-badge").click();
      await page.getByRole("button", { name: "Disconnect" }).click();
      await page.getByRole("button", { name: "Connect to Claude" }).waitFor();
      await chat1.waitStatus(/Live: not connected/, 10);
      await chat2.waitStatus(/Live: not connected/, 10);
      liveReport += `; live with 2 Claude chats: the second added a box to the open design (${before} → ${before + 1} features) and the first saw it, the user undid it and both saw that; a third chat started later was linked by itself, and dropped when it stopped`;

      // The real site is https and the link is ws:// — check Chromium allows that to 127.0.0.1 (it isn't
      // "mixed content", because 127.0.0.1 is this computer). A blank https page with a throwaway certificate.
      step = "Live with Claude: ws:// to 127.0.0.1 from an https page";
      const livePort = Number(/Live link ready on 127\.0\.0\.1:(\d+)/.exec(chat1.log())?.[1]);
      const certDir = mkdtempSync(join(tmpdir(), "juracad-smoke-cert-"));
      try {
        execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(certDir, "key.pem"), "-out", join(certDir, "cert.pem"), "-days", "1", "-subj", "/CN=localhost"], { stdio: "ignore" });
        const httpsServer = createHttpsServer({ key: await readFile(join(certDir, "key.pem")), cert: await readFile(join(certDir, "cert.pem")) }, (_req, res) => {
          res.writeHead(200, { "Content-Type": "text/html" });
          res.end("<!doctype html><title>https page</title><p>https</p>");
        });
        await new Promise((resolve) => httpsServer.listen(4443, "127.0.0.1", resolve));
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        try {
          const securePage = await context.newPage();
          await securePage.goto("https://localhost:4443/");
          const result = await securePage.evaluate(
            (port) =>
              new Promise((resolve) => {
                let ws;
                try {
                  ws = new WebSocket(`ws://127.0.0.1:${port}/juracad-live`, "juracad-live.1");
                } catch (e) {
                  resolve(`refused: ${e.message}`);
                  return;
                }
                ws.onopen = () => {
                  resolve(`open (secure context: ${window.isSecureContext})`);
                  ws.close();
                };
                ws.onerror = () => resolve("error");
                setTimeout(() => resolve("timed out"), 15_000);
              }),
            livePort,
          );
          if (!result.startsWith("open")) throw new Error(`an https page couldn't open ws://127.0.0.1:${livePort}: ${result}`);
          liveReport += `; an https page opened ws://127.0.0.1 (${result})`;
        } finally {
          await context.close();
          httpsServer.close();
        }
      } finally {
        rmSync(certDir, { recursive: true, force: true });
      }
    } finally {
      chats.forEach((c) => c.kill());
      rmSync(designs, { recursive: true, force: true });
    }
  }

  step = "starting a sketch and picking the Top plane";
  await page.getByRole("button", { name: "Sketch", exact: true }).click();
  await page.waitForSelector(".sketch-panel");
  await page.locator(".feature-row.datum", { hasText: "Top" }).click();
  await page.waitForFunction(() => document.querySelector(".sketch-plane-row")?.textContent?.includes("Top plane"));
  await page.waitForTimeout(600); // camera turns to look down on the sketch
  const vp = await page.locator(".viewport").boundingBox();
  const cx = vp.x + vp.width / 2;
  const cy = vp.y + vp.height / 2;

  step = "drawing a rectangle";
  await page.keyboard.press("r");
  await page.mouse.click(cx - 90, cy + 60);
  await page.mouse.move(cx + 40, cy - 20, { steps: 4 });
  await page.mouse.click(cx + 90, cy - 60);
  await page.waitForFunction(() => document.querySelector(".sketch-status")?.textContent?.includes("1 closed shape"));
  // Its sizes are offered straight away; Esc skips them.
  await page.locator(".dimension-editor input").waitFor({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await page.locator(".dimension-editor").waitFor({ state: "detached", timeout: 5_000 });

  step = "dimensioning the rectangle's width by typing";
  await page.keyboard.press("d");
  await page.mouse.click(cx + 30, cy + 60); // the bottom edge
  await page.mouse.click(cx + 30, cy + 110); // where the value goes
  const editor = page.locator(".dimension-editor input");
  await editor.waitFor();
  await editor.fill("50");
  await editor.press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".dimension-label")].some((e) => e.textContent === "50"));

  step = "adding a circle inside (it becomes a hole)";
  await page.keyboard.press("c");
  await page.mouse.click(cx, cy);
  await page.mouse.click(cx + 20, cy);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.querySelector(".sketch-status")?.textContent?.includes("1 closed shape"));
  const sketchStatusText = await page.locator(".sketch-status").innerText();
  await shot("sketch");

  step = "finishing the sketch";
  await page.locator(".sketch-panel").getByRole("button", { name: "Accept" }).click();
  await page.waitForSelector(".sketch-panel", { state: "detached" });

  step = "extruding the sketch";
  await page.getByRole("button", { name: "Extrude", exact: true }).click();
  await page.getByRole("radio", { name: "New" }).click();
  await page.locator("#param-depth").fill("15");
  step = "clicking an area of the sketch in the 3D view (the disc in the plate's hole)";
  await page.evaluate(() => window.juracadViewport.current.fit(false));
  await page.waitForTimeout(300);
  const areaSpots = await page.evaluate(() => window.juracadViewport.current.areaScreenPoints());
  if (areaSpots.length !== 2) throw new Error(`expected 2 clickable areas in the 3D view, got ${areaSpots.length}`);
  const disc = areaSpots.reduce((a, b) => (b.box < a.box ? b : a));
  const discKind = await page.evaluate(([x, y]) => window.juracadViewport.current.pickKindAt(x, y), [disc.x, disc.y]);
  if (discKind !== "sketchArea") throw new Error(`a click on the disc would pick ${discKind}, not the sketch area`);
  const vpBox = await page.locator(".viewport").boundingBox();
  await page.mouse.click(vpBox.x + disc.x, vpBox.y + disc.y);
  // The 2D map opens by itself and agrees; the feature remembers just the disc (its size is π × r²).
  await page.waitForFunction(() => document.querySelector(".area-picker")?.textContent?.includes("1 area picked"));
  const clickedAreas = await page.evaluate(() => window.juracadStore.getState().editing.draft.areas);
  if (clickedAreas?.length !== 1 || !(clickedAreas[0][2] > 0)) throw new Error(`expected one picked area, got ${JSON.stringify(clickedAreas)}`);
  const pickedInMap = await page.locator(".area-map .area-shape.picked").count();
  if (pickedInMap !== 1) throw new Error(`the 2D map shows ${pickedInMap} picked areas, expected 1`);
  await shot("area-clicked");
  // Clicking it again leaves it out: back to every closed shape.
  await page.mouse.click(vpBox.x + disc.x, vpBox.y + disc.y);
  await page.waitForFunction(() => !window.juracadStore.getState().editing.draft.areas);

  step = "picking an area in the extrude dialog, then going back to all closed shapes";
  if ((await page.locator(".area-map").count()) === 0) await page.getByRole("button", { name: "pick them on a map…" }).click();
  const areaShapes = page.locator(".area-map .area-shape");
  await areaShapes.first().waitFor({ timeout: 10_000 });
  const areaCount = await areaShapes.count();
  if (areaCount !== 2) throw new Error(`expected 2 areas (the plate and the disc in its hole), got ${areaCount}`);
  // With nothing picked, only the plate is shaded as used (the disc is a hole).
  const usedCount = await page.locator(".area-map .area-shape.all").count();
  if (usedCount !== 1) throw new Error(`expected only the plate to show as used, got ${usedCount} areas`);
  await areaShapes.nth(1).click(); // the disc (smaller areas are drawn on top)
  await page.waitForFunction(() => document.querySelector(".area-picker")?.textContent?.includes("1 area picked"));
  await page.getByRole("button", { name: "Use all closed shapes" }).click();
  await page.waitForFunction(() => document.querySelector(".area-picker")?.textContent?.includes("Using every closed shape"));
  step = "extruding the sketch";
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForFunction(() => document.querySelector(".part-list")?.textContent?.includes("Part 2"), null, { timeout: 30_000 });
  const failedAfterExtrude = await page.locator(".feature-row.failed").count();
  if (failedAfterExtrude > 0) throw new Error(`${failedAfterExtrude} feature(s) failed after extruding`);
  await page.keyboard.press("Shift+Digit7");
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await shot("extruded");

  step = "checking the extruded part";
  await page.getByRole("button", { name: "Check model" }).click();
  await page.waitForSelector(".check-headline", { timeout: 30_000 });
  const extrudeCheck = await page.locator(".check-report").innerText();
  if (!/Part 2/.test(extrudeCheck)) throw new Error(`check report didn't include Part 2: ${extrudeCheck}`);
  await page.getByRole("button", { name: "Close", exact: true }).first().click();

  step = "showing and hiding the extruded sketch and the Top plane with their eyes";
  {
    const sketchInfo = () =>
      page.evaluate(() => {
        // The sketch just extruded (the last one so far).
        const f = window.juracadStore.getState().history.present.features.filter((x) => x.type === "sketch").at(-1);
        window.__smokeSketch = f.id;
        return { name: f.name, visible: f.visible };
      });
    const { name: sketchName, visible: before } = await sketchInfo();
    // Used by the extrude, so (as in Onshape) it hid by itself: its eye offers to show it.
    if (before !== undefined) throw new Error(`the sketch's visibility was set before anyone clicked its eye: ${before}`);
    const sketchRow = page.locator(".feature-row:not(.datum)", { hasText: sketchName }).first();
    await sketchRow.getByRole("button", { name: `Show ${sketchName}` }).click();
    await page.waitForFunction(() => window.juracadStore.getState().history.present.features.find((x) => x.type === "sketch" && x.id === window.__smokeSketch).visible === true);
    await sketchRow.hover();
    await sketchRow.getByRole("button", { name: `Hide ${sketchName}` }).click();
    await page.waitForFunction(() => window.juracadStore.getState().history.present.features.find((x) => x.type === "sketch" && x.id === window.__smokeSketch).visible === false);
    // Right-click: Show all sketches.
    await sketchRow.click({ button: "right" });
    await page.getByRole("menuitem", { name: "Show all sketches" }).click();
    await page.waitForFunction(() => window.juracadStore.getState().history.present.features.filter((x) => x.type === "sketch").every((x) => x.visible === true));
    // The Top plane: hide it, then show it again (saved in the design).
    const topRow = page.locator(".feature-row.datum", { hasText: "Top" });
    await topRow.hover();
    await topRow.getByRole("button", { name: "Hide Top" }).click();
    await page.waitForFunction(() => window.juracadStore.getState().history.present.hiddenDatums?.includes("Top"));
    await topRow.getByRole("button", { name: "Show Top" }).click();
    await page.waitForFunction(() => !window.juracadStore.getState().history.present.hiddenDatums);
    // Undo all five changes: the sketch is back to automatic (hidden, as it's used) for the steps after this.
    await page.evaluate(() => {
      const st = window.juracadStore.getState();
      for (let i = 0; i < 5; i++) st.undo();
    });
    await page.waitForFunction(
      () =>
        window.juracadStore.getState().history.present.features.find((x) => x.type === "sketch" && x.id === window.__smokeSketch).visible === undefined &&
        !window.juracadStore.getState().history.present.hiddenDatums,
    );
    if ((await page.locator(".feature-row.failed").count()) > 0) throw new Error("a feature failed after undoing the show/hide steps");
  }

  step = "filleting the edges of a face";
  await page.keyboard.press("Shift+Digit5");
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  const area = await page.locator(".viewport").boundingBox();
  await page.mouse.click(area.x + area.width * 0.5, area.y + area.height * 0.5);
  await page.waitForTimeout(300);
  await page.keyboard.press("Shift+KeyF");
  await page.waitForSelector(".feature-dialog .pick-list li", { timeout: 5_000 });
  const pickCount = await page.locator(".feature-dialog .pick-list li").count();
  await page.locator("#param-radius").fill("1");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForSelector(".feature-row:not(.datum) >> text=Fillet 1", { timeout: 10_000 });
  await page.waitForTimeout(2_000);
  const failedAfterFillet = await page.locator(".feature-row.failed").count();
  if (failedAfterFillet > 0) {
    const why = await page.locator(".feature-row.failed").first().getAttribute("title");
    throw new Error(`the fillet failed: ${why}`);
  }
  await page.keyboard.press("Shift+Digit7");
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await shot("filleted");

  step = "sketching a profile with a construction line to spin around";
  await page.getByRole("button", { name: "Sketch", exact: true }).click();
  await page.waitForSelector(".sketch-panel");
  await page.locator(".feature-row.datum", { hasText: "Front" }).click();
  await page.waitForFunction(() => document.querySelector(".sketch-plane-row")?.textContent?.includes("Front plane"));
  await page.waitForTimeout(600);
  await page.keyboard.press("q"); // new shapes are construction geometry
  await page.keyboard.press("l");
  await page.mouse.click(cx - 120, cy - 80);
  await page.mouse.click(cx - 120, cy + 80);
  await page.keyboard.press("Escape"); // stop the chain of lines
  await page.keyboard.press("Escape"); // leave the line tool
  await page.keyboard.press("Escape"); // clear any selection
  await page.keyboard.press("q"); // back to normal shapes
  await page.keyboard.press("r");
  await page.mouse.click(cx - 60, cy + 50);
  await page.mouse.move(cx, cy, { steps: 4 });
  await page.mouse.click(cx + 20, cy - 50);
  await page.waitForFunction(() => document.querySelector(".sketch-status")?.textContent?.includes("1 closed shape"));
  await page.locator(".sketch-panel").getByRole("button", { name: "Accept" }).click();
  await page.waitForSelector(".sketch-panel", { state: "detached" });

  step = "revolving the sketch";
  await page.getByRole("button", { name: "Revolve", exact: true }).click();
  const axisChoice = await page.locator("#revolve-axis option:checked").innerText();
  if (!/Construction line/.test(axisChoice)) throw new Error(`revolve didn't pick the construction line, it picked "${axisChoice}"`);
  await page.getByRole("radio", { name: "New" }).click();
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForFunction(() => document.querySelector(".part-list")?.textContent?.includes("Part 3"), null, { timeout: 30_000 });
  const failedAfterRevolve = await page.locator(".feature-row.failed").count();
  if (failedAfterRevolve > 0) {
    const why = await page.locator(".feature-row.failed").first().getAttribute("title");
    throw new Error(`the revolve failed: ${why}`);
  }
  await page.keyboard.press("Shift+Digit7");
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await shot("revolved");

  step = "repeating the revolve with a linear pattern";
  await tool("Pattern");
  await page.waitForSelector(".feature-dialog .pick-list li", { timeout: 5_000 });
  const patternSource = await page.locator(".feature-dialog .pick-list li").first().innerText();
  await page.locator("#param-count").fill("2");
  await page.locator("#param-spacing").fill("80");
  // Skipping copy 2 of 2 would leave nothing: explained, and not kept.
  await page.locator("#pattern-skip").fill("2");
  await page.waitForSelector(".feature-dialog >> text=That skips every copy", { timeout: 5_000 });
  await page.locator("#pattern-skip").fill("");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForSelector(".feature-row:not(.datum) >> text=Linear pattern 1", { timeout: 10_000 });
  await page.waitForTimeout(2_000);
  const failedAfterPattern = await page.locator(".feature-row.failed").count();
  if (failedAfterPattern > 0) {
    const why = await page.locator(".feature-row.failed").first().getAttribute("title");
    throw new Error(`the pattern failed: ${why}`);
  }
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await shot("patterned");

  step = "choosing a mirror plane by clicking a face";
  await tool("Mirror");
  const mirrorBox = '.feature-dialog fieldset[aria-label="Mirror plane"]';
  await page.waitForSelector(`${mirrorBox} >> text=Click a flat face, a plane or a sketch line in the view`, { timeout: 5_000 });
  if (!(await page.getByRole("button", { name: "Accept" }).isDisabled())) throw new Error("a mirror with no plane chosen could be accepted");
  {
    // A spot on a flat face that isn't under the dialog: look across the view, right of the dialog.
    const dialog = await page.locator(".feature-dialog").boundingBox();
    const canvasBox = await page.locator(".viewport-canvas").boundingBox();
    const free = await page.evaluate(({ left, w, h }) => {
      const v = window.juracadViewport.current;
      for (let y = h * 0.2; y < h * 0.9; y += 12) for (let x = left; x < w * 0.9; x += 12) if (v.pickKindAt(x, y) === "face:PLANE") return { x, y };
      return null;
    }, { left: dialog && canvasBox ? dialog.x + dialog.width - canvasBox.x + 20 : 300, w: canvasBox?.width ?? 800, h: canvasBox?.height ?? 600 });
    if (!free) throw new Error("couldn't find a flat face to click for the mirror plane");
    await page.locator(".viewport-canvas").click({ position: free });
    await page.waitForSelector(`${mirrorBox} .reference-chip >> text=Flat face of`, { timeout: 5_000 }).catch(async () => {
      const said = (await page.locator(".toast").allInnerTexts()).join(" / ");
      const box = await page.locator(mirrorBox).innerText();
      throw new Error(`clicking a flat face at (${Math.round(free.x)}, ${Math.round(free.y)}) didn't set the mirror plane. Box: ${box}. Toast: ${said || "none"}`);
    });
    await shot("mirrorplane");
    await page.locator(mirrorBox).getByRole("radio", { name: "Top" }).click();
    await page.waitForSelector(`${mirrorBox} .reference-chip >> text=Top plane`, { timeout: 5_000 });
    await page.getByRole("button", { name: "Clear the mirror plane" }).click();
    await page.waitForSelector(`${mirrorBox} >> text=Click a flat face, a plane or a sketch line in the view`, { timeout: 5_000 });
    await page.getByRole("button", { name: "Cancel" }).click();
  }

  step = "choosing a circular pattern's axis";
  await tool("Circular");
  const axisBox = '.feature-dialog fieldset[aria-label="Axis"]';
  await page.waitForSelector(`${axisBox} >> text=Click a round face, an edge or a sketch line in the view`, { timeout: 5_000 });
  await page.locator(axisBox).getByRole("radio", { name: "Z" }).click();
  await page.waitForSelector(`${axisBox} .reference-chip >> text=Z axis`, { timeout: 5_000 });
  await page.getByRole("button", { name: "Cancel" }).click();

  step = "opening the hole tool";
  await tool("Hole");
  await page.waitForSelector(".feature-dialog >> text=Where and what");
  await page.locator("#hole-standard").selectOption("M4");
  if ((await page.locator("#param-diameter").inputValue()) !== "4.5") throw new Error("choosing M4 didn't fill in the 4.5 mm clearance size");
  await page.getByRole("radio", { name: "Tapped" }).click();
  if ((await page.locator("#param-diameter").inputValue()) !== "3.3") throw new Error("tapped M4 should be a 3.3 mm drill");
  await page.getByRole("radio", { name: "Up to next" }).click();
  if ((await page.locator("#param-depth").count()) !== 0) throw new Error("up to next shouldn't ask for a depth");
  if ((await page.locator("#param-threadDepth").count()) !== 1) throw new Error("a tapped hole should have a thread depth box");
  await page.getByLabel("Model the thread (for 3D printing)").check();
  await page.getByRole("button", { name: "Cancel" }).click();

  step = "moving a copy of a part";
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await page.waitForSelector(".feature-dialog >> text=Make a copy");
  await page.getByLabel("Make a copy (keep the original where it is)").check();
  await page.locator("#param-dz").fill("60");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForSelector(".feature-row:not(.datum) >> text=Transform 1", { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector(".part-list")?.textContent?.includes("Part 4"), null, { timeout: 30_000 });
  if ((await page.locator(".feature-row.failed").count()) > 0) {
    throw new Error(`the move failed: ${await page.locator(".feature-row.failed").first().getAttribute("title")}`);
  }

  step = "adding a variable";
  await tool("Variables");
  await page.getByRole("button", { name: "+ Add variable" }).click();
  await page.getByRole("textbox", { name: "Variable name" }).fill("gap");
  await page.getByRole("textbox", { name: "Value of gap" }).fill("1/4 in");
  const worksOut = await page.locator(".variable-result").first().innerText();
  if (!/6\.35 mm/.test(worksOut)) throw new Error(`the variable worked out as "${worksOut}"`);
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForSelector(".variables-table", { state: "detached" });

  step = "configurations";
  await tool("Configurations");
  await page.getByLabel("New configuration name").fill("Wide gap");
  await page.getByRole("button", { name: "+ Add configuration" }).click();
  await page.waitForFunction(() => document.querySelectorAll('.configurations-table input[aria-label="Configuration name"]').length === 2, null, { timeout: 5_000 });
  await page.getByRole("button", { name: "Done" }).click();
  // In "Wide gap", gap = 2 mm; back in Default it's 1/4 in again.
  await tool("Variables");
  await page.getByRole("textbox", { name: "Value of gap" }).fill("2");
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForSelector(".variables-table", { state: "detached" });
  const defaultId = await page.locator("#configuration-select option", { hasText: "Default" }).getAttribute("value");
  await page.locator("#configuration-select").selectOption(defaultId);
  await tool("Variables");
  const gapNow = await page.getByRole("textbox", { name: "Value of gap" }).inputValue();
  if (gapNow !== "1/4 in") throw new Error(`back in Default, gap is "${gapNow}"`);
  await page.getByRole("button", { name: "Cancel" }).click();
  await page.waitForSelector(".variables-table", { state: "detached" });

  step = "saving the design to a file";
  const featureCount = await page.locator(".feature-row:not(.datum)").count();
  const savePromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "Save", exact: true }).click();
  const saved = await savePromise;
  const savedPath = await saved.path();
  const savedText = readFileSync(savedPath, "utf8");
  if (!saved.suggestedFilename().endsWith(".juracad")) throw new Error(`saved as ${saved.suggestedFilename()}`);
  // The format id inside the file keeps the app's old name, so files open in older versions too.
  if (!/"format": "partsmith"/.test(savedText) || !/"gap"/.test(savedText)) throw new Error("the saved file is missing the design or its variables");
  await page.waitForSelector(".save-state:not(.unsaved)");

  step = "starting a new design, then opening the saved file";
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "New", exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll(".feature-row:not(.datum)").length === 0);
  const chooserPromise = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("button", { name: "Open", exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles(savedPath);
  await page.waitForFunction((n) => document.querySelectorAll(".feature-row:not(.datum)").length === n, featureCount, { timeout: 10_000 });
  await page.waitForFunction(() => document.querySelector(".part-list")?.textContent?.includes("Part 3"), null, { timeout: 30_000 });

  step = "importing the STEP and STL files exported earlier";
  const importModel = async (file, label) => {
    const before = await page.locator(".part-row").count();
    const failedBefore = await page.locator(".feature-row.failed").count();
    const importChooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await (await importChooser).setFiles(file);
    await page.waitForSelector('form[aria-label="Import feature"]', { timeout: 10_000 });
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForSelector('form[aria-label="Import feature"]', { state: "detached" });
    await page.waitForFunction((n) => document.querySelectorAll(".part-row").length > n, before, { timeout: 60_000 });
    const failed = await page.locator(".feature-row.failed").count();
    if (failed > failedBefore) throw new Error(`importing ${label} left a feature with a problem`);
    return (await page.locator(".part-row").count()) - before;
  };
  const stepParts = await importModel(await stepDownload.path(), "STEP");
  const stlParts = await importModel(path, "STL");
  await shot("imported");

  step = "selecting several parts by dragging down the Parts list";
  {
    const rows = page.locator(".part-row .feature-name");
    const first = await rows.nth(0).boundingBox();
    const third = await rows.nth(2).boundingBox();
    await page.mouse.move(first.x + 20, first.y + first.height / 2);
    await page.mouse.down();
    await page.mouse.move(first.x + 20, first.y + first.height, { steps: 4 });
    await page.mouse.move(third.x + 20, third.y + third.height / 2, { steps: 8 });
    await page.mouse.up();
    const picked = await page.locator(".part-row.selected").count();
    if (picked !== 3) throw new Error(`dragging down the Parts list selected ${picked} parts, not 3`);
    await page.waitForSelector(".parts-selection-bar >> text=3 parts selected");
    await shot("partselect");
    await page.getByRole("button", { name: "Export", exact: true }).first().click();
    await page.waitForSelector('#export-parts option[value="selected"]', { state: "attached" });
    if ((await page.locator("#export-parts").inputValue()) !== "selected") throw new Error("the export didn't start with the selected parts");
    await page.keyboard.press("Escape");
    const clear = page.getByRole("button", { name: "Clear selection" });
    if (await clear.count()) await clear.click();
    if ((await page.locator(".part-row.selected").count()) !== 0) throw new Error("the part selection didn't clear");
    // Picking a part lights up the features that made it.
    await page.locator(".part-row .feature-name").first().click();
    if ((await page.locator(".feature-row.linked").count()) < 1) throw new Error("picking a part didn't light up its features");
    // Duplicate it (right-click › Duplicate…, then accept the Move/copy dialog).
    const partsBefore = await page.locator(".part-row").count();
    await page.locator(".part-row .feature-name").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Duplicate…" }).click();
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".part-row").length === n + 1, partsBefore, { timeout: 30_000 });
    await shot("duplicated");
    await page.keyboard.press("Escape");
  }

  step = "making an assembly";
  await page.getByRole("button", { name: "Add a tab" }).click();
  await page.getByRole("menuitem", { name: "Assembly" }).click();
  await page.waitForSelector('[aria-label="Assembly tools"]');
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  await page.getByRole("button", { name: "Insert Part 1", exact: true }).click();
  await page.getByRole("button", { name: "Insert Part 1", exact: true }).click();
  await page.getByRole("button", { name: "Insert Part 2", exact: true }).click();
  await page.waitForSelector(".feature-row >> text=Part 1 <2>");
  const bom = await page.locator(".bom-table").innerText();
  if (!/Part 1\s+2\b/.test(bom) || !/Part 2\s+1\b/.test(bom)) throw new Error(`the parts list reads "${bom.replace(/\n/g, " / ")}"`);
  await page.getByRole("button", { name: "Done" }).click();
  await page.locator(".feature-row >> text=Part 1 <2>").click();
  await page.getByLabel("Z (blue)", { exact: true }).fill("30");
  await page.getByLabel("Z (blue)", { exact: true }).press("Enter");
  await page.getByLabel("Z", { exact: true }).fill("90");
  await page.getByLabel("Z", { exact: true }).press("Enter");
  await page.waitForTimeout(300);
  if ((await page.getByLabel("Z (blue)", { exact: true }).inputValue()) !== "30") throw new Error("the typed position didn't stick");
  await page.evaluate(() => (document.activeElement)?.blur?.());
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await shot("assembly");
  const instanceCount = await page.locator(".feature-row").count();

  step = "fastening two parts together with a mate";
  // Where the top faces of Part 1 <2> and Part 2 <1> are on screen (Part 1 <1> sits under the dialog).
  const tops = await page.evaluate(() => {
    const v = window.juracadViewport.current;
    return v.shownParts().slice(1, 3).map((p) => {
      const i = p.faceRefs.findIndex((f) => f.surface === "PLANE" && f.normal[2] > 0.99);
      return v.screenPointOnFace(p.id, i);
    });
  });
  if (tops.some((t) => !t)) throw new Error("couldn't find the top faces to click");
  const canvas = page.locator(".viewport-canvas");
  await page.getByRole("button", { name: "Fasten", exact: true }).click();
  await page.waitForSelector('form[aria-label="Mate"]');
  const dialogBox = await page.locator('form[aria-label="Mate"]').boundingBox();
  const canvasBox = await canvas.boundingBox();
  for (const t of tops) {
    if (dialogBox && canvasBox && t.x + canvasBox.x < dialogBox.x + dialogBox.width && t.y + canvasBox.y < dialogBox.y + dialogBox.height) throw new Error(`a face to click (${Math.round(t.x)}, ${Math.round(t.y)}) is under the mate dialog`);
  }
  await canvas.click({ position: tops[0] });
  await canvas.click({ position: tops[1] });
  await page.waitForSelector(".connector-slot.filled >> nth=1", { timeout: 5_000 });
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForSelector('form[aria-label="Mate"]', { state: "detached" });
  await page.waitForSelector(".panel-section.mates .feature-row >> text=Fasten 1");
  if ((await page.locator(".panel-section.mates .feature-row.failed").count()) > 0) {
    throw new Error(`the mate has a problem: ${await page.locator(".panel-section.mates .feature-row.failed").first().getAttribute("title")}`);
  }
  await page.locator(".feature-row >> text=Part 2 <1>").click();
  await page.waitForSelector(".instance-panel >> text=Placed by");
  await page.keyboard.press("Escape");
  await page.keyboard.press("f");
  await page.waitForTimeout(600);
  await shot("mated");

  step = "using the Isometric button";
  await page.getByRole("button", { name: "Isometric", exact: true }).click();
  await page.waitForTimeout(400);

  step = "dragging a part with the mouse";
  await page.locator(".feature-row >> text=Part 1 <1>").click();
  await page.getByRole("button", { name: "Unfix", exact: true }).click();
  const xBefore = await page.getByLabel("X (red)", { exact: true }).inputValue();
  await page.keyboard.press("Escape");
  const grabAt = await page.evaluate(() => {
    const v = window.juracadViewport.current;
    const p = v.shownParts()[0];
    return v.screenPointOnFace(p.id, p.faceRefs.findIndex((f) => f.surface === "PLANE" && f.normal[2] > 0.99));
  });
  const cb = await canvas.boundingBox();
  await page.mouse.move(cb.x + grabAt.x, cb.y + grabAt.y);
  await page.mouse.down();
  await page.mouse.move(cb.x + grabAt.x - 40, cb.y + grabAt.y + 25, { steps: 6 });
  await page.mouse.up();
  await page.waitForSelector(".instance-panel");
  await page
    .waitForFunction((before) => document.querySelector("#instance-x-red-")?.value !== before, xBefore, { timeout: 5_000 })
    .catch(() => {});
  const xAfter = await page.getByLabel("X (red)", { exact: true }).inputValue();
  if (xAfter === xBefore) {
    const toast = (await page.locator(".toast").allInnerTexts()).join(" / ");
    const debug = await page.evaluate(() => window.juracadViewport.current?.lastDragDebug ?? "");
    throw new Error(`dragging didn't move the part (X stayed ${xBefore}) at (${Math.round(grabAt.x)}, ${Math.round(grabAt.y)}); message: ${toast || "none"}; ${debug}`);
  }
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Part Studio 1" }).click();
  await page.waitForSelector('[aria-label="Tools"]');

  step = "renaming a part";
  await page.locator(".part-row >> text=Part 1").first().dblclick();
  await page.getByLabel("New name for Part 1").fill("Bracket");
  await page.getByLabel("New name for Part 1").press("Enter");
  await page.waitForSelector(".part-row >> text=Bracket", { timeout: 30_000 });
  await page.getByRole("button", { name: "Assembly 1" }).click();
  await page.waitForSelector(".feature-row >> text=Bracket <2>");
  if (!/Bracket/.test(await page.locator(".bom-table").innerText())) throw new Error("the parts list didn't pick up the new name");
  await page.getByRole("button", { name: "Part Studio 1" }).click();

  step = "checking and exporting the assembly";
  await page.getByRole("button", { name: "Assembly 1" }).click();
  await page.getByRole("button", { name: "Check model" }).click();
  await page.waitForSelector(".check-headline", { timeout: 30_000 });
  const asmHeadline = await page.locator(".check-headline").innerText();
  await shot("assembly-check");
  // The clash check's choices: list touching parts too, then put it back.
  await page.getByLabel("Touching tolerance").waitFor({ timeout: 5_000 });
  await page.getByLabel("Ignore parts that only touch").uncheck();
  await page.waitForSelector(".check-headline", { timeout: 30_000 });
  await page.getByLabel("Ignore parts that only touch").check();
  await page.waitForSelector(".check-headline", { timeout: 30_000 });
  await page.getByRole("button", { name: "Close" }).first().click();

  step = "suppressing a part";
  await page.locator(".feature-row >> text=Part 2 <1>").click();
  await page.getByRole("button", { name: "Suppress", exact: true }).click();
  await page.waitForSelector(".feature-row.suppressed >> text=Part 2 <1>", { timeout: 5_000 });
  const bomOff = await page.locator(".bom-table").innerText();
  if (/Part 2/.test(bomOff)) throw new Error(`a suppressed part is still in the parts list: "${bomOff.replace(/\n/g, " / ")}"`);
  await page.waitForSelector(".panel-section.mates .feature-row.suppressed >> text=Fasten 1", { timeout: 5_000 });
  await page.locator(".feature-row >> text=Part 2 <1>").click();
  await page.getByRole("button", { name: "Unsuppress", exact: true }).click();
  await page.waitForFunction(() => /Part 2/.test(document.querySelector(".bom-table")?.textContent ?? ""), null, { timeout: 5_000 });
  if ((await page.locator(".panel-section.mates .feature-row.failed").count()) > 0) throw new Error("the mate broke after unsuppressing its part");
  await page.keyboard.press("Escape");

  step = "giving a part a part number";
  await page.locator(".bom-table tr", { hasText: "Part 2" }).dblclick();
  const propsDialog = page.getByRole("dialog", { name: /Properties of Part 2/ });
  await propsDialog.getByLabel("Part number").fill("PS-002");
  await propsDialog.getByLabel("Description").fill("Top block");
  await propsDialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => /PS-002/.test(document.querySelector(".bom-table")?.textContent ?? ""), null, { timeout: 5_000 });
  if (!/Top block/.test(await page.locator(".bom-table").innerText())) throw new Error("the parts list didn't show the description");
  // Emptying the boxes takes them off again (and keeps the parts list as later steps expect it).
  await page.locator(".bom-table tr", { hasText: "Part 2" }).dblclick();
  await propsDialog.getByLabel("Part number").fill("");
  await propsDialog.getByLabel("Description").fill("");
  await propsDialog.getByRole("button", { name: "Save", exact: true }).click();
  await page.waitForFunction(() => !/PS-002|Top block/.test(document.querySelector(".bom-table")?.textContent ?? ""), null, { timeout: 5_000 });
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await page.waitForSelector('#export-parts option[value="all"]', { state: "attached" });
  const allOption = await page.locator('#export-parts option[value="all"]').innerText();
  if (!/whole assembly/.test(allOption)) throw new Error(`the export choice reads "${allOption}"`);
  const asmDownload = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: /Check & export/ }).click();
  // Clashes only warn; export anyway if asked.
  const anyway = page.getByRole("button", { name: "Export anyway" });
  await Promise.race([asmDownload, anyway.waitFor({ timeout: 60_000 }).then(() => anyway.click()).catch(() => {})]);
  const asmStep = await asmDownload;
  const asmStepText = readFileSync(await asmStep.path(), "utf8");
  if (!/PRODUCT\('Bracket <2>'/.test(asmStepText)) throw new Error("the assembly STEP file doesn't name its parts");
  step = "exploding the assembly";
  await page.getByRole("button", { name: "Explode", exact: true }).click();
  await page.waitForSelector('[aria-label="Exploded view"]', { timeout: 5_000 });
  await page.locator("#explode-spread").fill("2");
  await page.locator("#explode-spread").dispatchEvent("pointerup");
  await page.waitForFunction(() => document.querySelector('[aria-label="Exploded view"] .field-label')?.textContent?.includes("200%"));
  await shot("exploded");
  step = "adding an exploded view step";
  await page.locator(".feature-row >> text=Part 2 <1>").click();
  await page.getByRole("button", { name: /Move the selected part/ }).click();
  await page.waitForSelector(".explode-step >> text=Part 2 <1>", { timeout: 5_000 });
  step = "patterning a part in the assembly";
  await page.getByRole("button", { name: "Explode", exact: true }).click();
  await page.locator(".feature-row >> text=Part 2 <1>").click();
  await tool("Pattern");
  await page.waitForSelector('[aria-label="Pattern Pattern 1"]', { timeout: 5_000 });
  await page.getByLabel("How many (including the original)").fill("4");
  await page.getByLabel("How many (including the original)").press("Enter");
  await page.waitForSelector(".feature-row >> text=Part 2 <4>", { timeout: 5_000 });
  if (!/Part 2\s+4\b/.test(await page.locator(".bom-table").innerText())) throw new Error("the parts list didn't count the pattern's copies");
  await page.keyboard.press("f");
  await page.waitForTimeout(400);
  await shot("pattern");
  await page.getByRole("button", { name: "Delete pattern (and its copies)" }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll(".feature-row")].some((r) => r.textContent?.includes("Part 2 <2>")), null, { timeout: 5_000 });
  step = "grouping parts in the assembly";
  {
    await page.locator(".feature-row >> text=Part 2 <1>").click();
    await page.locator(".feature-row >> text=Bracket <2>").click({ modifiers: ["Shift"] });
    await page.getByRole("button", { name: "Group", exact: true }).click();
    await page.waitForSelector(".panel-section.groups .feature-row >> text=Group 1", { timeout: 5_000 });
    await shot("group");
    // Its row's buttons show on hover.
    await page.locator(".panel-section.groups .feature-row").first().hover();
    await page.getByRole("button", { name: "Ungroup Group 1" }).click();
    await page.waitForSelector(".panel-section.groups", { state: "detached", timeout: 5_000 });
  }
  step = "duplicating a part in the assembly";
  {
    await page.locator(".feature-row >> text=Part 2 <1>").click();
    await tool("Duplicate");
    await page.waitForSelector(".feature-row >> text=Part 2 <2>", { timeout: 5_000 });
    // The copy is selected: delete it again so the rest of the test sees the same assembly.
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".feature-row")].some((r) => r.textContent?.includes("Part 2 <2>")), null, { timeout: 5_000 });
  }
  step = "putting an assembly inside another (sub-assemblies)";
  let subReport = "";
  {
    // Assembly 2: two copies of Assembly 1 (Bracket ×2 and Part 2, fastened) and a Part 2 of its own.
    await page.getByRole("button", { name: "Add a tab" }).click();
    await page.getByRole("menuitem", { name: "Assembly" }).click();
    await page.waitForSelector(".tab.active >> text=Assembly 2");
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    // Assembly 2 can't go inside itself: only Assembly 1 is offered.
    if ((await page.getByRole("button", { name: "Insert Assembly 2", exact: true }).count()) !== 0) throw new Error("an assembly is offered for inserting into itself");
    await page.getByRole("button", { name: "Insert Assembly 1", exact: true }).click();
    await page.getByRole("button", { name: "Insert Assembly 1", exact: true }).click();
    await page.getByRole("button", { name: "Insert Part 2", exact: true }).click();
    await page.waitForSelector(".feature-row >> text=Assembly 1 <2>");
    await page.getByRole("button", { name: "Done" }).click();
    const flat = await page.locator(".bom-table").innerText();
    if (!/Bracket\s+4\b/.test(flat) || !/Part 2\s+3\b/.test(flat)) throw new Error(`the flattened parts list reads "${flat.replace(/\n/g, " / ")}"`);
    // Its parts show in the list under it.
    await page.getByRole("button", { name: "Show the parts in Assembly 1 <1>" }).click();
    await page.waitForSelector(".feature-row.nested >> text=Bracket <2>", { timeout: 5_000 });
    await page.getByRole("button", { name: "Hide the parts in Assembly 1 <1>" }).click();
    await page.keyboard.press("f");
    await page.waitForTimeout(600);
    await shot("subassembly");

    // Fasten Part 2 <1> to the top of a part inside the second copy: the whole copy moves.
    const asm2 = await page.evaluate(() => {
      const s = window.juracadStore.getState();
      const a = s.history.present.assemblies.find((x) => x.name === "Assembly 2");
      return { id: a.id, second: a.instances.find((i) => i.name === "Assembly 1 <2>").id, own: a.instances.find((i) => i.name === "Part 2 <1>").id };
    });
    // Fix Part 2 <1>, so it's the sub-assembly that moves to meet it. (Just inserted, it may be selected already.)
    const ownRow = page.locator(".feature-row", { hasText: "Part 2 <1>" }).first();
    if (!/\bselected\b/.test((await ownRow.getAttribute("class")) ?? "")) await ownRow.click();
    await page.getByRole("button", { name: "Fix", exact: true }).click();
    await page.keyboard.press("Escape");
    const before = await page.evaluate(({ id, second }) => JSON.stringify(window.juracadStore.getState().history.present.assemblies.find((x) => x.id === id).instances.find((i) => i.id === second).placement), asm2);
    await page.getByRole("button", { name: "Fasten", exact: true }).click();
    await page.waitForSelector('form[aria-label="Mate"]');
    const spots = await page.evaluate(({ second, own }) => {
      const v = window.juracadViewport.current;
      const up = (p) => v.screenPointOnFace(p.id, p.faceRefs.findIndex((f) => f.surface === "PLANE" && f.normal[2] > 0.99));
      const shown = v.shownParts();
      const inside = shown.filter((p) => p.id.startsWith(`${second}/`)).map(up).filter(Boolean);
      return { own: up(shown.find((p) => p.id === own)), inside: inside[inside.length - 1] ?? null, keys: shown.map((p) => p.id) };
    }, asm2);
    if (!spots.own || !spots.inside) throw new Error(`couldn't find faces to mate (meshes: ${spots.keys.join(", ")})`);
    await canvas.click({ position: spots.own });
    await canvas.click({ position: spots.inside });
    await page.waitForSelector(".connector-slot.filled >> nth=1", { timeout: 5_000 });
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForSelector('form[aria-label="Mate"]', { state: "detached" });
    await page.waitForSelector(".panel-section.mates .feature-row >> text=Fasten 1");
    if ((await page.locator(".panel-section.mates .feature-row.failed").count()) > 0) {
      throw new Error(`the mate to a part inside the sub-assembly has a problem: ${await page.locator(".panel-section.mates .feature-row.failed").first().getAttribute("title")}`);
    }
    const mated = await page.evaluate(({ id, second }) => {
      const a = window.juracadStore.getState().history.present.assemblies.find((x) => x.id === id);
      const m = a.mates[0];
      return { b: m.b.instanceId, path: m.b.path ?? null, a: m.a.instanceId, placement: JSON.stringify(a.instances.find((i) => i.id === second).placement) };
    }, asm2);
    if (!mated.path?.length || (mated.a !== asm2.second && mated.b !== asm2.second)) throw new Error(`the mate isn't on a part inside the sub-assembly: ${JSON.stringify(mated)}`);
    if (mated.placement === before) throw new Error("the sub-assembly didn't move to meet the mate");
    await page.keyboard.press("f");
    await page.waitForTimeout(600);
    await shot("subassembly-mated");
    // Structured parts list: the sub-assembly on one line, what's in one of it underneath.
    await page.getByRole("button", { name: "Structured", exact: true }).click();
    const structured = await page.locator(".bom-table").innerText();
    if (!/Assembly 1\s+2\b/.test(structured) || !/1\.1\s+Bracket\s+2\b/.test(structured)) throw new Error(`the structured parts list reads "${structured.replace(/\n/g, " / ")}"`);
    await shot("subassembly-structured");
    await page.getByRole("button", { name: "Flattened", exact: true }).click();
    // Double-click a sub-assembly to open it.
    await page.locator(".feature-row >> text=Assembly 1 <1>").dblclick();
    await page.waitForSelector(".tab.active >> text=Assembly 1", { timeout: 5_000 });
    subReport = `a sub-assembly: Assembly 1 inserted twice into Assembly 2 (Bracket ×4, Part 2 ×3), mated by a part inside it (the whole copy moved), structured parts list`;
    // Take Assembly 2 away again, so the rest of the test sees the same document.
    await page.evaluate((id) => window.juracadStore.getState().removeAssembly(id), asm2.id);
    await page.waitForFunction(() => ![...document.querySelectorAll(".tab")].some((t) => t.textContent?.includes("Assembly 2")), null, { timeout: 5_000 });
    await page.getByRole("button", { name: "Assembly 1" }).click();
  }
  await page.getByRole("button", { name: "Part Studio 1" }).click();

  step = "adding a second Part Studio";
  await page.getByRole("button", { name: "Add a tab" }).click();
  await page.getByRole("menuitem", { name: "Part Studio" }).click();
  await page.waitForSelector(".tab.active >> text=Part Studio 2");
  if ((await page.locator(".feature-row:not(.datum)").count()) !== 0) throw new Error("the new Part Studio isn't empty");
  await tool("Box");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".part-row").length === 1, null, { timeout: 30_000 });
  await page.getByRole("button", { name: "Assembly 1" }).click();
  await page.getByRole("button", { name: "Insert", exact: true }).click();
  await page.waitForSelector(".insert-studio >> text=Part Studio 2");
  await page.getByRole("button", { name: "Done" }).click();
  await page.getByRole("button", { name: "Part Studio 1" }).click();
  await page.waitForFunction(() => document.querySelectorAll(".part-row").length > 1);

  step = "making a drawing";
  await page.getByRole("button", { name: "Add a tab" }).click();
  await page.getByRole("menuitem", { name: "Drawing" }).click();
  await page.waitForSelector(".tab.active >> text=Drawing 1");
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="drawing-sheet"] polyline').length > 20, null, { timeout: 60_000 });
  const viewCount = await page.locator(".drawing-view-handle").count();
  if (viewCount !== 4) throw new Error(`the drawing has ${viewCount} views, not 4`);
  await page.getByLabel("Drawn by").fill("Smoke test");
  await page.getByLabel("Drawn by").press("Enter");
  await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "Smoke test"));
  step = "dimensioning the drawing";
  await page.locator("#drawing-source").selectOption({ label: "Bracket" });
  await page.waitForFunction(() => document.querySelectorAll(".drawing-view-handle").length === 4, null, { timeout: 60_000 });
  await page.waitForTimeout(500);
  // The front view's handle is 3 mm bigger than the view all round.
  const frontBox = await page.locator(".drawing-view-handle").first().boundingBox();
  const mm = frontBox.width / (await page.locator(".drawing-view-handle").first().evaluate((el) => el.getBBox().width));
  const inset = 3 * mm;
  await tool("Dimension");
  const bottom = frontBox.y + frontBox.height - inset;
  await page.mouse.click(frontBox.x + inset, bottom);
  await page.mouse.click(frontBox.x + frontBox.width - inset, bottom);
  await page.mouse.move(frontBox.x + frontBox.width / 2, bottom + 12 * mm, { steps: 3 });
  await page.mouse.click(frontBox.x + frontBox.width / 2, bottom + 12 * mm);
  // Smart dimension: the left edge, then the right edge, gives the distance between them.
  const midY = frontBox.y + frontBox.height / 2;
  await page.mouse.click(frontBox.x + inset, midY);
  await page.mouse.click(frontBox.x + frontBox.width - inset, midY);
  await page.mouse.move(frontBox.x + frontBox.width / 2, frontBox.y - 10 * mm, { steps: 3 });
  await page.mouse.click(frontBox.x + frontBox.width / 2, frontBox.y - 10 * mm);
  await page.keyboard.press("Escape");
  await page.waitForSelector(".drawing-dim-handle", { timeout: 5_000 });
  const dimCount = await page.locator(".drawing-dim-handle").count();
  if (dimCount !== 2) throw new Error(`expected 2 dimensions (corner to corner, edge to edge), found ${dimCount}`);
  const dimTexts = await page.locator(".drawing-text").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
  const dimValue = dimTexts.find((t) => /^\d+(\.\d+)?$/.test(t));
  if (!dimValue) throw new Error(`no dimension on the drawing (texts: ${dimTexts.slice(0, 30).join(", ")})`);
  await shot("drawing");
  const dxfPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "DXF", exact: true }).click();
  const dxfText = readFileSync(await (await dxfPromise).path(), "utf8");
  if (!dxfText.includes("ENTITIES") || !dxfText.includes(`\n1\n${dimValue}\n`)) throw new Error("the DXF file doesn't look right");
  const pdfPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "PDF", exact: true }).click();
  const pdf = await pdfPromise;
  const pdfText = readFileSync(await pdf.path(), "latin1");
  if (!pdfText.startsWith("%PDF-1.4") || !pdfText.includes("(Smoke test) Tj")) throw new Error("the PDF doesn't look right");
  step = "auto dimension";
  {
    await page.getByRole("button", { name: "Auto dimension", exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll(".drawing-dim-handle").length > 4, null, { timeout: 5_000 }).catch(async () => {
      throw new Error(`auto dimension added too little (${await page.locator(".drawing-dim-handle").count()} dimensions in all)`);
    });
    autoDims = (await page.locator(".drawing-dim-handle").count()) - dimCount;
    await shot("autodim");
    // A hole seen end-on gets a hole callout (this part's hole runs off its edge, so it may have none).
    const autoTexts = await page.locator(".drawing-text").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
    holeCallout = autoTexts.find((t) => /Ø[\d.]+( THRU| × [\d.]+ DEEP)/.test(t)) ?? "none";
    // Again: nothing more to add.
    await page.getByRole("button", { name: "Auto dimension", exact: true }).click();
    await page.waitForTimeout(300);
    if ((await page.locator(".drawing-dim-handle").count()) !== dimCount + autoDims) throw new Error("auto dimension repeated itself");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".drawing-dim-handle").length === n, dimCount, { timeout: 5_000 });
  }
  step = "selecting two dimensions and deleting them";
  if (dimCount >= 2) {
    const handles = page.locator(".drawing-dim-handle");
    await handles.nth(0).click({ modifiers: ["Control"], force: true });
    await handles.nth(1).click({ modifiers: ["Control"], force: true });
    await page.waitForSelector(".drawing-panel >> text=2 selected", { timeout: 5_000 });
    await page.keyboard.press("Delete");
    await page.waitForFunction((n) => document.querySelectorAll(".drawing-dim-handle").length === n, dimCount - 2, { timeout: 5_000 });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".drawing-dim-handle").length === n, dimCount, { timeout: 5_000 });
    await page.keyboard.press("Escape");
  }
  step = "setting the 3D view's scale on the sheet";
  {
    const iso = page.locator(".drawing-view-handle").filter({ has: page.locator("title", { hasText: "3D (isometric)" }) });
    await iso.click({ force: true });
    await page.waitForSelector("#selected-view-scale", { timeout: 5_000 });
    await page.waitForSelector('[data-testid="view-resize"]', { timeout: 5_000 });
    // A scale other than the sheet's, so it's noted under the view.
    const sheetScale = (await page.locator('#selected-view-scale option[value=""]').textContent()) ?? "";
    const [value, label] = sheetScale.includes("1:5") ? ["0.5", "1:2"] : ["0.2", "1:5"];
    await page.locator("#selected-view-scale").selectOption(value);
    await page.waitForFunction((t) => [...document.querySelectorAll(".drawing-text")].some((x) => x.textContent === t), `SCALE ${label}`, { timeout: 10_000 });
    await shot("isoscale");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(() => ![...document.querySelectorAll(".drawing-text")].some((x) => (x.textContent ?? "").startsWith("SCALE ")), null, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector("#selected-view-scale"), null, { timeout: 5_000 });
  }
  step = "flipping a dimension's arrows";
  if (dimCount >= 1) {
    const lines = () => page.locator('[data-testid="drawing-sheet"] polyline').count();
    const before = await lines();
    await page.locator(".drawing-dim-handle").first().click({ force: true });
    await page.getByRole("button", { name: "Flip arrows", exact: true }).click();
    // Set outside, a long dimension gets a short line past each end (or loses them, flipped back in).
    await page.waitForFunction((n) => Math.abs(document.querySelectorAll('[data-testid="drawing-sheet"] polyline').length - n) === 2, before, { timeout: 5_000 });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="drawing-sheet"] polyline').length === n, before, { timeout: 5_000 });
    // Right-clicking its number does the same.
    await page.locator(".drawing-dim-handle").first().click({ button: "right", force: true });
    await page.waitForFunction((n) => Math.abs(document.querySelectorAll('[data-testid="drawing-sheet"] polyline').length - n) === 2, before, { timeout: 5_000 });
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction((n) => document.querySelectorAll('[data-testid="drawing-sheet"] polyline').length === n, before, { timeout: 5_000 });
    await page.keyboard.press("Escape");
  }
  step = "dragging a dimension's number (the line follows)";
  if (dimCount >= 1) {
    const id = await page.locator(".drawing-dim-handle").first().getAttribute("data-dim");
    const dimNow = () => page.evaluate((id) => window.juracadStore.getState().history.present.drawings.flatMap((d) => d.dimensions ?? []).find((x) => x.id === id), id);
    const before = await dimNow();
    if (!before || before.type !== "horizontal") throw new Error(`expected the first dimension to be horizontal, it's ${JSON.stringify(before)}`);
    // The number's own grab area (the whole of the text, not just a dot in its middle).
    const textBox = async () => {
      const b = await page.locator(`.drawing-dim-text[data-dim="${id}"]`).first().boundingBox();
      if (!b) throw new Error("the dimension's number has no grab area");
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    const start = await textBox();
    // Grab it a little off-centre: it mustn't jump to the pointer.
    const grab = { x: start.x + 1.5 * mm, y: start.y + 0.5 * mm };
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + 12 * mm, grab.y + 3 * mm, { steps: 2 });
    await page.mouse.move(grab.x + 25 * mm, grab.y + 5 * mm, { steps: 4 });
    await page.mouse.up();
    await page.waitForFunction(([id, along]) => (window.juracadStore.getState().history.present.drawings.flatMap((d) => d.dimensions ?? []).find((x) => x.id === id)?.textAlong ?? 0) !== along, [id, before.textAlong ?? 0], { timeout: 5_000 });
    const after = await dimNow();
    // 25 mm along (to the right), 5 mm further out (down the screen, below the part): the line moves with it.
    const along = (after.textAlong ?? 0) - (before.textAlong ?? 0);
    const out = after.offset - before.offset;
    if (Math.abs(along - 25) > 0.4 || Math.abs(out + 5) > 0.4) throw new Error(`dragging the number moved it ${along} mm along and the line ${out} mm (expected 25 and -5)`);
    const end = await textBox();
    if (Math.abs(end.x - start.x - 25 * mm) > 0.5 * mm || Math.abs(end.y - start.y - 5 * mm) > 0.5 * mm) {
      throw new Error(`the number moved ${(end.x - start.x) / mm} mm across and ${(end.y - start.y) / mm} mm down on screen (expected 25 and 5)`);
    }
    // The dimension line is drawn 1.2 mm under the number's baseline: find it on the sheet at its new height.
    const lineFound = await page.evaluate((id) => {
      const poly = document.querySelector(`.drawing-dim-text[data-dim="${id}"]`);
      const ys = poly.getAttribute("points").trim().split(/[\s,]+/).map(Number).filter((_, i) => i % 2 === 1);
      // (The grab area reaches 0.8 mm below the baseline; SVG y runs down.)
      const lineY = Math.max(...ys) - 0.8 + 1.2;
      return [...document.querySelectorAll('[data-testid="drawing-sheet"] polyline')].some((pl) => {
        const v = pl.getAttribute("points").trim().split(/[\s,]+/).map(Number);
        return v.length === 4 && Math.abs(v[1] - lineY) < 0.02 && Math.abs(v[3] - lineY) < 0.02 && Math.abs(v[0] - v[2]) > 5;
      });
    }, id);
    if (!lineFound) throw new Error("the dimension line didn't follow the number");
    await shot("dimdrag");
    await page.getByRole("button", { name: "Undo", exact: true }).click();
    await page.waitForFunction(([id, offset]) => window.juracadStore.getState().history.present.drawings.flatMap((d) => d.dimensions ?? []).find((x) => x.id === id)?.offset === offset, [id, before.offset], { timeout: 5_000 });
    await page.keyboard.press("Escape");
  }
  step = "baseline, chain and ordinate tools";
  for (const name of ["Baseline", "Chain", "Ordinate"]) {
    await tool(name);
    await page.waitForFunction(() => document.body.textContent?.includes("Click the datum"), null, { timeout: 5_000 });
  }
  await page.keyboard.press("Escape");
  step = "adding a GD&T tolerance frame";
  {
    const box = await page.locator(".drawing-view-handle").first().boundingBox();
    await tool("Tolerance frame");
    await page.mouse.click(box.x + box.width / 2, box.y + 2);
    await page.mouse.click(box.x + box.width / 2 + 15 * mm, box.y - 12 * mm);
    await page.waitForSelector("#fcf-characteristic", { timeout: 5_000 });
    await page.locator("#fcf-characteristic").selectOption("parallelism");
    await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "0.1"), null, { timeout: 5_000 });
    await shot("gdt");
    await page.keyboard.press("Escape");
  }
  step = "adding a section view";
  // Draw a cutting line across the top view (the second view), left to right through its middle.
  const topBox = await page.locator(".drawing-view-handle").nth(1).boundingBox();
  await tool("Section");
  const cutY = topBox.y + topBox.height * 0.5;
  await page.mouse.click(topBox.x + topBox.width * 0.06, cutY);
  await page.mouse.click(topBox.x + topBox.width * 0.94, cutY + 1);
  await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "SECTION A-A"), null, { timeout: 60_000 });
  await shot("drawsection");
  step = "adding a detail view";
  {
    const frontNow = await page.locator(".drawing-view-handle").first().boundingBox();
    await tool("Detail");
    const cxp = frontNow.x + frontNow.width * 0.8;
    const cyp = frontNow.y + frontNow.height * 0.3;
    await page.mouse.click(cxp, cyp);
    await page.mouse.move(cxp + 15, cyp, { steps: 3 });
    await page.mouse.click(cxp + 15, cyp);
    await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => /^DETAIL [A-Z]/.test(t.textContent ?? "")), null, { timeout: 10_000 });
    await shot("detail");
  }
  step = "adding a broken-out view";
  {
    // On the front view: an area in the middle, cut away halfway through.
    const frontNow = await page.locator(".drawing-view-handle").first().boundingBox();
    await tool("Broken-out");
    await page.mouse.click(frontNow.x + frontNow.width * 0.3, frontNow.y + frontNow.height * 0.35);
    await page.mouse.move(frontNow.x + frontNow.width * 0.6, frontNow.y + frontNow.height * 0.65, { steps: 3 });
    await page.mouse.click(frontNow.x + frontNow.width * 0.6, frontNow.y + frontNow.height * 0.65);
    await page.waitForSelector('[aria-label="Broken-out cut 1 depth"]', { timeout: 10_000 });
    await page.waitForTimeout(3000);
    await shot("breakout");
  }
  step = "adding an auxiliary view";
  {
    // Look square-on to a slanted line across the front view.
    const frontNow = await page.locator(".drawing-view-handle").first().boundingBox();
    await tool("Auxiliary view");
    await page.mouse.click(frontNow.x + frontNow.width * 0.2, frontNow.y + frontNow.height * 0.8);
    await page.mouse.click(frontNow.x + frontNow.width * 0.8, frontNow.y + frontNow.height * 0.2);
    await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => /^VIEW [A-Z]$/.test(t.textContent ?? "")), null, { timeout: 60_000 });
    await shot("auxview");
  }
  step = "shortening the front view";
  {
    const frontNow = await page.locator(".drawing-view-handle").first().boundingBox();
    const before = frontNow.width;
    await tool("Shortened view");
    await page.mouse.click(frontNow.x + frontNow.width * 0.35, frontNow.y + frontNow.height * 0.5);
    await page.mouse.click(frontNow.x + frontNow.width * 0.65, frontNow.y + frontNow.height * 0.5);
    await page.waitForSelector('[aria-label="Remove break 1"]', { timeout: 10_000 });
    await page.waitForTimeout(500);
    const after = (await page.locator(".drawing-view-handle").first().boundingBox()).width;
    if (!(after < before - 5)) throw new Error(`the front view didn't get shorter (${Math.round(before)} → ${Math.round(after)} px)`);
    await shot("shortened");
  }
  step = "adding a second sheet";
  {
    await page.getByRole("button", { name: "+ Sheet", exact: true }).click();
    await page.waitForSelector('[role="tab"][aria-selected="true"]:has-text("Sheet 2")', { timeout: 5_000 });
    await page.locator(".drawing-panel").getByLabel("Top", { exact: true }).check();
    await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "2 OF 2"), null, { timeout: 60_000 });
    await page.waitForFunction(() => document.querySelectorAll(".drawing-view-handle").length === 1, null, { timeout: 60_000 });
    // Its view at its own scale, noted under it.
    await page.locator('select[id^="view-scale-"]').first().selectOption("0.1");
    await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "SCALE 1:10"), null, { timeout: 10_000 });
    await shot("sheet2");
    // The PDF has both sheets, a page each.
    const pdf2Promise = page.waitForEvent("download", { timeout: 60_000 });
    await page.getByRole("button", { name: "PDF", exact: true }).click();
    const pdf2 = readFileSync(await (await pdf2Promise).path(), "latin1");
    if (!pdf2.includes("/Count 2") || !pdf2.includes("(1 OF 2) Tj") || !pdf2.includes("(2 OF 2) Tj")) throw new Error("the PDF doesn't have both sheets");
    await page.getByRole("tab", { name: "Sheet 1", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "1 OF 2"), null, { timeout: 60_000 });
  }
  step = "drawing the assembly";
  await page.locator("#drawing-source").selectOption({ label: "Assembly 1" });
  await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "QTY"), null, { timeout: 60_000 });
  await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "SECTION A-A"), null, { timeout: 60_000 });
  await page.getByLabel("Exploded (parts spread apart)").check();
  await page.waitForSelector(".drawing-busy, .drawing-sheet", { timeout: 5_000 }).catch(() => {});
  await page.waitForTimeout(3000);
  await shot("asmdrawing");
  step = "zooming the drawing sheet never zooms the page";
  {
    // A wheel listener on the window runs last, so it sees whether the app stopped the browser's own zoom.
    await page.evaluate(() => {
      window.__wheels = [];
      window.addEventListener("wheel", (e) => window.__wheels.push({ prevented: e.defaultPrevented, ctrl: e.ctrlKey }), { passive: true });
    });
    const sheet = page.locator('[data-testid="drawing-sheet"]');
    const viewBox = () => sheet.getAttribute("viewBox");
    const width = async () => Number((await viewBox()).split(" ")[2]);
    const pageZoom = () => page.evaluate(() => [window.visualViewport?.scale ?? 1, window.devicePixelRatio]);
    const zoomBefore = await pageZoom();
    const w0 = await width();
    // A pinch (Chrome sends it as Ctrl + wheel), fired straight at the sheet.
    const pinch = await page.evaluate(() => {
      const svg = document.querySelector('[data-testid="drawing-sheet"]');
      const r = svg.getBoundingClientRect();
      const e = new WheelEvent("wheel", { deltaY: -20, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true });
      svg.dispatchEvent(e);
      return e.defaultPrevented;
    });
    if (!pinch) throw new Error("a pinch on the drawing sheet wasn't stopped (the page would zoom)");
    await page.waitForFunction((w) => Number(document.querySelector('[data-testid="drawing-sheet"]').getAttribute("viewBox").split(" ")[2]) < w, w0, { timeout: 5_000 });
    // The real thing: Ctrl held and the mouse wheel turned over the sheet.
    const box = await sheet.boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const w1 = await width();
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -200);
    await page.keyboard.up("Control");
    await page.waitForFunction((w) => Number(document.querySelector('[data-testid="drawing-sheet"]').getAttribute("viewBox").split(" ")[2]) < w, w1, { timeout: 5_000 });
    // Zoomed in as far as it goes: still stopped.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, -500);
      await page.keyboard.up("Control");
    }
    await page.waitForTimeout(300);
    if ((await width()) !== 20) throw new Error(`the sheet should stop zooming in at 20 mm across, it's at ${await width()}`);
    const wheels = await page.evaluate(() => window.__wheels);
    const ctrlWheels = wheels.filter((w) => w.ctrl);
    if (ctrlWheels.length < 10 || ctrlWheels.some((w) => !w.prevented)) throw new Error(`Ctrl + wheel over the sheet wasn't always stopped: ${JSON.stringify(wheels)}`);
    const zoomAfter = await pageZoom();
    if (zoomAfter[0] !== zoomBefore[0] || zoomAfter[1] !== zoomBefore[1]) throw new Error(`the page zoomed: ${zoomBefore} → ${zoomAfter}`);
    // Safari's pinch events are stopped on the sheet too.
    const gesture = await page.evaluate(() => {
      const svg = document.querySelector('[data-testid="drawing-sheet"]');
      const e = new Event("gesturestart", { bubbles: true, cancelable: true });
      svg.dispatchEvent(e);
      return e.defaultPrevented;
    });
    if (!gesture) throw new Error("Safari's pinch on the sheet wasn't stopped");
    // Elsewhere (the panel beside the sheet) the page can still be zoomed as usual.
    const elsewhere = await page.evaluate(() => {
      const panel = document.querySelector(".drawing-panel");
      const e = new WheelEvent("wheel", { deltaY: -20, ctrlKey: true, bubbles: true, cancelable: true });
      panel.dispatchEvent(e);
      return e.defaultPrevented;
    });
    if (elsewhere) throw new Error("Ctrl + wheel over the drawing panel was stopped too (only the sheet should be)");
  }
  step = "opening what's new";
  await page.locator(".phase-badge").click();
  await page.waitForSelector(".whats-new-list li", { timeout: 5_000 });
  await shot("whatsnew");
  await page.keyboard.press("Escape");
  step = "switching to inches";
  await page.getByRole("button", { name: "Settings" }).click();
  // The menu must really be on show (not cut off by the top bar).
  const menuShows = await page.evaluate(() => {
    const r = document.querySelector('[role="radio"][aria-checked]')?.closest(".settings-menu")?.querySelector("button")?.getBoundingClientRect();
    if (!r) return false;
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit?.closest(".settings-menu");
  });
  if (!menuShows) throw new Error("the Settings menu is hidden behind something");
  await page.getByRole("radio", { name: "Inches" }).click();
  await page.keyboard.press("Escape");
  // The title block now says inches.
  await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "in"), null, { timeout: 10_000 });
  await page.getByRole("button", { name: "Part Studio 1" }).click();
  await tool("Box");
  const widthBox = await page.locator("#param-width").inputValue();
  if (widthBox !== "1.5") throw new Error(`a new box in inches starts ${widthBox} wide, not 1.5`);
  await shot("inches");
  await page.getByRole("button", { name: "Cancel" }).click();
  step = "dark mode";
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("radio", { name: "Dark" }).click();
  await page.keyboard.press("Escape");
  if ((await page.evaluate(() => document.documentElement.dataset.theme)) !== "dark") throw new Error("dark mode didn't switch on");
  await shot("dark");
  await page.getByRole("button", { name: "Drawing 1" }).click();
  await page.waitForTimeout(1500);
  await shot("darkdrawing");
  await page.getByRole("button", { name: "Assembly 1" }).click();
  await page.waitForTimeout(1000);
  await shot("darkassembly");
  await page.getByRole("button", { name: "Part Studio 1" }).click();

  step = "rolling back the feature list";
  {
    const before = await page.locator(".part-row").count();
    await page.locator(".feature-row:not(.datum)").first().click({ button: "right" });
    await page.getByRole("menuitem", { name: "Roll back to here" }).click();
    await page.locator(".rollback-bar").waitFor({ timeout: 5_000 });
    await page.waitForFunction((n) => document.querySelectorAll(".part-row").length < n, before, { timeout: 30_000 });
    await page.getByRole("button", { name: "Roll to end" }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".part-row").length === n, before, { timeout: 30_000 });
  }

  step = "measuring between two parts";
  {
    await page.keyboard.press("Escape");
    const spots = await page.evaluate(() => {
      const v = window.juracadViewport.current;
      // A spot on each of two parts that really is that part when clicked (not hidden behind another).
      const out = [];
      for (const p of v.shownParts()) {
        for (let i = 0; i < p.faceRefs.length && out.length < 2; i++) {
          const at = v.screenPointOnFace(p.id, i);
          const hit = at && v.pickAt(at.x, at.y);
          if (hit?.kind === "part" && hit.item.partId === p.id && hit.item.kind === "face") {
            out.push({ id: p.id, at });
            break;
          }
        }
        if (out.length === 2) break;
      }
      return out;
    });
    if (spots.length < 2) throw new Error("couldn't find two parts' top faces to measure between");
    const cvs = await page.locator(".viewport canvas").first().boundingBox();
    await page.mouse.click(cvs.x + spots[0].at.x, cvs.y + spots[0].at.y);
    await page.keyboard.down("Shift");
    await page.mouse.click(cvs.x + spots[1].at.x, cvs.y + spots[1].at.y);
    await page.keyboard.up("Shift");
    await page.waitForFunction(() => document.querySelector(".measure-panel")?.textContent?.includes("Closest distance"), null, { timeout: 10_000 }).catch(async () => {
      const sel = await page.evaluate(() => JSON.stringify(window.juracadStore.getState().selection));
      const panel = await page.locator(".measure-panel").innerText().catch(() => "(no measure panel)");
      throw new Error(`measuring between ${spots[0].id} and ${spots[1].id} showed no distance. Selection ${sel}; panel: ${panel.replace(/\n/g, " | ")}`);
    });
    await shot("measureparts");
    await page.keyboard.press("Escape");
    // Whole parts picked in the Parts list are measured too.
    await page.locator(".part-row .feature-name").nth(0).click();
    await page.locator(".part-row .feature-name").nth(1).click({ modifiers: ["Control"] });
    await page.waitForFunction(() => document.querySelector(".measure-panel")?.textContent?.includes("volume"), null, { timeout: 10_000 }).catch(async () => {
      const panel = await page.locator(".measure-panel").innerText().catch(() => "(no measure panel)");
      throw new Error(`two parts picked in the Parts list showed no measurements: ${panel.replace(/\n/g, " | ")}`);
    });
    const clearParts = page.getByRole("button", { name: "Clear selection" });
    if (await clearParts.count()) await clearParts.click();
  }

  step = "selecting parts by dragging a box in the 3D view";
  {
    await page.keyboard.press("Escape");
    const vb = await page.locator(".viewport").boundingBox();
    const total = await page.locator(".part-row").count();
    // Right to left: a crossing box takes every part it touches.
    await page.mouse.move(vb.x + vb.width - 40, vb.y + vb.height - 40);
    await page.mouse.down();
    await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2, { steps: 4 });
    await page.mouse.move(vb.x + 40, vb.y + 60, { steps: 4 });
    if (!(await page.locator(".box-select.crossing").isVisible())) throw new Error("no selection box while dragging");
    await page.mouse.up();
    // Every part on show (some may be hidden) — at least two of them.
    await page.waitForFunction(() => document.querySelectorAll(".part-row.selected").length >= 2, null, { timeout: 5_000 }).catch(async () => {
      throw new Error(`the box selected ${await page.locator(".part-row.selected").count()} of ${total} parts`);
    });
    await shot("boxselect");
    const clearBox = page.getByRole("button", { name: "Clear selection" });
    if (await clearBox.count()) await clearBox.click();
  }

  step = "adding a construction plane and sketching on it";
  await page.getByRole("button", { name: "Plane", exact: true }).click();
  await page.locator("#param-distance").fill("30");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForSelector(".feature-row >> text=Plane 1");
  if ((await page.locator(".feature-row.failed").count()) > 0) throw new Error("a feature failed after adding a plane");
  await page.locator(".feature-row >> text=Plane 1").click();
  await page.getByRole("button", { name: "Sketch", exact: true }).click();
  await page.waitForFunction(() => document.body.textContent?.includes("On Plane 1"), null, { timeout: 5_000 });
  await shot("plane");
  await page.locator('[aria-label="Sketch"] [aria-label="Cancel"]').click();

  step = "joining two parts with Boolean";
  {
    const before = await page.locator(".part-row").count();
    await page.locator(".part-row .feature-name").nth(1).click();
    await page.locator(".part-row .feature-name").nth(2).click({ modifiers: ["Shift"] });
    await tool("Boolean");
    await page.waitForSelector('[aria-label="Parts"] li >> nth=1');
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".part-row").length === n - 1, before, { timeout: 30_000 });
    if ((await page.locator(".feature-row.failed").count()) > 0) throw new Error("a feature failed after the Boolean");
    await shot("boolean");
  }

  step = "grouping the feature list by part";
  {
    await page.getByLabel("Group by part").check();
    const heads = await page.locator(".feature-group-head").count();
    const partsNow = await page.locator(".part-row").count();
    if (heads < partsNow) throw new Error(`grouped list shows ${heads} groups for ${partsNow} parts`);
    await shot("grouped");
    await page.getByLabel("Group by part").uncheck();
  }

  step = "sketch extras: centre rectangle, tangent arc and a pattern";
  {
    await page.getByRole("button", { name: "Sketch", exact: true }).click();
    await page.waitForSelector(".sketch-panel");
    await page.locator(".feature-row.datum", { hasText: "Top" }).click();
    await page.waitForFunction(() => document.querySelector(".sketch-plane-row")?.textContent?.includes("Top plane"));
    await page.waitForTimeout(600);
    const box = await page.locator(".viewport").boundingBox();
    const mx = box.x + box.width / 2;
    const my = box.y + box.height / 2;
    const curves = () => page.evaluate(() => window.juracadStore.getState().editing?.draft.sketch?.data.curves.map((c) => c.type + (c.construction ? "*" : "")) ?? []);

    await tool("Centre rect");
    await page.mouse.click(mx - 150, my - 80);
    await page.mouse.click(mx - 100, my - 50);
    let now = await curves();
    if (now.filter((c) => c === "line").length !== 4 || !now.includes("line*")) {
      const why = await page.evaluate(() => {
        const st = window.juracadStore.getState();
        const id = st.editing?.draft.id;
        return JSON.stringify({ message: st.sketch?.message, tool: st.sketch?.tool, points: st.editing?.draft.sketch?.data.points, candidates: st.sketchLinks?.[id]?.candidates?.length });
      });
      throw new Error(`centre rectangle made ${now.join(",")} — ${why}`);
    }
    // Type its width as soon as it's drawn (Enter), then skip the height (Esc).
    const sizeBox = page.locator(".dimension-editor input");
    await sizeBox.waitFor({ timeout: 5_000 });
    await sizeBox.fill("30");
    await sizeBox.press("Enter");
    await sizeBox.waitFor({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await page.locator(".dimension-editor").waitFor({ state: "detached", timeout: 5_000 });
    const kept = await page.evaluate(() => window.juracadStore.getState().editing.draft.sketch.data.constraints.filter((c) => c.value !== undefined).map((c) => c.value));
    if (kept.length !== 1 || !/^30( in)?$/.test(kept[0])) throw new Error(`typing the width straight after drawing kept ${JSON.stringify(kept)}`);

    // Pinching (Ctrl + wheel) over the sketch zooms the view, never the page — also over its dimension labels.
    {
      await page.evaluate(() => (window.__savedView = window.juracadViewport.current.saveView()));
      const zoomNow = () => page.evaluate(() => window.juracadViewport.current.saveView().zoom);
      const fire = (selector, init) =>
        page.evaluate(
          ([selector, init]) => {
            const el = document.querySelector(selector);
            const r = el.getBoundingClientRect();
            const e = init.gesture
              ? Object.assign(new Event(init.gesture, { bubbles: true, cancelable: true }), { scale: init.scale, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })
              : new WheelEvent("wheel", { deltaY: init.deltaY, ctrlKey: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, bubbles: true, cancelable: true });
            el.dispatchEvent(e);
            return e.defaultPrevented;
          },
          [selector, init],
        );
      const z0 = await zoomNow();
      if (!(await fire(".viewport-canvas", { deltaY: -20 }))) throw new Error("a pinch on the 3D view wasn't stopped (the page would zoom)");
      const z1 = await zoomNow();
      if (!(z1 > z0)) throw new Error(`a pinch on the 3D view didn't zoom it (${z0} → ${z1})`);
      await page.locator(".dimension-label").first().waitFor({ timeout: 5_000 });
      if (!(await fire(".dimension-label", { deltaY: -20 }))) throw new Error("a pinch over a sketch dimension wasn't stopped (the page would zoom)");
      const z2 = await zoomNow();
      if (!(z2 > z1)) throw new Error(`a pinch over a sketch dimension didn't zoom the view (${z1} → ${z2})`);
      // Safari's pinch: its gesture events are stopped and zoom the view.
      if (!(await fire(".viewport-canvas", { gesture: "gesturestart", scale: 1 }))) throw new Error("Safari's pinch on the 3D view wasn't stopped");
      if (!(await fire(".viewport-canvas", { gesture: "gesturechange", scale: 1.5 }))) throw new Error("Safari's pinch on the 3D view wasn't stopped");
      const z3 = await zoomNow();
      if (Math.abs(z3 / z2 - 1.5) > 0.01) throw new Error(`Safari's pinch (×1.5) zoomed the view ×${z3 / z2}`);
      await fire(".viewport-canvas", { gesture: "gestureend", scale: 1.5 });
      // Zoomed in as far as it goes: still stopped.
      for (let i = 0; i < 30; i++) await fire(".viewport-canvas", { deltaY: -1000 });
      if (!(await fire(".viewport-canvas", { deltaY: -1000 }))) throw new Error("a pinch at the 3D view's zoom limit wasn't stopped");
      // The real thing: Ctrl held and the wheel turned.
      const vb = await page.locator(".viewport").boundingBox();
      await page.mouse.move(vb.x + vb.width / 2, vb.y + vb.height / 2);
      const scale0 = await page.evaluate(() => [window.visualViewport?.scale ?? 1, window.devicePixelRatio]);
      await page.keyboard.down("Control");
      await page.mouse.wheel(0, 300);
      await page.keyboard.up("Control");
      await page.waitForTimeout(200);
      const scale1 = await page.evaluate(() => [window.visualViewport?.scale ?? 1, window.devicePixelRatio]);
      if (scale0[0] !== scale1[0] || scale0[1] !== scale1[1]) throw new Error(`the page zoomed: ${scale0} → ${scale1}`);
      // Back to how it was, for the clicks that follow.
      await page.evaluate(() => window.juracadViewport.current.restoreView(window.__savedView));
      await page.waitForTimeout(600);
      if (Math.abs((await zoomNow()) - z0) > 1e-9 * z0) throw new Error("the view didn't go back after the zoom test");
    }

    await page.keyboard.press("l");
    await page.mouse.click(mx - 150, my + 80);
    await page.mouse.click(mx - 60, my + 80);
    await page.keyboard.press("Escape");
    await tool("Tangent arc");
    await page.mouse.click(mx - 60, my + 80);
    await page.mouse.move(mx - 40, my + 120, { steps: 3 });
    await page.mouse.click(mx - 60, my + 140);
    await page.keyboard.press("Escape");
    now = await curves();
    if (!now.includes("arc")) throw new Error(`tangent arc wasn't drawn (${now.join(",")})`);

    // A conic: both ends, then the corner it bends towards.
    await tool("Conic");
    await page.mouse.click(mx + 20, my - 150);
    await page.mouse.click(mx + 120, my - 150);
    await page.mouse.move(mx + 110, my - 100, { steps: 3 });
    await page.mouse.click(mx + 110, my - 100);
    const conics = await page.evaluate(() => window.juracadStore.getState().editing.draft.sketch.data.curves.filter((c) => c.type === "spline" && c.conic === 0.5).length);
    if (conics !== 1) throw new Error(`the conic tool made ${conics} conic(s)`);
    await page.waitForSelector('[aria-label="Conic fullness"]', { timeout: 5_000 });
    await shot("conic");
    await page.keyboard.press("Escape");

    await page.keyboard.press("c");
    await page.mouse.click(mx + 120, my);
    await page.mouse.click(mx + 135, my);
    await page.keyboard.press("Escape");
    await tool("Pattern");
    await page.getByRole("button", { name: "Round a centre" }).click();
    // A shape just drawn stays selected, so the pattern tool starts with the circle; clicking it would deselect it.
    const already = await page.evaluate(() => window.juracadStore.getState().sketch.selection.length);
    if (!already) {
      // Click exactly on the circle's edge (snapping may have nudged it while drawing).
      const rim = await page.evaluate(() => {
        const d = window.juracadStore.getState().editing.draft.sketch.data;
        const c = d.curves.find((k) => k.type === "circle");
        const p = d.points.find((q) => q.id === c.center);
        return window.juracadViewport.current.projectSketchPoint(p.x + c.radius, p.y);
      });
      await page.mouse.click(box.x + rim.x, box.y + rim.y);
    }
    await page.mouse.move(mx + 60, my + 60, { steps: 3 });
    await shot("sketchpattern");
    await page.getByRole("button", { name: "Make pattern" }).click();
    now = await curves();
    if (now.filter((c) => c === "circle").length !== 3) throw new Error(`pattern made ${now.join(",")}`);

    // Text: type the words, click where they go; the letters are closed shapes. A double-click puts the cursor back in the words box.
    await page.keyboard.press("Escape");
    await tool("Text");
    await page.locator('[aria-label="Text words"]').fill("JC");
    const shapesBefore = await page.evaluate(() => /(\d+) closed shape/.exec(document.querySelector(".sketch-status")?.textContent ?? "")?.[1] ?? "0");
    await page.mouse.click(mx - 40, my + 30);
    const texts = await page.evaluate(() => window.juracadStore.getState().editing.draft.sketch.data.texts?.map((t) => t.value) ?? []);
    if (texts.join() !== "JC") {
      const why = await page.evaluate(() => {
        const st = window.juracadStore.getState();
        return JSON.stringify({ tool: st.sketch?.tool, message: st.sketch?.message, value: st.sketch?.textValue, size: st.sketch?.textSize, points: st.editing?.draft.sketch?.data.points.length });
      });
      throw new Error(`the Text tool made ${JSON.stringify(texts)} (${why}; viewport ${JSON.stringify(box)})`);
    }
    await page.waitForFunction((n) => Number(/(\d+) closed shape/.exec(document.querySelector(".sketch-status")?.textContent ?? "")?.[1] ?? 0) > Number(n), shapesBefore, { timeout: 5_000 });
    await tool("Select");
    const mid = await page.evaluate(() => {
      const st = window.juracadStore.getState();
      const d = st.editing.draft.sketch.data;
      const t = d.texts[0];
      const p = d.points.find((q) => q.id === t.anchor);
      return window.juracadViewport.current.projectSketchPoint(p.x + t.size * 0.4, p.y + t.size * 0.35);
    });
    await page.mouse.dblclick(box.x + mid.x, box.y + mid.y);
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Text words", null, { timeout: 5_000 });
    await page.keyboard.type("AD");
    // The design is in inches by now: 0.5 in = 12.7 mm.
    await page.locator('[aria-label="Text size"]').fill("0.5");
    await page.locator('[aria-label="Text size"]').press("Enter");
    const edited = await page.evaluate(() => window.juracadStore.getState().editing.draft.sketch.data.texts.map((t) => `${t.value}@${Math.round(t.size * 1000) / 1000}`));
    if (edited.join() !== "AD@12.7" && edited.join() !== "AD@0.5") throw new Error(`editing the text gave ${JSON.stringify(edited)}`);
    await shot("sketchtext");

    // Insert DXF: a 10 × 10 square (in inches, so 254 mm across), brought in at half size.
    await tool("Insert DXF");
    await page.locator('[aria-label="DXF scale"]').fill("0.5");
    const dxfLines = [[0, 0, 10, 0], [10, 0, 10, 10], [10, 10, 0, 10], [0, 10, 0, 0]].flatMap(([a, b, c, d]) => ["0", "LINE", "8", "0", "10", a, "20", b, "11", c, "21", d]);
    const dxfText = ["0", "SECTION", "2", "HEADER", "9", "$INSUNITS", "70", "1", "0", "ENDSEC", "0", "SECTION", "2", "ENTITIES", ...dxfLines, "0", "ENDSEC", "0", "EOF"].join("\n");
    const [chooser] = await Promise.all([page.waitForEvent("filechooser"), page.getByRole("button", { name: "Choose a DXF file…" }).click()]);
    await chooser.setFiles({ name: "square.dxf", mimeType: "application/dxf", buffer: Buffer.from(dxfText) });
    await page.waitForFunction(() => /Brought in 4 shapes/.test(document.querySelector(".sketch-panel")?.textContent ?? ""), null, { timeout: 5_000 });
    // What came in is selected: its corners are 127 mm apart.
    const across = await page.evaluate(() => {
      const st = window.juracadStore.getState();
      const d = st.editing.draft.sketch.data;
      const ids = new Set(d.curves.filter((c) => st.sketch.selection.includes(c.id)).flatMap((c) => [c.p1, c.p2]));
      const xs = d.points.filter((p) => ids.has(p.id)).map((p) => p.x);
      return Math.max(...xs) - Math.min(...xs);
    });
    if (Math.abs(across - 127) > 1e-6) throw new Error(`the inserted DXF square is ${across} mm across, not 127`);
    await page.locator('[aria-label="Sketch"] [aria-label="Cancel"]').click();
    if (await page.locator(".sketch-panel").count()) await page.locator('[aria-label="Sketch"] [aria-label="Cancel"]').click();
    await page.waitForSelector(".sketch-panel", { state: "detached" });
  }

  step = "sketching on a part's face: its edges show, a line snaps to a corner, Use all";
  {
    const face = await page.evaluate(() => {
      const st = window.juracadStore.getState();
      const doc = st.history.present;
      const studio = st.activeTab && (doc.partStudios ?? []).some((x) => x.id === st.activeTab) ? st.activeTab : "main";
      for (const p of st.parts) {
        if ((p.studioId ?? "main") !== studio || p.surface || p.configuration) continue;
        const ref = p.faceRefs.find((r) => r.surface === "PLANE" && r.normal[2] > 0.999);
        if (ref) return { partId: p.id, ref };
      }
      return null;
    });
    if (!face) throw new Error("no flat top face to sketch on");
    // As clicking the face would: a sketch on it that remembers the face.
    await page.evaluate((f) => window.juracadStore.getState().startSketch({ kind: "face", origin: [0, 0, f.ref.center[2]], u: [1, 0, 0], v: [0, 1, 0], label: "Face of a part", face: f }), face);
    await page.waitForSelector(".sketch-panel");
    await page.waitForFunction(() => {
      const st = window.juracadStore.getState();
      return (st.sketchLinks[st.editing?.draft.id ?? ""]?.edges.length ?? 0) >= 3;
    }, null, { timeout: 30_000 });
    await page.waitForTimeout(600);
    const box = await page.locator(".viewport").boundingBox();
    const corner = await page.evaluate(() => {
      const st = window.juracadStore.getState();
      const e = st.sketchLinks[st.editing.draft.id].edges.find((k) => k.kind === "line");
      return { at: e.a, screen: window.juracadViewport.current.projectSketchPoint(e.a[0], e.a[1]) };
    });
    // A construction line, so the outline used below stays one closed shape.
    await page.keyboard.press("q");
    await page.keyboard.press("l");
    await page.mouse.move(box.x + corner.screen.x + 3, box.y + corner.screen.y + 2, { steps: 3 });
    await page.mouse.click(box.x + corner.screen.x + 3, box.y + corner.screen.y + 2);
    await page.mouse.click(box.x + corner.screen.x + 60, box.y + corner.screen.y - 45);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.keyboard.press("q");
    const snapped = await page.evaluate((want) => {
      const d = window.juracadStore.getState().editing.draft.sketch.data;
      const line = d.curves.find((c) => c.type === "line" && !c.link);
      const ref = d.curves.find((c) => c.link && c.construction);
      const start = line && d.points.find((p) => p.id === line.p1);
      return { hasRef: !!ref, at: start ? [start.x, start.y] : null, want };
    }, corner.at);
    if (!snapped.hasRef || !snapped.at || Math.hypot(snapped.at[0] - snapped.want[0], snapped.at[1] - snapped.want[1]) > 1e-6)
      throw new Error(`the line didn't snap to the face's corner: ${JSON.stringify(snapped)}`);
    // Hovering a face edge marks its middle.
    const quarter = await page.evaluate(() => {
      const st = window.juracadStore.getState();
      const e = st.sketchLinks[st.editing.draft.id].edges.filter((k) => k.kind === "line")[1];
      return window.juracadViewport.current.projectSketchPoint(e.a[0] * 0.75 + e.b[0] * 0.25, e.a[1] * 0.75 + e.b[1] * 0.25);
    });
    await page.mouse.move(box.x + quarter.x, box.y + quarter.y, { steps: 3 });
    await shot("facehint");
    await page.getByRole("button", { name: "Use all the face's edges" }).click();
    await page.waitForFunction(() => /\d+ closed shapes? ready to extrude/.test(document.querySelector(".sketch-status")?.textContent ?? ""), null, { timeout: 10_000 });
    await shot("facesketch");
    await page.locator('[aria-label="Sketch"] [aria-label="Cancel"]').click();
    if (await page.locator(".sketch-panel").count()) await page.locator('[aria-label="Sketch"] [aria-label="Cancel"]').click();
    await page.waitForSelector(".sketch-panel", { state: "detached" });
  }

  step = "making a sheet metal part and its flat pattern";
  {
    await page.getByRole("button", { name: "Sketch", exact: true }).click();
    await page.waitForSelector(".sketch-panel");
    await page.locator(".feature-row.datum", { hasText: "Top" }).click();
    await page.waitForFunction(() => document.querySelector(".sketch-plane-row")?.textContent?.includes("Top plane"));
    await page.waitForTimeout(600);
    const box = await page.locator(".viewport").boundingBox();
    const mx = box.x + box.width / 2;
    const my = box.y + box.height / 2;
    await tool("Rectangle");
    await page.mouse.click(mx - 120, my - 60);
    await page.mouse.click(mx + 60, my + 40);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await page.locator('[aria-label="Sketch"] [aria-label="Accept"]').click();
    await page.waitForSelector(".sketch-panel", { state: "detached" });
    const before = await page.locator(".part-row").count();
    await tool("Sheet metal");
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForFunction((n) => document.querySelectorAll(".part-row").length === n + 1, before, { timeout: 30_000 });
    await tool("Flat pattern");
    await page.waitForSelector(".flat-pattern-view img", { timeout: 10_000 });
    await shot("flatpattern");
    const dxfDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Save DXF" }).click();
    const dxf = readFileSync(await (await dxfDownload).path(), "utf8");
    if (!dxf.includes("ENTITIES") || !/\nLINE\n/.test(dxf)) throw new Error("the flat pattern DXF has no lines");
    await page.keyboard.press("Escape");
    // A flange on the sheet, then its flat pattern on the drawing, with the bend listed.
    step = "putting the flat pattern on a drawing";
    const sheetName = await page.locator(".part-row").last().innerText();
    await page.locator(".part-row").last().click();
    // Only the sheet on show, so its edges aren't behind the other parts.
    await page.evaluate(() => {
      const s = window.juracadStore.getState();
      s.setPartsHidden(s.parts.filter((q) => !q.flat && !q.configuration).map((q) => q.id), true);
    });
    await page.keyboard.press("f");
    await page.waitForTimeout(600);
    const edgeAt = await page.evaluate(() => {
      const s = window.juracadStore.getState();
      const part = s.parts.find((q) => q.flat);
      // A straight edge along the sheet's top face, nearest the camera (lowest on screen).
      const v = window.juracadViewport.current;
      const spots = part.edgeRefs
        .map((e, i) => ({ e, i }))
        .filter(({ e }) => e.curve === "LINE" && Math.abs(e.a[2] - e.b[2]) < 1e-6 && e.a[2] > 1)
        .map(({ i }) => v.screenPointOnEdge(part.id, i))
        .filter(Boolean);
      return spots.sort((a, b) => b.y - a.y)[0];
    });
    await tool("Flange");
    await page.mouse.click(box.x + edgeAt.x, box.y + edgeAt.y);
    await page.waitForFunction(() => (window.juracadStore.getState().editing?.draft.picks?.length ?? 0) === 1, null, { timeout: 5_000 });
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForFunction(() => !window.juracadStore.getState().editing, null, { timeout: 30_000 });
    await page.waitForTimeout(500);
    await page.waitForFunction(() => !window.juracadStore.getState().rebuildBusy, null, { timeout: 60_000 });
    const flangeProblem = await page.evaluate(() => {
      const s = window.juracadStore.getState();
      const f = s.history.present.features.find((x) => x.type === "flange");
      return f ? s.featureErrors[f.id] ?? "" : "no flange feature";
    });
    if (flangeProblem) throw new Error(`the flange didn't build: ${flangeProblem}`);
    await page.evaluate(() => {
      const s = window.juracadStore.getState();
      s.setPartsHidden(s.parts.map((q) => q.id), false);
    });
    await page.getByRole("button", { name: "Drawing 1" }).click();
    await page.locator("#drawing-source").selectOption({ label: sheetName.trim().split("\n")[0] });
    await page.getByLabel("Flat pattern (sheet metal)").check();
    await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => t.textContent === "FLAT PATTERN"), null, { timeout: 60_000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".drawing-text")].some((t) => /^B1: (UP|DOWN) 90°/.test(t.textContent ?? "")), null, { timeout: 10_000 }).catch(async () => {
      const info = await page.evaluate(() => {
        const s = window.juracadStore.getState();
        const sheets = s.parts.filter((q) => q.flat).map((q) => `${q.id}${q.configuration ? "@" + q.configuration : ""}: ${q.flat.bends.length} bend(s), ${q.flat.bendLines.length} line(s)`);
        return `${sheets.join("; ")} | texts: ${[...document.querySelectorAll(".drawing-text")].map((t) => t.textContent).join(" / ")}`;
      });
      throw new Error(`no bend list on the flat pattern view (${info})`);
    });
    await shot("flatview");
    await page.getByRole("button", { name: "Part Studio 1" }).click();
  }

  step = "one sketch, two circles, each extruded on its own (Onshape style)";
  let regionsReport = "";
  {
    const why = async (what) => {
      const info = await page.evaluate(() => {
        const s = window.juracadStore.getState();
        const d = s.editing?.draft;
        return JSON.stringify({ draft: d ? { type: d.type, sketchRef: d.sketchRef, areas: d.areas?.length, op: d.operation } : null, errors: s.featureErrors, parts: s.parts.map((p) => p.name + ":" + p.id), rows: document.querySelectorAll(".part-row").length, busy: s.rebuildBusy, toast: s.toast?.text });
      });
      throw new Error(`${what}: ${info}`);
    };
        await page.getByRole("button", { name: "Add a tab" }).click();
    await page.getByRole("menuitem", { name: "Part Studio" }).click();
    await page.waitForSelector(".tab.active >> text=Part Studio 3");
    await page.evaluate(() => window.juracadStore.getState().setShowFlat(false));
    await page.getByRole("button", { name: "Sketch", exact: true }).click();
    await page.waitForSelector(".sketch-panel");
    await page.locator(".feature-row.datum", { hasText: "Top" }).click();
    await page.waitForFunction(() => document.querySelector(".sketch-plane-row")?.textContent?.includes("Top plane")).catch(() => why('() => document.querySelector(".sketch-plane-row")?.textConte'));
    await page.waitForTimeout(600);
    const box = await page.locator(".viewport").boundingBox();
    const mx = box.x + box.width / 2;
    const my = box.y + box.height / 2;
    // A small circle on the left and a big one on the right.
    await page.keyboard.press("c");
    await page.mouse.click(mx - 110, my);
    await page.mouse.click(mx - 90, my);
    await page.keyboard.press("Escape");
    await page.keyboard.press("c");
    await page.mouse.click(mx + 60, my);
    await page.mouse.click(mx + 120, my);
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".sketch-status")?.textContent?.includes("2 closed shapes"), null, { timeout: 10_000 });
    await page.keyboard.press("Escape");
    await page.locator('[aria-label="Sketch"] [aria-label="Accept"]').click();
    await page.waitForSelector(".sketch-panel", { state: "detached" });
    await page.waitForTimeout(300);
    const spots = () => page.evaluate(() => window.juracadViewport.current.areaScreenPoints());
    const smallest = (list) => list.reduce((a, b) => (b.box < a.box ? b : a));
    const biggest = (list) => list.reduce((a, b) => (b.box > a.box ? b : a));
    const clickSpot = async (spot) => {
      const kind = await page.evaluate(([x, y]) => window.juracadViewport.current.pickKindAt(x, y), [spot.x, spot.y]);
      if (kind !== "sketchArea") throw new Error(`a click on the circle would pick ${kind}, not the sketch area`);
      await page.mouse.click(box.x + spot.x, box.y + spot.y);
    };

    step = "selecting the small circle first (no dialog open), then Extrude uses it";
    const before = await spots();
    if (before.length !== 2) throw new Error(`expected the sketch's 2 circles to be clickable with nothing open, got ${before.length}`);
    await clickSpot(smallest(before));
    await page.waitForFunction(() => window.juracadStore.getState().areaSelection?.areas.length === 1, null, { timeout: 5_000 }).catch(() => why('() => window.juracadStore.getState().areaSelection?.areas.le'));
    await page.getByRole("button", { name: "Extrude", exact: true }).click();
    const first = await page.evaluate(() => {
      const d = window.juracadStore.getState().editing.draft;
      return { areas: d.areas?.length ?? 0, operation: d.operation, apart: d.apart };
    });
    if (first.areas !== 1 || first.operation !== "new" || !first.apart) throw new Error(`Extrude 1 should start with the selected circle as a New part, got ${JSON.stringify(first)}`);
    await page.locator("#param-depth").fill("60");
    await page.getByRole("button", { name: "Accept" }).click();
    await page.waitForFunction(() => document.querySelectorAll(".part-row").length === 1, null, { timeout: 30_000 }).catch(() => why('() => document.querySelectorAll(".part-row").length === 1, n'));

    step = "Extrude 2 after the sketch hid itself: clicking the big circle in the 3D view";
    const hidden = await page.evaluate(() => {
      const f = window.juracadStore.getState();
      const doc = f.history.present;
      const studio = doc.partStudios.find((p) => p.name === "Part Studio 3");
      const sketch = studio.features.find((x) => x.type === "sketch");
      return { visible: sketch.visible, used: studio.features.some((x) => x.sketchRef === sketch.id) };
    });
    if (hidden.visible !== undefined || !hidden.used) throw new Error(`expected the used sketch to hide by itself, got ${JSON.stringify(hidden)}`);
    // Nothing open and the sketch hidden: its areas can't be clicked.
    if ((await spots()).length !== 0) throw new Error("the hidden sketch's areas can be clicked with nothing open");
    await page.getByRole("button", { name: "Extrude", exact: true }).click();
    // It starts on the circle that's left (the big one), adding to the part.
    const second = await page.evaluate(() => {
      const d = window.juracadStore.getState().editing.draft;
      return { areas: d.areas?.length ?? 0, operation: d.operation };
    });
    if (second.areas !== 1 || second.operation !== "add") throw new Error(`Extrude 2 should start with the circle that's left, adding, got ${JSON.stringify(second)}`);
    // The view fits itself round the first part (animated): let it settle, then look straight down again.
    await page.waitForTimeout(800);
    await page.evaluate(() => window.juracadViewport.current.fit(false));
    await page.waitForTimeout(300);
    const during = await spots();
    if (during.length !== 2) throw new Error(`the hidden sketch's 2 areas should be clickable while Extrude is open, got ${during.length}`);
    // The small circle (used by Extrude 1) is shaded as used elsewhere, the big one as picked.
    const shades = await page.evaluate(() => window.juracadViewport.current.pickAreas.sets[0].shades);
    if (!shades.includes("taken") || !shades.includes("picked")) throw new Error(`expected one area used elsewhere and one picked, got ${JSON.stringify(shades)}`);
    // Clicking the big circle leaves it out; clicking it again picks it.
    await clickSpot(biggest(await spots()));
    await page.waitForFunction(() => !window.juracadStore.getState().editing.draft.areas).catch(() => why('() => !window.juracadStore.getState().editing.draft.areas);'));
    await clickSpot(biggest(await spots()));
    await page.waitForFunction(() => window.juracadStore.getState().editing.draft.areas?.length === 1).catch(() => why('() => window.juracadStore.getState().editing.draft.areas?.le'));
    await page.locator("#param-depth").fill("10");
    await page.getByRole("button", { name: "Accept" }).click();
    // Not touching Part 1, so it's a part of its own (as Onshape does).
    await page.waitForFunction(() => document.querySelectorAll(".part-row").length === 2, null, { timeout: 30_000 }).catch(() => why('() => document.querySelectorAll(".part-row").length === 2, n'));
    await page.waitForFunction(() => !window.juracadStore.getState().rebuildBusy, null, { timeout: 60_000 }).catch(() => why('() => !window.juracadStore.getState().rebuildBusy, null, { t'));
    const sizes = await page.evaluate(() => {
      const s = window.juracadStore.getState();
      const doc = s.history.present;
      const studio = doc.partStudios.find((p) => p.name === "Part Studio 3");
      const ids = new Set(studio.features.map((f) => f.id));
      return s.parts
        .filter((p) => ids.has(p.id.split("~")[0]) && !p.configuration)
        .map((p) => {
          let lo = Infinity;
          let hi = -Infinity;
          for (let i = 2; i < p.vertices.length; i += 3) {
            lo = Math.min(lo, p.vertices[i]);
            hi = Math.max(hi, p.vertices[i]);
          }
          return { name: p.name, height: Math.round((hi - lo) * 1000) / 1000 };
        });
    });
    const heights = sizes.map((p) => p.height).sort((a, b) => a - b);
    if (sizes.length !== 2 || heights[0] !== 10 || heights[1] !== 60) throw new Error(`expected two parts 60 and 10 tall, got ${JSON.stringify(sizes)}`);
    if ((await page.locator(".feature-row.failed").count()) > 0) throw new Error("a feature failed in the two-circle Part Studio");
    await shot("two-circles");
    regionsReport = `one sketch with two circles extruded separately into ${sizes.map((p) => `${p.name} (${p.height} mm)`).join(" and ")}`;
    await page.getByRole("button", { name: "Part Studio 1" }).click();
  }

  const real = consoleErrors.filter((e) => !/favicon/i.test(e) && !liveProbeRefused(e));
  if (real.length) throw new Error(`console errors:\n${real.join("\n")}`);

  annotate(
    "notice",
    "Smoke test passed",
    `Box + drilled hole built; selection: "${selected.trim()}" (measure: ${measured}); check: "${headline.trim()}"; STL ${bytes} bytes (${download.suggestedFilename()}); STEP ${stepText.length} bytes (${stepDownload.suggestedFilename()}); 3MF ${mfBytes.length} bytes; undo, export name and planes OK; sketch: "${sketchStatusText.replace(/\n/g, " / ")}"; extrude built Part 2; fillet rounded ${pickCount} picked face/edge(s); revolve around "${axisChoice}" built Part 3; pattern repeated "${patternSource.trim()}"; variable gap = 1/4 in worked out as 6.35 mm, and a second configuration with gap = 2; saved ${saved.suggestedFilename()} (${savedText.length} characters), started afresh and opened it again (${featureCount} features); imported the STEP file (${stepParts} part(s)) and the STL (${stlParts} part); assembly with ${instanceCount} instances, a parts list and a Fasten mate; dragged a part from X ${xBefore} to ${xAfter}; renamed Part 1 to Bracket everywhere; assembly check: "${asmHeadline}", exported ${asmStep.suggestedFilename()}; made a second Part Studio with its own part; drawing with ${viewCount} views and a ${dimValue} mm dimension (auto dimension added ${autoDims} more, hole callout "${holeCallout}"), saved as DXF and ${pdf.suggestedFilename()} (${pdfText.length} bytes); a GD&T tolerance frame; section view; exploded assembly, a pattern of 4 in the assembly, and an exploded assembly drawing with a parts list; switched to inches (new box ${widthBox} in wide); dark mode; selected 3 parts by dragging down the Parts list, and duplicated a part; sketched on a construction plane; joined two parts with Boolean; grouped the feature list by part; sketched a centre rectangle, a tangent arc and a circular sketch pattern, text (edited by double-clicking) and an inserted DXF; sketched on a part's face (its edges showed, a line snapped to its corner, Use all closed the outline); made a sheet metal part and saved its flat pattern as DXF; ${regionsReport}; ${subReport}. ${liveReport}.`,
  );
} catch (e) {
  await shot("failure").catch(() => {});
  annotate("error", `Smoke test failed while ${step}`, `${e instanceof Error ? e.message : e}\nConsole: ${consoleErrors.filter((x) => !liveProbeRefused(x)).join(" | ") || "none"}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
