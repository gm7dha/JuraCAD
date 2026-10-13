# Notes for Claude working on PartSmith

- The owner is a hobbyist with no coding background who directs the work. Explain changes in plain English
  in pull requests, and keep the app's wording friendly and jargon-free.
- Design and roadmap: `docs/DESIGN.md`. The look and controls follow Onshape.
- Stack: TypeScript, React 18, Vite 5, Zustand 5, three.js, replicad 1.x + replicad-opencascadejs (OCCT WASM).
- Geometry runs in `src/kernel/kernel.worker.ts`; the logic lives in `src/kernel/engine.ts` so it can be
  tested in Node (`tests/engine.test.ts` loads the real OCCT engine).
- Sketches: data and pure edits in `src/sketch/` (own constraint solver in `solver.ts`, closed-shape finding in
  `regions.ts`); the interactive tool state machine is `src/sketch/controller.ts`; extrusion is `src/kernel/extrude.ts`.
- Variables: `src/model/variables.ts`; `evaluate()` in `src/model/expr.ts` reads the document's current values
  (kept in sync by store.ts; the worker gets them with each rebuild). Changing variables re-solves sketches.
- Zustand selectors must not return a fresh array/object each call (use a shared constant), or React loops.
- Keep pure logic (model, geometry, reports) out of React and covered by Vitest tests.
- Every change: `npm run typecheck && npm test && npm run build`. CI runs the same and publishes `main`
  to GitHub Pages (base path `/partsmith/`).
- Units are millimetres everywhere. Z is up (Onshape convention): Top = XY, Front = XZ, Right = YZ.
- If the npm registry is unreachable from your environment, push to a branch with an open (draft) PR and
  let CI install, test and build. CI failures are reported as check-run annotations
  (`gh api repos/gm7dha/partsmith/check-runs/<job id>/annotations`), readable even when job logs and
  artifacts aren't downloadable.
- `npm run smoke` (`scripts/smoke-test.mjs`) drives the built app in headless Chromium: box → drilled
  hole → check → export STL, STEP and 3MF → edit → undo → sketch (rectangle, dimension, circle) → extrude → fillet a face → revolve around a construction line → linear pattern → hole dialog (M4 sizes) → add a variable → save to .partsmith → New → open it again. To see the result, set `SMOKE_SCREENSHOTS: "1"` in the CI
  workflow; small screenshots then arrive as base64 notice annotations ("screenshot N-name part i/n")
  that can be joined and decoded. Set it back to "0" before merging.
- Offline/installable: `public/manifest.webmanifest` + `public/sw.js` (registered in main.tsx, production only);
  bump `CACHE` in sw.js if its caching rules change.
- Versions: bump `version` in package.json and add a CHANGELOG.md entry (with the merge commit) at the end of each
  phase. This session type can't create GitHub releases or push tags, so CHANGELOG.md is the record.
- No `package-lock.json` is committed yet (it couldn't be generated in the first session); add one when
  a session can run `npm install`.
