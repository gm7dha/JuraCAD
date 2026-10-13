# PartSmith versions

Each version is a safe point to go back to. To roll back, ask for "go back to vX.Y" — the change is made as a
pull request that undoes everything after that point (your `.partsmith` files aren't touched, but designs that use
newer tools won't open in an older version until those tools are back).

The point in the history for each version is the commit shown (see https://github.com/gm7dha/partsmith/commits/main).

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
