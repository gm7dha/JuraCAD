# PartSmith — Design

PartSmith is a free, open-source, browser-based **general-purpose parametric CAD tool**, with the look and
controls of Onshape. It runs entirely in the browser, installs as an app on Windows and macOS (from Phase 4),
and works offline.

**Who it's for:** a hobbyist designing real parts — to 3D print at home, or to send as STEP or STL files to a
manufacturer to be made in nylon, stainless steel or other materials. Every trade-off favours simplicity over
professional-engineering depth. (Originally aimed at 3D printing only; widened in Phase 3.)

## Goals

- Sketch on a plane or face, constrain it with dimensions, and build solids with features
  (extrude, revolve, fillet, shell and so on).
- Edit any earlier step and have the model rebuild correctly.
- Check the model is a sound, closed solid, then export STEP (exact, for manufacturers) or STL (for printing).
- Combine parts into assemblies with Onshape-style mates.
- Produce simple 2D drawings from parts.

**Not goals (for now):** real-time collaboration or cloud storage; imperial units (later); simulation, CAM,
sheet metal, surface modelling; signed native installers.

## Key decisions

| Area | Decision | Why |
| --- | --- | --- |
| Modelling style | Parametric, feature-based | Edit any step and the model rebuilds; matches Onshape |
| Geometry kernel | OpenCascade (OCCT) in WebAssembly, via replicad | Real solid kernel: fillets, shells, STEP, hidden-line drawings |
| Sketch solver | Own TypeScript solver (`src/sketch/solver.ts`) — damped Gauss-Newton with a freedom (DOF) analysis | Small, fully tested, no extra WebAssembly; planegcs remains an option if we outgrow it |
| Topological naming | Reimplement FreeCAD 1.0's history-based naming | Stops references breaking when earlier steps change |
| Language and build | TypeScript, Vite | Widely used, well documented |
| UI | React + Zustand | Common and easy to maintain |
| 3D viewport | three.js | Standard web 3D library |
| Delivery | PWA on GitHub Pages | Installs on Windows and macOS, offline, free |
| Native apps | Deferred (Tauri wrapper later if needed) | Avoids code-signing costs |
| Licence | MIT | Simple, compatible with the LGPL libraries |
| Units | Millimetres; inches later | |
| Look and controls | Onshape | |

## Architecture

The app is split into a fast user interface and a background worker that does all the heavy geometry,
so the screen never freezes while the model rebuilds.

```
Main thread (what you see)                 Background worker (heavy maths)
┌──────────────────────────────┐           ┌───────────────────────────────┐
│ UI (React)  src/app          │  feature  │ Geometry engine  src/kernel   │
│ Viewport (three.js)          │   list    │  - replays features in order  │
│   src/viewport               │ ────────▶ │  - OpenCascade via replicad   │
│ Document store (Zustand)     │ ◀──────── │  - meshes, checks, STEP/STL   │
│   src/model                  │  meshes   └───────────────────────────────┘
└──────────────────────────────┘
          │ autosave
          ▼
   Browser storage (later: .partsmith files)
```

- **`src/model`** — the document (an ordered feature list), feature definitions, the expression evaluator
  (`10 + 2`, `1 in`), undo/redo history and the app store. Pure, tested code.
- **`src/kernel`** — the worker protocol, the client (latest-wins rebuilds), and `engine.ts`, which turns
  features into OpenCascade solids. The engine also runs in Node for tests.
- **`src/geometry`** — pure mesh tools: the soundness check (watertight, pieces, volume) and the STL writer.
- **`src/viewport`** — the three.js scene: Onshape mouse controls, view cube, planes, origin, hover and picking.
- **`src/app`** — React components: top bar, toolbar, feature list, feature dialog, check/export/help dialogs.

### Data model

The document stores the *recipe*, not the geometry: an ordered list of features, each with a type,
an operation (New / Add / Remove), parameters as typed expressions, and a permanent ID.
Later phases add sketches, variables, assemblies (instances + mates) and drawings.

### Topological naming (from Phase 3)

When a fillet says "round edge 7" and edge 7 becomes a different edge after an earlier change, models break.
PartSmith will follow FreeCAD 1.0's approach in its own code: every sketch entity gets a permanent ID;
OpenCascade's *generated/modified* history names each face and edge from that history; feature references
store names, not numbers; unresolved names show the feature in red rather than silently picking the wrong edge.

**Step 1 (done, with Fillet/Chamfer):** picks are stored as *what the edge or face looks like*
(`src/geometry/topoRef.ts`): curve or surface type, ends/middle or centre/normal, and position relative to the
part's bounding box. Each rebuild finds the closest match of the same kind and direction — judged mainly by the
line or plane it lies on, or by its relative position when the whole part was resized. If nothing is close
enough the feature turns red and asks for the edges to be picked again. This copes with resizing and moving
things; the history-based naming above is still the goal for heavier changes.

## Controls (Onshape-style)

| Action | Control |
| --- | --- |
| Orbit | Right-drag |
| Pan | Middle-drag, or Ctrl + right-drag |
| Zoom (towards cursor) | Scroll wheel |
| Select | Left-click; Shift/Ctrl-click to add |
| Standard views | View cube, Shift + 1…7 |
| Zoom to fit | F |
| View normal to | N |
| Undo / redo | Ctrl/⌘ + Z, Ctrl/⌘ + Y |

## Roadmap

Each phase ends with a working version on the live site.

| Phase | Scope | You can… |
| --- | --- | --- |
| **P1 Foundation** ✅ | App shell, Onshape-style viewport, OpenCascade worker, box/cylinder/sphere with New/Add/Remove, basic model check, STL export | make simple solids and export them |
| **P2 Sketcher** ✅ | Sketch on planes and flat faces; lines, rectangles, circles, arcs, points; constraints and dimensions; basic Extrude (one way / symmetric, New/Add/Remove) | draw a fully defined sketch and extrude it |
| **P3 Part features** ✅ (topological naming: step 1) | Extrude, revolve, fillet, chamfer, shell, variables, editable history, topological naming | design real parts and change them later |
| **P4 Save, check, export** ✅ | `.partsmith` save/open, fuller model check (thinnest wall, overlapping parts), STEP/STL/3MF export, install as an offline app | keep projects and trust exports |
| P4b More modelling ✅ v0.5 (done: sketch slot/polygon/round/trim, through all, hole tool, move/copy, measure, section view, part colours, import STEP/STL; later: offset, use part edges, up to face, draft) | Sketch trim/extend/offset/fillet, slots and polygons, use part edges in sketches; extrude through all / up to face / draft; hole tool (counterbore, countersink, tapped); move/rotate/copy parts; measure; section view; part colours; import STEP/STL | model real parts quickly |
| **P5 Assemblies** ✅ v0.6 (also several Part Studios, rename parts; since: mate limits, exploded views; later: mate loops) | Instances, mate connectors, Onshape mate types, BOM | check multi-part designs fit together |
| **P6 2D drawings** ✅ v0.7 (since: section views, balloons, centre lines; later: detail views, tolerances) | ISO sheets, first-angle views, hidden lines, dimensions, PDF/SVG/DXF | print a dimensioned drawing |
| P7 Extras (v0.8: text, sweep/loft, offset/use/mirror, up to face/draft, drawing and assembly extras; inches and dark mode since) | Patterns, holes, text, sweep/loft, sections, import, inches, optional print-bed preview, dark mode | as needed |
| P8 Onshape parity (v0.10–v0.18, done) | Done: Plane, Boolean, Split/Thicken/Rib, Draft, Move/Delete face, Thread, Coil, curve pattern, variable fillets, materials, rollback, reorder, configurations; sketch splines, ellipses, all rectangle/circle/arc kinds, tangent arc, sketch patterns, snapping; assemblies: mate loops, more mates, relations, patterns, Replicate, configured parts, named positions; drawings: detail views, baseline/chain/ordinate dims, tolerances, notes, GD&T, hole callouts, hole and revision tables, auxiliary views; sketch extend/split; Replace face (flat faces); sketch conics; Width and Group mates. Broken-out views; full-round fillets; Tangent mate. P8 is done. | the tools an Onshape user reaches for |
| **P9 Sheet metal** ✅ v0.16–v0.17 (sheet from a sketch or open outline, flanges with reliefs and closed corners, hems, flat pattern with DXF, drawing view, Unfold; later: tabs, more relief shapes) | Sheet metal parts: base flange from a sketch, flanges on edges, bends with a bend radius and K-factor, tabs and reliefs, and a flat pattern (DXF for laser cutting) shown beside the folded part | design bent metal parts and cut them flat |

## How we work

1. Each change goes in through a pull request with a plain-English summary and how to test it.
2. GitHub Actions type-checks, runs the tests (including real OpenCascade reference models) and builds
   the site on every pull request. Nothing broken gets published.
3. Merging to `main` publishes to https://gm7dha.github.io/partsmith/ within a few minutes.
