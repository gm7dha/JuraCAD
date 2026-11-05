# JuraCAD versions

JuraCAD was called PartSmith up to v0.24; older entries below use the old name.

Each version is a safe point to go back to. To roll back, ask for "go back to vX.Y" — the change is made as a
pull request that undoes everything after that point (your `.juracad` and `.partsmith` files aren't touched, but
designs that use newer tools won't open in an older version until those tools are back).

The point in the history for each version is the commit shown (see https://github.com/gm7dha/JuraCAD/commits/main).

## v0.44 — Photo relief puzzle

- New in the Design library under **Puzzles**: the **Photo relief puzzle**. Choose any picture — a face, a pet, a bold
  logo — and it becomes the same interlocking-cube puzzle as the Mountain puzzle, with light parts standing high and dark
  parts low, like a lithophane. Set the relief in mm, how much to smooth the picture, or make dark parts high instead.
  Everything else (printer, scale, cube size, the low base, dovetails and coded keys, print plates) works as for mountains.

## v0.43 — Mountain puzzle moves into the Library

- The **Mountain puzzle** now lives in the **Design library**, on the 3D printing tab under its own heading, **Puzzles**,
  instead of having its own toolbar button. Searching the library for "mountain", "munro" or "puzzle" finds it too.
  It opens the same window as before.

## v0.42 — Mountain puzzle: a low base and chunkier tabs · commit `4476c67`

- **Much less plain side under the mountain.** The bottom layer is now a thin jigsaw plate (about 4 mm) instead of a full
  cube, so the lowest ground sits only 10 mm above the bed. The layers above are full cubes as before, still locked
  together by the plate's jigsaw and the keys.
- **Chunkier tabs:** the round jigsaw tabs are now wide **dovetails** with rounded corners. Their necks are 7.5–10 mm
  wide on 30 mm cubes (they were 3.4 mm), so they don't snap, even on the thin bottom plate, and they print cleanly.
- **Every piece's tabs are its own:** each join is one of 16 dovetails (which way it points, a narrow or wide head,
  shallow or deep, and set left, centre or right), and they're chosen so no two pieces have the same tabs, however
  they're turned. A piece in the wrong place won't go in, or leaves a clear gap. The only exceptions are cubes with
  one neighbour beside them or none (on a steep face), and their coded keys still tell them apart.
- New setting, **Side under the ground**, for how many mm of plain side to leave (10 by default).
- The area boxes now say **km west to east** and **km south to north**, instead of "wide" and "tall".
- The mountain puzzle is 3D printing only now: the laser version has been taken out of JuraCUT.

## v0.41 — More 3D printing designs · commit `ebb89f0`

- Ten more designs in the **Library**'s 3D printing tab:
  - **Honeycomb wall tile** and clip-in **hook** and **bin** (Storage): honeycomb storage wall tiles with the same hole
    layout and click-in fit as the popular HSW system, so its parts and ours mix.
  - **Gridfinity magnet baseplate**, **bit / screwdriver holder bin** and **lite bin** (Gridfinity).
  - **Pipe clip** (Fixings): snaps over a pipe; tells you if the grip would strain the plastic too much.
  - **Charging phone stand** (Desk): the phone stands on a raised floor with a slanted slot for the charging plug
    (set your plug's length) and the cable runs out of the back.
  - **Spool holder on a 608 bearing** (Workshop), **funnel** and **door wedge** (Household), **cable tie anchor** (Desk)
    and **box divider set** (Storage).

## v0.40 — Mountain puzzle: OpenStreetMap files · commit `976a36d`

- **Mountain puzzle:** a new way to choose the mountain, **An OpenStreetMap file**. On openstreetmap.org, zoom to the
  mountain, press Export and save the .osm file; the puzzle takes its area from the file. The heights still come from the
  height data (OpenStreetMap has none).
- **From the map** chooses how much of the map goes onto the puzzle:
  - **Just the area**;
  - **Paths, rivers and lochs:** footpaths, tracks, rivers and streams become shallow rounded grooves in the ground
    (0.5–0.8 mm deep), and lochs are set flat, a little below their shore;
  - **Everything:** roads (wider grooves) and buildings (small raised blocks) too. Names are too small to print on the
    ground, so they're left off here (JuraCUT's laser version engraves them).
- The map's paths, rivers and lochs are drawn over the shaded map at the top of the window.

## v0.39 — Mountain puzzle: square keys, and every piece fits only its own place · commit `672776d`

- **Mountain puzzle:** the two thin pegs on top of each cube are replaced by one low, wide **square key** with sloping
  sides, and a matching sloped pocket underneath the piece above. Pieces drop into place and lift straight out again,
  and there's nothing thin to snap.
- **Every piece fits only its own place:** each key is coded — moved a millimetre one way or another, and one of its
  corners cut off — so no piece's pocket fits the key of any piece next to, above or below its own place. A piece in the
  wrong place sits up on the key there and rocks, so you can see straight away, and the cut corner means it only goes on
  one way round. All the keys in a puzzle are the same size (about 7 mm across on 30 mm cubes), which is what makes the
  codes work.

## v0.38 — Mountain puzzles · commit `3356de9`

- **Mountain puzzle** (toolbar, next to Library): turn a real mountain into a 3D printed puzzle of interlocking cubes.
  Pick a famous peak, type an OS grid reference, or load your own OS map picture and type its corners' grid
  references; the heights come free from open height data. Inside the mountain every layer is a jigsaw with full-height
  tabs, and every piece has two pegs on top that fit sockets in the piece above, so it all drops together from above;
  the top of each column follows the ground. The whole puzzle stands on at least one layer of jigsaw cubes, so every
  piece is held.
- **Sized from your printer:** 100% fills the bed, and the scale goes up from there (bigger puzzles just print over more
  plates). Cubes too small for strong tabs are refused, and fragile sizes are warned about; the fit gap, height stretch
  and tab pattern can be changed.
- **Snow caps:** above a height you choose, each piece's snow is its own part on filament 2, ready for the AMS.
- See it from above (with each column's name) and in 3D, pulled apart if you like, then download each print plate as a
  3MF for Bambu Studio, or all of them in one zip.

## v0.37 — Send designs to and from JuraCUT; more library designs

- **Send to JuraCUT** (Export for laser panel): the outlines go straight onto JuraCUT's bed — into its open tab, or a
  new one — ready to lay out and cut. Designs sent from JuraCUT arrive here as a new sketch on the Top plane, ready to
  extrude. Both apps are on the same website, so this all happens inside your browser.
- **Simplify on import:** tick "Simplify" when importing a STEP or STL (or use Simplify part afterwards) to turn a
  mesh-like model back into real faces — flat faces joined, holes, slots and rounded edges as true round faces at their
  exact sizes — with a note saying what was done. Organic shapes come in as they are.
- **Part Studio tabs:** drag tabs to reorder them (or Move left/right in the tab menu); any studio can be deleted,
  Part Studio 1 too, with a warning when something uses its parts. Download the Claude extension again from Help —
  designs with moved tabs use a newer file format that older copies refuse rather than mis-read.
- **Colour chooser** always opens full size.
- **Laser cutting:** living-hinge box, card deck box, business card holder, spice rack, tealight lantern, key rack,
  dice tower and name puzzle.
- **3D printing:** electronics enclosure, French cleat, hinged box, desk organiser, cable chain, wall pocket, shelf
  pins and test prints.

## v0.36 — Library: Gridfinity, jigsaw puzzles and more · commit `5b61437`

- **3D printing:** Gridfinity baseplates and bins (to the standard, with dividers, label ledge, magnets and stacking
  lip), name plate/sign, battery organiser, spool holder, under-desk headphone hook, plant pot and saucer, bag clip,
  thumb knob for a nut, hose adapter, SD card holder.
- **Laser cutting:** sliding-lid box, tray with dividers, bookend, clock face, cord winders, tealight holder, jigsaw
  puzzle generator (change the pattern number for a new layout) and ornaments/keyrings.
- **Loft** can make straight sides between shapes; sketches with many shapes check much faster.

## v0.35 — Library: fixings, hinges, stencils and stamps · commit `6826b20`

- **3D printing:** bolt, nut and washer sets (M3–M12, printable threads with a fit setting), hex standoffs, piano hinge,
  screw-top jar, bit holder, pegboard hook, drawer pull, desk cable grommet and corner protector.
- **Laser cutting:** stencil (bridges added automatically so letter middles don't fall out), rubber stamp (mirrored, the
  background engraved away), name/key tag, coasters, three-layer picture frame, living-hinge panel, gear and ruler.
  Also a 3D-printed stamp with a handle.
- **Library window:** a search box, and headings such as Fixings, Hinges, Storage, Household and Workshop.
- **Sketch text** can be mirrored; **Export for laser** can engrave a sketch's background; Thread has a groove depth setting.
- **Claude extension:** inserts the new designs, including words. Download it again from Help.

## v0.34 — Library: 3D printing and laser cutting tabs, more designs · commit `b6c652f`

- **Two tabs in the Library:** Laser cutting and 3D printing.
- **New 3D printing designs:** box with a lid that fits, wall hook with countersunk screw holes, snap-in cable clip,
  phone/tablet stand, and a print-in-place hinge that moves straight off the bed (print with supports off).
- **New laser design:** a flat-pack phone stand (three pieces that slot together, with a kerf allowance).
- **Claude extension:** the library list is grouped by tab and can be filtered. Download it again from Help.

## v0.33 — Design library and Export for laser · commit `a13127b`

- **Design library** (Library button): ready-made designs you adapt by changing a few sizes — a laser-cut finger-joint
  box (inside or outside sizes, thickness, finger width, lid, kerf), a tray, a shelf bracket, a spacer and a grip knob.
  They're ordinary features driven by variables, so they stay editable; Edit design sizes changes the other choices.
- **Export for laser** (Laser button, or from Export): true-size SVG or DXF for Bambu Studio from a flat face, a part,
  every part laid out, a sketch or a sheet metal flat pattern. Outer cuts red, holes blue (cut first), scores green,
  engraving black; Mirror for the back.
- **Claude extension:** list and insert library designs, and export for laser. Download it again from Help.

## v0.32 — Tablets and touch · commit `dce43bc`

- **Finger gestures:** one finger turns the view, two fingers pinch to zoom and drag to pan, tap selects, double-tap
  fits the view; in assemblies a long press picks a part up to move it. Pinching never zooms the page.
- **Apple Pencil and fingers in sketches:** one finger or the Pencil draws; two fingers only move the view and never
  leave a stray point; a hand resting on the screen while the Pencil draws is ignored; snapping reaches further for fingers.
- **Touch bar** (tablets only): Add to selection, No snapping, Shift (drawings), and buttons for Esc, Delete, Planes,
  Look at and Fit.
- **Lists and menus:** long press opens the right-click menu, double-tap acts as a double-click; feature rows get Move up /
  Move down. Drawings: pinch and pan, drag dimension numbers, long press flips arrows.
- **Bigger touch targets** on tablets; desktops look exactly as before, and mice, trackpads and desktop pen tablets work as before.

## v0.31 — Finishes and pictures, sheet metal from a part · commit `908808a`

- **Finishes:** in a part's colour popup, choose matte, glossy, silk PLA, brushed or polished metal, rubber, clear or
  wood-ish. Clear parts export see-through in 3MF and STEP. A "Nicer lighting" setting makes the 3D view shinier.
- **Save picture:** the Picture button next to Fit saves a PNG of the view at screen size, 2× or 4×, on a light, dark or
  see-through background, with soft studio lighting and a shadow.
- **Sheet metal from a part:** Sheet metal › From a part turns a hollowed part's flat faces into sheet metal. Click the
  walls, click the corner edges to rip, and you get bends and a flat pattern like any other sheet metal part.
- **Claude extension:** a set_appearance tool for colours and finishes. Download it again from Help.

## v0.30 — Versions & history, 3D-printing toolkit, sweep twist round corners, flexible sub-assemblies · commit `2e9bdcf`

- **Versions & history:** save named snapshots of your design, look at an old one, compare two, and go back to one.
- **3D printing:** a print check (overhangs, thin walls, pieces that won't sit on the bed); lay a part flat on a chosen face;
  printed-fit presets (press, snug, sliding, loose) for holes and sizes; save a 3MF laid out ready for your slicer.
- **Sweep:** twist now works round sharp corners and on closed loops (whole turns on a loop); a profile drawn lying along
  the path, rather than across it, is refused with a plain message; Check now flags a solid that's inside out.
- **Assemblies:** make a sub-assembly flexible (its own mates still move, as in Onshape); mirror whole sub-assemblies;
  mirror across a mate connector you place; symmetric parts at a slant are recognised.
- **Drawings:** each view can show its own part or assembly; a sheet never shows another sheet's views after switching.
- **Sketch:** hold Shift to stop snapping; circles seen at a slant come in as ellipses; Use works on other sketches'
  splines; Pierce on wavy edges; relations that can't work say so more quickly.
- **Shapes from several sketches:** select shapes in several sketches before making a feature; Revolve and Sweep can take
  them too.
- **Claude extension:** assembly patterns, groups, limits, relations, Replicate and explode steps; drawing notes, more
  dimension kinds and sheets; long builds can be stopped. Download it again from Help.

## v0.29 — Safari Live, drawing sheets per part, assembly STEP and mirror, Claude builds assemblies and drawings · commit `d886d49`

- **Live with Claude in Safari** through a small link window from the extension (allow the pop-up; keep it open).
- **Claude extension:** Claude can now build assemblies (insert, mates, clash check, explode, structured STEP) and
  drawings (views, sections, details, dimensions, PDF/DXF/SVG), and a long request can be cancelled. Download it again
  from Help.
- **Drawings:** every dimension's number drags freely (angles switch to the other angle as you cross a line, as in
  Onshape); each sheet can show its own part or assembly with its own title and part number; outside angles over 180°;
  angle numbers can sit right by the corner.
- **Assemblies:** STEP export keeps the assembly structure; explode parts inside sub-assemblies; mirror across a flat
  face, or as the same part for symmetric parts; Width mate across two parts of one copy.
- **Parts from shapes:** one Extrude can take shapes from several sketches; Intersect works on every part it reaches;
  threaded holes thread every part they go through; the dialog says which parts it adds to, joins or makes.
- **Sketch:** Pierce; Use on spline and ellipse edges; Extend for splines and ellipse arcs; a warning when an offset
  crosses itself; DXF ellipse arcs come in as real ellipse arcs.
- **Amber warnings:** a feature that builds but has something to tell you shows an amber note instead of looking failed.
- **Note:** holes made since v0.28 in Part Studios with several parts now measure their depth in the part the drill
  actually meets first.

## v0.28 — Curve constraints, snapping to everything, sub-assemblies, one sketch many shapes · commit `13556f8`

- **One sketch, several shapes:** click any shape of a sketch (before or while making an Extrude, Revolve or Sweep)
  to use just that shape; shapes other features already use are greyed. Separate pieces become separate parts, as in
  Onshape: Add joins the parts a piece touches (all of them), and cuts and holes go into every part they reach.
- **Sketch:** Tangent, Normal and Curvature between splines, ellipses, circles, arcs and lines; Trim, Split and Offset
  for splines and ellipses; linear patterns stay linked. Lines snap tangent to two circles (outer and crossing). Snap
  to points, line ends, middles and centres of other sketches and of the part's edges, even off the sketch's plane —
  they follow when the original changes. Text, Intersect, Insert DXF and Insert image. Click sketch areas in the 3D view.
- **Eye to show/hide** planes, Top/Front/Right, the origin and sketches (used sketches hide themselves; Show/Hide all
  sketches); **P** shows or hides all planes. Shortcuts no longer act behind an open popup.
- **Sweep:** Twist (up to 10 turns) and Keep profile orientation.
- **Assemblies:** sub-assemblies — put one assembly inside another.
- **Drawings:** drag a dimension's number anywhere; pinch or Ctrl+scroll zooms the view, never the whole page.
- **Fixed:** saving to a file (and Live with Claude) kept losing part numbers, descriptions, custom properties and
  configurations.

## v0.27 — Sketch snaps and face edges, mirror and pattern pickers, drawing arrows · commit `bf07c73`

- **Sketch:** snap to a line's middle and to circle/arc centres; a circular pattern can go round any point you click
  (the copies follow it); sketching on a face shows its edges and holes faintly to snap, dimension and constrain to,
  and they follow the part when it changes ("Use all the face's edges" copies the outline).
- **Mirror and patterns:** a clear "Mirror plane" box (click a face, plane or sketch line, or Top/Front/Right) and an
  "Axis" box for circular patterns (a round face or edge, a straight edge, a sketch line, or X/Y/Z); the choice is
  shown in the view and follows the part.
- **Drawings:** click the 3D view to set its own scale (or drag its corner); a warning when a view runs off the sheet
  at a fixed scale; dimension arrows Automatic, Inside or Outside, with Flip arrows.
- **Live with Claude** confirmed working in Chrome; looks for new chats less often after the first minute.

## v0.26.2 — Live with every Claude chat · commit `7ed1540`

- **Live with Claude** now links every Claude chat that has JuraCAD, not just the first one found: Claude starts the
  extension once per chat, so the chat you were typing in could be left out. Chats started after you click Connect are
  linked by themselves within a few seconds, and closed ones drop out quietly. The badge's details say how many chats
  are linked. Needs the updated extension (download it again from Help).

## v0.26.1 — Live with Claude · commit `5e885c3`

- **Live with Claude:** click **Connect to Claude** in the top bar (Chrome or Edge) and Claude works on the design
  you have open, while you watch: its sketches and features appear in the feature list and the 3D view, each as one
  step you can undo. You can keep editing too; if you both change something at once, nothing is lost. Needs the
  updated JuraCAD extension for Claude (download it again from Help).

## v0.26 — Round 2: Claude builds parts, several sheets, Bend, suppress and more · commit `70c4e76`

- **Use JuraCAD with Claude:** a Claude desktop extension (download from Help) so Claude can build parts from a
  description with JuraCAD's own engine and save editable `.juracad` files.
- **Sketch:** pick the areas to extrude (shapes split where lines cross, remembered by the lines around them),
  drag an arc's rim to resize it, arc length / arc angle dimensions, circle gaps to near or far edges, midpoint.
- **Part modelling:** holes go Up to next, have a separate thread depth and can model a real thread for printing;
  Through all can go both ways (optional). Extrude up to next / any face / part / corner, with an offset. Click an
  edge or face for a pattern's direction or axis; skip chosen copies.
- **Sheet metal & surfaces:** Bend along a sketched line, Jog, mitred corners (optional), Extend surface up to a face
  or part.
- **Assemblies:** suppress parts, smarter clash checks (touching, surfaces, hidden parts, angled parts), drag groups
  held by a mate, mate connectors at edge ends / middles / clicked spots, part numbers, descriptions and properties,
  optional weights on drawings, mate to the origin.
- **Drawings:** several sheets ("2 OF 3", all in one PDF), each view at its own scale, long hole tables wrap into
  columns or can be dragged, chamfer callouts, arc length and H7/g6 fit dimensions.

## v0.25 — PartSmith is now JuraCAD · commit `2b05613`

- **New name:** the app is now called **JuraCAD** — in the top bar, Help, What's new, the install instructions,
  messages, and the files it exports (STL, 3MF, PDF and SVG say JuraCAD made them).
- **New address:** https://gm7dha.github.io/JuraCAD/ — update old bookmarks. If you installed the app, Save your
  design from it first, then uninstall it and install it again from the new address.
- **Files:** designs now save as `.juracad`. Your older `.partsmith` files still open (Open, drag and drop, or
  double-click in the installed app). In an older version, drag a `.juracad` file onto the window to open it.
- **Carried over:** the design kept in this browser, your theme, printer and other settings. An app added to the
  Dock with Safari keeps its own copy, so Save from it before the address changes.

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
