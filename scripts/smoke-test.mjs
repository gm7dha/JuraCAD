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
  const features = await page.locator(".feature-row:not(.datum)").count();
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
  await page.getByRole("menuitem", { name: "Hide" }).click();
  if (!(await rightRow.getAttribute("class")).includes("hidden")) throw new Error("hiding the Right plane didn't work");
  await rightRow.hover();
  await page.getByRole("button", { name: "Show Right" }).click();
  if ((await rightRow.getAttribute("class")).includes("hidden")) throw new Error("showing the Right plane didn't work");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Shift+Digit7");

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
  await page.getByRole("button", { name: "Pattern", exact: true }).click();
  await page.waitForSelector(".feature-dialog .pick-list li", { timeout: 5_000 });
  const patternSource = await page.locator(".feature-dialog .pick-list li").first().innerText();
  await page.locator("#param-count").fill("2");
  await page.locator("#param-spacing").fill("80");
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

  step = "adding a variable";
  await page.getByRole("button", { name: "Variables", exact: true }).click();
  await page.getByRole("button", { name: "+ Add variable" }).click();
  await page.getByRole("textbox", { name: "Variable name" }).fill("gap");
  await page.getByRole("textbox", { name: "Value of gap" }).fill("1/4 in");
  const worksOut = await page.locator(".variable-result").first().innerText();
  if (!/6\.35 mm/.test(worksOut)) throw new Error(`the variable worked out as "${worksOut}"`);
  await page.getByRole("button", { name: "Done" }).click();
  await page.waitForSelector(".variables-table", { state: "detached" });

  const real = consoleErrors.filter((e) => !/favicon/i.test(e));
  if (real.length) throw new Error(`console errors:\n${real.join("\n")}`);

  annotate(
    "notice",
    "Smoke test passed",
    `Box + drilled hole built; selection: "${selected.trim()}"; check: "${headline.trim()}"; STL ${bytes} bytes (${download.suggestedFilename()}); STEP ${stepText.length} bytes (${stepDownload.suggestedFilename()}); undo, export name and planes OK; sketch: "${sketchStatusText.replace(/\n/g, " / ")}"; extrude built Part 2; fillet rounded ${pickCount} picked face/edge(s); revolve around "${axisChoice}" built Part 3; pattern repeated "${patternSource.trim()}"; variable gap = 1/4 in worked out as 6.35 mm.`,
  );
} catch (e) {
  await shot("failure").catch(() => {});
  annotate("error", `Smoke test failed while ${step}`, `${e instanceof Error ? e.message : e}\nConsole: ${consoleErrors.join(" | ") || "none"}`);
  process.exitCode = 1;
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}
