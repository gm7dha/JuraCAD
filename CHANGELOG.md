# JuraCAD versions

JuraCAD was called PartSmith up to v0.24; older entries below use the old name.

Each version is a safe point to go back to. To roll back, ask for "go back to vX.Y" — the change is made as a
pull request that undoes everything after that point (your `.juracad` and `.partsmith` files aren't touched, but
designs that use newer tools won't open in an older version until those tools are back).

The point in the history for each version is the commit shown (see https://github.com/gm7dha/JuraCAD/commits/main).

## v0.25 — PartSmith is now JuraCAD

- **New name:** the app is now called **JuraCAD** — in the top bar, Help, What's new, the install instructions,
  messages, and the files it exports (STL, 3MF, PDF and SVG say JuraCAD made them).
- **New address:** https://gm7dha.github.io/JuraCAD/ — update old bookmarks. If you installed the app, uninstall
  it and install it again from the new address.
- **Files:** designs now save as `.juracad`. Your older `.partsmith` files still open (Open, drag and drop, or
  double-click in the installed app), and `.juracad` files still open in older versions.
- **Nothing lost:** the design kept in your browser, your theme, printer and other settings carry over.

## v0.24 — Round of polish across every area (reviewed by independent checkers) · commit `8faacdf`

- **Sketch:** dimensions across / up / straight like Onshape (with a preview), dimensions to circles and arcs,
  "just show the size" (reference) dimensions, polygon size across flats, Split / Extend / Round / Midpoint on arcs,
  points on splines and ellipses. Fixed: Trim on polygons and at spline crossings, Round on dragged-together
  corners, offsets now follow the original, overlapping shapes always join on, sketches with many holes are fast.
- **Part modelling:** extrude both ways with two depths, revolve both ways, chamfer by 2 distances or angle, grid
  patterns, circular pattern round any axis, Shell with walls outside, mirror a whole part. Fixed: designs with
  Intersect wouldn't reopen, patterns after a Boolean join, tapered symmetric extrudes.
- **Surfaces & sheet metal:** flange position (bend off / outside flush / inside flush), Corner break, cuts across
  bends shown in the flat pattern, Thicken both sides, smooth Fill, Delete face leaving the hole open, Enclose says
  where the gap is, Extend follows curved edges.
- **Assemblies:** loops keep the mate you set, Linear relation, Duplicate, Replace part, weights in the parts list,
  exploded-view steps.
- **Drawings:** third-angle layout, A1/A0 and US sheets, part number and company in the title block, dimension
  decimals and dual units, basic/inspection boxes, hide tangent edges, dimensions kept inside the border. Fixed:
  first-angle symbol, PDF/DXF symbols, detail views.

## v0.23 — Hollow, angle arcs, and a round of bug fixes · commit `3c06f37`

- **Hollow** (next to Shell): hollow a part out sealed inside, every face kept. Shell still opens the faces you
  click.
- Sketch **angle dimensions** are drawn as arcs, and measure the angle on the side where you put them.
- **Sweep** and **Curve pattern** follow splines, ellipses and whole circles, from whichever end the profile is at.
- Fixed: Thicken and Shell on awkward or fully rounded shapes; drawing sections of surfaces; flanges after
  moving a sheet metal part; deleting a sketch point; gear relations left behind by deleted mates; drawings
  shrinking when they had several section and detail views; auto dimension on threads and coils; STL files with
  several bodies (now separate parts) or open meshes (now surfaces).

## v0.22 — Surfaces that work like parts, Split with a surface, Ruled surface, spline handles · commit `5a090ce`

- **Thicken** on a surface now makes a real solid (it used to make a second skin and call it solid): flat, curved,
  closed (plus is outwards) and multi-piece surfaces, with **Flip** for the other side.
- Surfaces can be **moved, copied, mirrored, patterned, filleted and chamfered**, faces deleted from them, and
  **imported from STEP** (alone or alongside solids). Booleans and Shell explain that a surface has no inside.
- **Split with a surface**: cut a part (or another surface) along a curved surface — Front side / Back side / Both.
- **Ruled surface**: straight strips swept from edges, square to a plane or tilted by an angle.
- Sketch **spline handles**: select a spline and drag the green handles to reshape it. Points snap onto each other
  from further away; a line can go from Vertical to Horizontal without "conflicting".

## v0.21 — Thread symbols on bolts, wide wraps, smoother lofts · commit `921ff98`

- Drawings: **thread symbols on bolts, screws, nuts and threaded rods** (fasteners and Thread features), as well as
  tapped holes.
- **Wrap** and wrapped Text: shapes wider than the rod now wrap round in narrow strips, hugging the curve.
- **Loft** between ellipses (or a circle and an ellipse) no longer leaves an extra edge down the side or splits
  the rims.

## v0.20 — Surface tools · commit `4f12a19`

- **Surfaces**: thin skins with no inside, for flowing shapes. Tick **Surface** in Extrude, Revolve, Sweep or Loft
  (open outlines work too), or use **Fill** to span a ring of edges. Then **Thicken** a surface into a solid, or
  **Enclose** several into one. Also **Offset surface**, **Extend surface**, and **Split** to trim a surface.

## v0.19 — Print bed, shortened views, Mirror, Derived, Wrap and more · commit `e4e823f`

- **Print bed** preview: your 3D printer's bed and build volume under the parts, and whether they fit.
- Drawings: **shortened views** for long parts (dimensions still show the real length), **thread symbols** on
  tapped holes, and select several dimensions at once (drag a box, or Ctrl-click).
- Assemblies: **Tangent mate** (a roller on a flat, wheels touching), and **Mirror** (mirror-image copies across a
  plane, listed as their own parts).
- Part Studio: **Derived** (bring in a part from another Part Studio), **Wrap** (a sketch's shapes round a round
  face), and planes you make sit with Top, Front and Right — right-click one to make a new plane from it.
- Sheet metal: round-ended or tear **bend reliefs**, and round or square **corner reliefs**.

## v0.18 — Tabs, broken-out views, full round, more fasteners, free orbit · commit `6570e52`

- Sheet metal: **tabs** — add a flat tab to a wall from a sketch.
- Drawings: **broken-out views** — cut away part of a view to show what's inside.
- Part Studio: **full round** — round a thin wall's end into a full half-circle.
- **Fasteners**: socket cap, button head and countersunk screws (Allen key), pan head screws (cross) and grub screws,
  as well as hex bolts, nuts and washers, all M3 to M12.
- The 3D view **turns freely** — right over the top and underneath, with no stop.

## v0.17 — Hems, closed corners, unfolding, and turning about any axis · commit `29e085b`

- Sheet metal: **hems** (an edge folded back on itself), **closed corners** where two flanges meet, a
  **flat pattern view on drawings** (numbered bend lines and a bend list), and **Unfold** to show parts flat in the
  3D view.
- Part Studio: **Move / copy** turns about X, Y and Z in one go.

## v0.16 — Sheet metal, and what's new · commit `0171140`

- **Sheet metal**: a flat sheet from a closed sketch, or a bent one from connected lines (an L, U or Z side view);
  set its thickness, bend radius and K-factor.
- **Flange**: bend walls up or down off straight edges (on flanges too), at any angle, optionally shortened at
  each end with bend reliefs.
- **Flat pattern**: the part unfolded (with bend allowances and any holes cut afterwards), saved as DXF for laser
  cutting or SVG.
- Click the version number in the top bar to see **what's new** in each version.

## v0.15 — Replace face, conics, Group and Width mates · commit `129faf6`

- Part Studio: **Replace face** — move flat faces onto another face or plane parallel to them (to line parts up),
  with an offset.
- Sketch: **Conic** — a curve between two points that bends towards a corner, with a Fullness setting
  (0.5 = a parabola).
- Assemblies: **Group** (lock parts together so they move as one) and the **Width** mate (centre a part between two
  faces, like a tab in a slot). The less-used mates and Pattern/Replicate now share ▾ buttons.

## v0.14 — Polish: tidier toolbars, folders, more sketch and drawing tools · commit `4f3732a`

- Toolbars: every toolbar fits on one row; similar tools share a button (click the **▾** for the others), and
  Help explains how.
- The first part you make is zoomed to fit, and closing a sketch puts the view back where it was.
- Feature list: **folders** to keep long lists tidy (right-click a feature › Put in a folder…).
- Sketch: **Extend** and **Split** lines, and **Move / copy** (move, turn or copy picked lines).
- Drawings: **angle dimensions** (click two edges) and **auxiliary views** (a sloping face seen square-on).

## v0.13 — Replicate, configured parts, GD&T and more sketch tools · commit `32d8dda`

- Assemblies: **Replicate** (a part copied into every matching hole, each with its own mate) and parts shown in
  **any configuration** (a Small and a Large bracket side by side; counted separately in the parts list).
- Sketch: **3-point circle**, **centre-point arc** and **aligned rectangle**.
- Part Studio: **curve pattern** (repeat along a sketched path) and **variable fillets** (a different radius at
  each end).
- Drawings: **datum symbols**, **GD&T feature control frames** and **surface finish** marks.

## v0.12 — Springs, curves, hole callouts, patterns and configurations · commit `d38571a`

- Part Studio: **Coil** (springs), **merge parts** into one, **configurations** (versions of a design — variable
  values and suppressed features — to switch between), and threads now work on any cylinder (the seam line no
  longer gets in the way).
- Sketch: **Spline** and **Ellipse** tools, and a shape's size boxes pop up as soon as it's drawn (Enter keeps,
  Esc skips).
- Measure between **whole parts**: the gap, whether they touch, and how much they overlap.
- Assemblies: **patterns** of parts, in a row or round an axis, that follow their originals.
- Drawings: **hole callouts** (e.g. 4× Ø6.6 THRU, with counterbore, countersink or thread), also used by Auto
  dimension.
- Toolbars: similar tools share one button with a **▾** list.

## v0.11 — Threads, fasteners, mechanisms and drawing tables · commit `b7e163f`

- Part Studio: **Thread** (metric screw threads), **Fastener** (hex bolts, nuts and washers, M3–M12, optionally
  threaded), **Delete part**, **materials and part weights**, drag features to **reorder** them, a **rollback
  bar**, **show only this / show all / see-through** parts, and Ctrl+D to duplicate.
- Assemblies: **closed loops** of mates, **Pin slot** and **Parallel** mates, **▶ Animate**, **gear,
  rack-and-pinion and screw relations**, and saved **positions**.
- Drawings: **tolerances** and extra text on dimensions, **notes**, **detail views**, a **hole table** and a
  **revision table**; Auto dimension picks baseline, chain or ordinate per row; Shift-drag a dimension's number
  anywhere.

## v0.10 — More Onshape: Part Studio tools, sketching and drawings · commit `bdb0382`

- Part Studio: **Plane** features, **Boolean** (join, subtract, intersect), **Split**, **Thicken**, **Rib**,
  **Draft**, **Move face** and **Delete face** (which offers to switch off fillets or chamfers in the way).
- Text can **wrap round a round face** (raised or engraved).
- The feature list can be **grouped by part**; **box select** by dragging on empty space (3D view and sketches).
- Sketch: **centre rectangle**, **tangent arc**, **sketch patterns** (in a row or round a centre), lining up
  with points you've passed over, and dragging a point onto another to **join** them.
- Drawings: **Auto dimension**, **Baseline**, **Chain** and **Ordinate** dimensions, and dimension numbers you
  can slide along their line.
- The toolbar **scrolls with the mouse wheel**, with arrows at the ends; and a little surprise in Help.

## v0.9 — Inches, dark mode and everyday improvements · commit `15baa18`

- **Inches** or millimetres per design (Settings ⚙), without changing the model.
- **Dark mode**: Light, Dark or Automatic (Settings ⚙).
- Parts list: select several parts (drag, Shift, Ctrl/⌘), hide, colour, export or **duplicate** them together;
  picking a part lights up the features that made it, and the other way round.
- Drawings: section views you draw yourself; the **smart Dimension** tool (circle → size, circle + edge →
  centre-to-edge distance, edge + edge → distance between).
- Fixes: patterns of a moved part start where it is now; the Settings menu is no longer hidden by the top bar.

## v0.8 — Extras: sketching, modelling, drawings and assemblies · commit `6f8dda4`

- Sketch: **Offset** (O), **Use** part edges (U), **Mirror** (M) with copies that follow the originals, and a
  **Symmetric** constraint.
- Extrude **up to a face**, and with a **draft** angle (tapered sides).
- **Sweep** a shape along a path, **Loft** between shapes, and raised or engraved **Text**.
- Drawings: **centre lines** on holes, **section views** you draw yourself (as many as you like, hatched,
  with lettered cutting lines), and numbered **balloons** on assembly drawings.
- Assemblies: **limits** on how far hinges and sliders move, and an **exploded view** (also on drawings).

## v0.7 — Phase 6: 2D drawings · commit `6c408b6`

- Drawing tabs (+ › Drawing): Front, Top, Right, Left, Back, Bottom and 3D views of a part or a whole assembly,
  laid out first-angle on A4, A3 or A2, with dashed hidden lines and a title block (title, material, drawn by,
  date, scale, notes).
- Views can be dragged (lined-up views stay lined up); scale fits the sheet or is chosen.
- Dimensions: click two points, an edge, or a circle; across, up-and-down, slanted, diameter and radius; they
  follow the part when it changes.
- Assembly drawings show a parts list.
- Save drawings as PDF, SVG or DXF at true size.

## v0.6 — Phase 5: Assemblies · commit `e3f1a55`

- Assembly tabs (the + at the bottom): insert copies of parts, place them by typing a position and turn, Fix / Unfix.
- Mates: Fasten, Hinge, Slider, Cylindrical, Planar and Ball, by clicking a face or edge on each part; amounts with
  sliders; connectors follow the faces when the parts change.
- Drag parts with the mouse: free parts slide, hinges turn, sliders slide.
- Parts list with quantities (download as CSV).
- Check assembly: clashes between parts, broken mates, missing parts.
- Export an assembly in place (STEP keeps parts separate, named and coloured; STL; 3MF).
- Several Part Studios in one design; rename parts; Isometric button under the view cube.

## v0.5 — More modelling · commit `3891772`

- Move, turn and copy parts.
- Measure: lengths, distances, angles, radii and centre-to-centre gaps.
- Section view: cut the view along Top, Front or Right to see inside.
- Part colours, kept in saved files and carried into STEP and 3MF exports (STEP files no longer mark every part red).
- Import STEP and STL files (toolbar, drag and drop, or Open) as New / Add / Remove; STEP files with several solids give one part each.
- Faster handling of parts with thousands of faces.

## v0.4 — Phase 4: Save, check, export (+ sketch tools and holes) · commit `bb4d88e`

- Save and Open `.partsmith` files (Ctrl/⌘ + S, Ctrl/⌘ + O, or drag a file onto the window); "Unsaved changes" label.
- Install as an app that works offline (Install button; Safari: File › Add to Dock).
- 3MF export.
- Fuller model check: thinnest wall and overlapping parts.
- Sketch tools: Slot, Polygon, Round (corner fillet) and Trim.
- Extrude: Through all.
- Hole tool: simple, counterbored and countersunk; through or to a depth with a drill point; M2–M12 clearance or tapped sizes.
- Fixes: tangent constraints where a line ends on an arc; the app fits laptop-sized windows; the Install button explains itself in every browser.

## v0.3 — Phase 3: Part features · commit `dc60299`

- Fillet and Chamfer (picked edges are remembered by shape and position, so they survive changes).
- Revolve and Shell.
- Mirror, linear Pattern and Circular pattern.
- Variables: named sizes usable in any box or sketch dimension.
- STEP export (the default) alongside STL; wording made general rather than 3D-printing only.
- Help shows Mac or Windows shortcuts.

## v0.2 — Phase 2: Sketcher and Extrude · commit `1d007a4`

- Sketch on Top, Front, Right or any flat face: lines, rectangles, circles, arcs and points.
- Dimensions and constraints; blue = free, black = fully defined.
- Extrude closed shapes (holes included) one way or symmetrically, as New / Add / Remove.

## v0.1 — Phase 1: Foundation · commit `1c02ed8`

- Onshape-style 3D view: orbit, pan, zoom, view cube, standard views.
- Box, cylinder and sphere as New / Add / Remove; edit, rename, suppress, delete; undo and redo.
- Maths and units in any size box. Check model and STL export.
