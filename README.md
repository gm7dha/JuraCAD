# PartSmith

**Free, open-source, browser-based parametric CAD — with Onshape-style controls. Design parts to 3D print yourself or to send to a manufacturer.**

▶ **Use it:** https://gm7dha.github.io/partsmith/ (Chrome or Edge recommended)

PartSmith runs entirely in your browser. Your designs never leave your computer, there's no account, and it's free.

> **Status: Phase 4 preview.** You can sketch shapes with dimensions and constraints, extrude or revolve them into parts, round, bevel or hollow them,
> combine them with boxes, cylinders and spheres, check they're sound and export STEP or STL. Assemblies and drawings arrive in later phases — see the [roadmap](docs/DESIGN.md#roadmap).

## What you can do today

- **Sketch** on the Top, Front or Right plane, or on any flat face: lines, rectangles, circles, arcs, slots,
  polygons and points; **round corners** and **trim** away pieces of lines.
  Add **dimensions** (double-click to change) and **constraints** (horizontal, vertical, parallel, perpendicular,
  equal, tangent, concentric, midpoint, fix). Blue = still free, black = fully defined.
- **Extrude** a sketch's closed shapes (holes included) one way, symmetrically or **through all**, as a new part or added to /
  cut from the latest part.
- **Hole**: drill holes at a sketch's points or circle centres — plain, counterbored or countersunk, through or
  to a depth (with a drill point), sized by screw (M2–M12, clearance or tapped).
- **Revolve** a sketch around a line for round parts (knobs, rings, bottles), all the way round or part way.
- **Shell** a part to hollow it out, leaving walls of the thickness you choose.
- **Move / copy** a part: move it along X, Y, Z and/or turn it about an axis — or make a moved copy.
- **Mirror** features across a plane, and repeat them in a row (**Pattern**) or round a circle (**Circular**) —
  for example a ring of bolt holes. Each copy adds or cuts just like the original.
- **Fillet** (round) and **Chamfer** (bevel) edges: click edges, or a face to do all its edges. They keep
  working when you change the sizes of earlier features.
- Add **Box**, **Cylinder** and **Sphere** solids, each as a **New** part or **Add**ed to / **Remove**d from the latest part.
- Type maths and units into any size box: `10 + 2`, `25.4 mm`, `1/4 in`.
- **Variables**: name a size (e.g. `wall = 2`) and type the name into any box or sketch dimension (`wall * 2`).
  Change it once and the whole design updates.
- Edit any feature later (double-click it), suppress it, rename it, or delete it. Full undo/redo.
- **Measure**: select an edge or face to see its length, diameter or area; select two for the gap, angle and
  centre-to-centre spacing (great for checking hole positions).
- **Part colours**: click the swatch beside a part in the Parts list. Colours are saved and go into STEP and
  3MF exports.
- **Section view**: slice the view open along Top, Front or Right to see inside (display only).
- **Check model** — confirms each part is closed and watertight, valid and in one piece, finds its thinnest wall,
  and spots separate parts that overlap.
- **Install it as an app** (Chrome/Edge: the Install app button) so it opens in its own window and works offline;
  installed, it can open `.partsmith` files you double-click.
- **Export STEP** (exact shapes — what machine shops and most manufacturers want), **STL** or **3MF** (for 3D printing;
  3MF keeps part names) in coarse, normal or fine quality. PartSmith checks the model first and warns you about problems.
- **Save** your design to a `.partsmith` file on your computer and **Open** it again later (or drag the file onto the
  window). Your latest work is also kept in the browser automatically.

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
