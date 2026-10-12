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
import { mkdirSync, writeFileSync } from "node:fs";
import { chromium } from "playwright";
import { preview } from "vite";

const inCI = process.env.GITHUB_ACTIONS === "true";
const wantShots = process.env.SMOKE_SCREENSHOTS === "1";
const shotDir = "smoke-screenshots";
mkdirSync(shotDir, { recursive: true });

const annotate = (level, title, message) => {
  if (inCI) console.log(`::${level} title=${title}::${String(message).replace(/%/g, "%25").replace(/\r?\n/g, "%0A")}`);
  else console.log(`[${level}] ${title}: ${message}`);
};

let step = "starting";
const server = await preview({ preview: { port: 4173, strictPort: true }, logLevel: "warn" });
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 1180, height: 760 }, acceptDownloads: true });
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
page.on("pageerror", (e) => consoleErrors.push(e.message));

let shotNumber = 0;
async function shot(name) {
  shotNumber++;
  const base = `${shotDir}/${shotNumber}-${name}`;
  const buffer = await page.screenshot({ type: "jpeg", quality: 70 });
  writeFileSync(`${base}.jpg`, buffer);
  if (wantShots) {
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

const statusText = () => page.locator(".status-strip").innerText();

try {
  step = "loading the app";
  await page.goto("http://localhost:4173/partsmith/");
  await page.waitForSelector(".topbar", { timeout: 30_000 });

  step = "waiting for the geometry engine";
  await page.waitForSelector(".engine-status", { state: "detached", timeout: 120_000 });

  step = "adding a box";
  await page.getByRole("button", { name: "Box", exact: true }).click();
  await page.locator("#param-width").fill("40");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForFunction(() => document.querySelector(".part-list")?.textContent?.includes("Part 1"), null, {
    timeout: 30_000,
  });

  step = "drilling a hole with a cylinder";
  await page.getByRole("button", { name: "Cylinder", exact: true }).click();
  await page.getByRole("radio", { name: "Remove" }).click();
  await page.locator("#param-diameter").fill("10");
  await page.locator("#param-height").fill("20");
  await page.locator("#param-x").fill("40 / 2");
  await page.locator("#param-y").fill("15");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForTimeout(1500);
  const failed = await page.locator(".feature-row.failed").count();
  if (failed > 0) throw new Error(`${failed} feature(s) failed to build`);
  const features = await page.locator(".feature-row:not(.default)").count();
  if (features !== 2) throw new Error(`expected 2 features in the list, found ${features}`);

  step = "hovering and selecting a face";
  const box = await page.locator(".viewport").boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.waitForTimeout(300);
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.55);
  await page.waitForTimeout(300);
  const selected = await statusText();
  await shot("drilled-block");

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
  if (!/Ready to print/.test(headline)) throw new Error(`check said: ${headline}`);
  await page.getByRole("button", { name: "Close", exact: true }).first().click();

  step = "exporting STL";
  await page.getByRole("button", { name: "Export STL" }).click();
  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await page.getByRole("button", { name: "Check & export" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  const { statSync } = await import("node:fs");
  const bytes = statSync(path).size;
  if (bytes < 84 + 50 * 12) throw new Error(`STL file is suspiciously small (${bytes} bytes)`);

  step = "editing a feature";
  await page.locator(".feature-row:not(.default)").first().dblclick();
  await page.locator("#param-height").fill("30");
  await page.getByRole("button", { name: "Accept" }).click();
  await page.waitForTimeout(1200);

  step = "undo";
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(800);

  const real = consoleErrors.filter((e) => !/favicon/i.test(e));
  if (real.length) throw new Error(`console errors:\n${real.join("\n")}`);

  annotate(
    "notice",
    "Smoke test passed",
    `Box + drilled hole built; selection: "${selected.trim()}"; check: "${headline.trim()}"; STL ${bytes} bytes (${download.suggestedFilename()}).`,
  );
} catch (e) {
  await shot("failure").catch(() => {});
  annotate("error", `Smoke test failed while ${step}`, `${e instanceof Error ? e.message : e}\nConsole: ${consoleErrors.join(" | ") || "none"}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
