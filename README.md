# JuraCAD

**Free, open-source, browser-based parametric CAD — with Onshape-style controls. Design parts to 3D print yourself or to send to a manufacturer.**

▶ **Use it:** https://gm7dha.github.io/JuraCAD/ (Chrome or Edge recommended)

JuraCAD runs entirely in your browser. Your designs never leave your computer, there's no account, and it's free.

> **Status: v0.9 preview (Phase 6 done, extras under way).** You can sketch shapes with dimensions and constraints, extrude or revolve them into parts, round, bevel or hollow them,
> put parts together in assemblies with mates, check they're sound and fit, export STEP, STL or 3MF, and make dimensioned 2D drawings (PDF, SVG, DXF). See the [roadmap](docs/DESIGN.md#roadmap).

## What you can do today

- **Sketch** on the Top, Front or Right plane, any flat face, or a construction **Plane** (a distance away, tilted, or halfway between two faces): lines, rectangles, circles, arcs, slots,
  polygons and points; **round corners**, **trim** away pieces of lines, **offset**, and **mirror** shapes across a line.
  Add **dimensions** (double-click to change) and **constraints** (horizontal, vertical, parallel, perpendicular,
  equal, tangent, concentric, midpoint, symmetric, fix). Blue = still free, black = fully defined.
- **Extrude** a sketch's closed shapes (holes included) one way, symmetrically or **through all**, as a new part or added to /
- **Boolean**: join parts into one, subtract parts from others, or keep just where they overlap. Extrudes and other solids can also **Intersect** with the latest part.
- **Split** a part along a plane or flat face, **Thicken** flat faces into a solid, and add a **Rib** (a strengthening wall) from a sketched line.
- **Draft** faces (taper them for moulding), **Move face** (push flat faces out or in) and **Delete face** (remove a fillet, hole or boss and close the gap).
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
- **Inches or millimetres** (Settings ⚙ in the top bar): sizes are shown and typed in the design's units; you can always type a unit, e.g. `25 mm` or `1/4 in`.
- **Dark mode** (Settings ⚙ › Appearance): Light, Dark, or Automatic (follows your computer).
  Change it once and the whole design updates.
- Edit any feature later (double-click it), suppress it, rename it, or delete it. Full undo/redo.
- **Measure**: select an edge or face to see its length, diameter or area; select two for the gap, angle and
  centre-to-centre spacing (great for checking hole positions).
- **Part colours**: click the swatch beside a part in the Parts list. Colours are saved and go into STEP and
  3MF exports.
- **Import STEP and STL** files from other programs (toolbar Import, or drag the file onto the window). Each solid
  in a STEP file becomes a part; use it as it is, move it, or cut its shape out of another part.
- **Section view**: slice the view open along Top, Front or Right to see inside (display only).
- **Several Part Studios** in one design (the **+** at the bottom), and **rename parts** (double-click in the Parts list).
- **Assemblies** (the **+** at the bottom): insert copies of parts from any Part Studio, place them by typing or by
  dragging, and join them with **mates** — Fasten, Hinge, Slider, Cylindrical, Planar and Ball — by clicking a face
  or edge on each part. Drag a hinged part to turn it. A **parts list** (with quantities, downloadable as CSV),
  a **clash check**, and **export** of the whole assembly in place (STEP keeps each part separate and named).
  **Limits** on how far a hinge turns or a slider slides, and an **exploded view** (Explode) that pulls the parts apart.
- **Drawings** (the **+** at the bottom): Front, Top, Right and 3D views of a part or assembly on an A4–A2 sheet,
  laid out first-angle with dashed hidden lines and a title block; drag views about; add **dimensions** by
  clicking corners, edges or circles (they update when the part changes); centre lines on holes; a hatched
  **section views** (draw the cutting line across any front, top or side view; as many as you like); assembly drawings get a parts list and numbered balloons.
  Save as **PDF**, **SVG** or **DXF** at true size.
- **Select several parts** in the Parts list: drag down the list, Shift + click for a run, Ctrl (⌘) + click to add one. Hide, colour or export them together.
- **Check model** — confirms each part is closed and watertight, valid and in one piece, finds its thinnest wall,
  and spots separate parts that overlap.
- **Install it as an app** (Chrome/Edge: the Install app button) so it opens in its own window and works offline;
  installed, it can open `.juracad` files you double-click.
- **Export STEP** (exact shapes — what machine shops and most manufacturers want), **STL** or **3MF** (for 3D printing;
  3MF keeps part names) in coarse, normal or fine quality. JuraCAD checks the model first and warns you about problems.
- **Save** your design to a `.juracad` file on your computer and **Open** it again later (or drag the file onto the
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
| Sketch tools | L line, R rectangle, C circle, A arc, P point, D dimension, O offset, M mirror, Q construction |
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

JuraCAD is MIT licensed (see [LICENSE](LICENSE)).
It uses [OpenCascade](https://dev.opencascade.org/) via [replicad-opencascadejs](https://github.com/sgenoud/replicad)
(LGPL-2.1), [replicad](https://replicad.xyz) (MIT), [three.js](https://threejs.org) (MIT),
[React](https://react.dev) (MIT) and [Zustand](https://github.com/pmndrs/zustand) (MIT).
