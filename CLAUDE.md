# Notes for Claude working on PartSmith

- The owner is a hobbyist with no coding background who directs the work. Explain changes in plain English
  in pull requests, and keep the app's wording friendly and jargon-free.
- Design and roadmap: `docs/DESIGN.md`. The look and controls follow Onshape.
- Stack: TypeScript, React 18, Vite 5, Zustand 5, three.js, replicad 1.x + replicad-opencascadejs (OCCT WASM).
- Geometry runs in `src/kernel/kernel.worker.ts`; the logic lives in `src/kernel/engine.ts` so it can be
  tested in Node (`tests/engine.test.ts` loads the real OCCT engine).
- Keep pure logic (model, geometry, reports) out of React and covered by Vitest tests.
- Every change: `npm run typecheck && npm test && npm run build`. CI runs the same and publishes `main`
  to GitHub Pages (base path `/partsmith/`).
- Units are millimetres everywhere. Z is up (Onshape convention): Top = XY, Front = XZ, Right = YZ.
- If the npm registry is unreachable from your environment, push to a branch and let CI install, test and
  build; the `site` artifact contains `dist/` and `package-lock.json`.
