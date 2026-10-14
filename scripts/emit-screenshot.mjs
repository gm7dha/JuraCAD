/**
 * Prints one smoke-test screenshot as GitHub Actions notice annotations
 * (base64, ~3.9 KB per annotation), so it can be reviewed from the run page
 * or the API. Usage: node scripts/emit-screenshot.mjs <n> — the n-th screenshot
 * chosen for sending (only those named in SMOKE_SHOW are kept as .b64 files).
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";

const n = process.argv[2];
const dir = "smoke-screenshots";
const chosen = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".b64")).sort((a, b) => parseInt(a) - parseInt(b)) : [];
const file = chosen[Number(n) - 1];
if (!file) process.exit(0);
const data = readFileSync(`${dir}/${file}`, "utf8");
const size = 3900;
const parts = Math.ceil(data.length / size);
for (let i = 0; i < parts; i++) {
  console.log(`::notice title=screenshot ${file.replace(".b64", "")} part ${i + 1}/${parts}::${data.slice(i * size, (i + 1) * size)}`);
}
