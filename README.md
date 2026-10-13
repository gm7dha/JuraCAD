# PartSmith

**Free, open-source, browser-based parametric CAD for 3D printing — with Onshape-style controls.**

▶ **Use it:** https://gm7dha.github.io/partsmith/ (Chrome or Edge recommended)

PartSmith runs entirely in your browser. Your designs never leave your computer, there's no account, and it's free.

> **Status: Phase 3 preview.** You can sketch shapes with dimensions and constraints, extrude or revolve them into parts, round, bevel or hollow them,
> combine them with boxes, cylinders and spheres, check they're printable and export STL. Assemblies and drawings arrive in later phases — see the [roadmap](docs/DESIGN.md#roadmap).

## What you can do today

- **Sketch** on the Top, Front or Right plane, or on any flat face: lines, rectangles, circles, arcs and points.
  Add **dimensions** (double-click to change) and **constraints** (horizontal, vertical, parallel, perpendicular,
  equal, tangent, concentric, midpoint, fix). Blue = still free, black = fully defined.
- **Extrude** a sketch's closed shapes (holes included) one way or symmetrically, as a new part or added to /
  cut from the latest part.
- **Revolve** a sketch around a line for round parts (knobs, rings, bottles), all the way round or part way.
- **Shell** a part to hollow it out, leaving walls of the thickness you choose.
- **Fillet** (round) and **Chamfer** (bevel) edges: click edges, or a face to do all its edges. They keep
  working when you change the sizes of earlier features.
- Add **Box**, **Cylinder** and **Sphere** solids, each as a **New** part or **Add**ed to / **Remove**d from the latest part.
- Type maths and units into any size box: `10 + 2`, `25.4 mm`, `1 in`.
- Edit any feature later (double-click it), suppress it, rename it, or delete it. Full undo/redo.
- **Check model** — confirms each part is closed and watertight, valid, in one piece, and not too thin.
- **Export STL** in coarse, normal or fine quality. PartSmith checks the model first and warns you about problems.
- Your work is saved in the browser automatically.

## Controls (same as Onshape)

| Action | Mouse / key |
| --- | --- |
| Orbit | Right-drag |
| Pan | Middle-drag, or Ctrl + right-drag |
| Zoom towards cursor | Scroll wheel |
| Select face or edge | Left-click (Shift/Ctrl-click to add) |
| Standard views | Click the view cube, or Shift + 1…7 |
| Zoom to fit | F |
| View normal to selected face | N |
| Undo / redo | Ctrl/⌘ + Z, Ctrl/⌘ + Y |
| Sketch / Extrude | Shift + S / Shift + E |
| Sketch tools | L line, R rectangle, C circle, A arc, P point, D dimension, Q construction |
| Help | ? |

## How it's built

- **TypeScript + React + Vite**, state in **Zustand**, 3D view in **three.js**.
- Geometry by **OpenCascade** (the kernel FreeCAD uses), compiled to WebAssembly, via **replicad**.
  It runs in a background worker so the screen never freezes.
- Every change runs automated tests (including real OpenCascade reference models) on GitHub Actions and,
  once merged to `main`, publishes to GitHub Pages.

See [docs/DESIGN.md](docs/DESIGN.md) for the design, decisions and roadmap.

### Developing

```bash
npm install
npm run dev        # local dev server
npm test           # unit + geometry tests
npm run build      # production build into dist/
```

## Licence

PartSmith is MIT licensed (see [LICENSE](LICENSE)).
It uses [OpenCascade](https://dev.opencascade.org/) via [replicad-opencascadejs](https://github.com/sgenoud/replicad)
(LGPL-2.1), [replicad](https://replicad.xyz) (MIT), [three.js](https://threejs.org) (MIT),
[React](https://react.dev) (MIT) and [Zustand](https://github.com/pmndrs/zustand) (MIT).
