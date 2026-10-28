# Notes for Claude working on JuraCAD

- The owner is a hobbyist with no coding background who directs the work. Explain changes in plain English
  in pull requests, and keep the app's wording friendly and jargon-free.
- The owner has said to merge PRs without asking once CI passes (squash merge), then tell them what changed so
  they can try it on the live site.
- Design and roadmap: `docs/DESIGN.md`. The look and controls follow Onshape.
- The app was called PartSmith until v0.25. Some old names stay on purpose so nothing breaks: browser-storage keys
  (`partsmith.document.v1`, `partsmith.file.v1`, `partsmith.theme`, `partsmith.printer`, `partsmith.seenVersion`,
  `partsmith.groupFeatures`, `partsmith.toolGroup.*`), the saved-file format id `"format": "partsmith"`, and opening
  `.partsmith` files (new saves are `.juracad`). The `PartSmithDocument` type is a deprecated alias of `JuraCADDocument`.
- Stack: TypeScript, React 18, Vite 5, Zustand 5, three.js, replicad 1.x + replicad-opencascadejs (OCCT WASM).
- Geometry runs in `src/kernel/kernel.worker.ts`; the logic lives in `src/kernel/engine.ts` so it can be
  tested in Node (`tests/engine*.test.ts` load the real OCCT engine; shared set-up in
  `tests/support/engineHelpers.ts`). Each test file runs in its own process and OCCT never gives memory back while it
  lives, so keep very heavy tests in a file of their own (like `engineStl.test.ts`, ~3 GB) and put no wall-clock limits
  tighter than "generous" in tests: CI machines are often busy. CI's reporter (`tests/support/ciReporter.ts`) turns every
  failure, including a crashed test process, into an annotation and adds a time/memory notice per file.
- Sketches: data and pure edits in `src/sketch/` (own constraint solver in `solver.ts`, closed-shape finding in
  `regions.ts`; the areas curves divide the plane into, where they cross, in `areas.ts` — a feature's `areas` are picks
  [x, y, size, ...signature] — a point inside each clicked area, its mm², and the solid curve ids (+/− side) round its outline —
  matched again on rebuild by `matchArea` (most shared signature; a deleted bounding curve = gone); none = every closed shape); picked in the 2D map (`src/app/AreaPicker.tsx`) or by clicking the areas in the 3D view while an
  Extrude/Revolve/Sweep dialog is open (`src/sketch/areaClicks.ts`: `areaClickMode` — areas before faces, except while an extrude's
  "Up to…" end is picked; every earlier sketch's areas are clickable (`clickableAreaSketches`: not below the rollback bar, not a
  sweep's path), the feature's own first and winning wherever it's under the pointer, the rest fainter, and other *hidden* sketches only
  on hover (`PickAreaSet.hoverOnly`); clicking another sketch's area makes it the feature's sketch with just that area
  (`areaClickChange`, one sketch per feature, a toast says so); areas other features use are shaded grey ("taken", `areasTaken`, cached
  per features array; also in the 2D map), and a new Extrude/Revolve of a used sketch starts with the areas left (`freeAreas`, in `startCreate`).
  With nothing open, areas of sketches on show can be clicked to select them (`store.areaSelection`, `selectArea`; mode "nearest":
  nearer than the part's face wins, drawn only on hover/selected; an area lying on a face carries `under`, and clicking the only selected
  area again selects that face). Extrude/Revolve/Sweep then use it (a sketch highlighted in the list wins), Sketch starts on its plane;
  it's let go on any design change, tab change, dialog/sketch opening or list pick (`areaSelectionLapses`, a store subscription).
  `SceneManager.setPickAreas` takes one `PickAreaSet` per sketch, each drawn as one mesh + one LineSegments, coloured per vertex, rebuilt
  only when that sketch's outlines array (`areaOutlines`, one per map) or plane values change; PickTarget "sketchArea" (sketch + index); both use `toggleArea`, so
  picks are identical; both use `followedSketch` — a face sketch as the engine moved it; "used by all" shading is skipped above
  `MAX_SHADED_AREAS`). Onshape-style parts: Extrude/Revolve/Sweep/Hole made since then carry `apart: true` — New: each separate solid
  piece is its own part (ids `<feature>`, `<feature>~2`…); Add: each piece joins every part it touches, merged into the oldest (others
  removed, their tools re-pointed), else a new part (`addApart` → `joinApart` plan → `commitPlan`, all or nothing); Remove/Hole: cuts
  every solid part it reaches (`partsReached`, `cutParts`; the threaded-hole cache is skipped then); pattern/mirror copies of apart
  features follow the same rules (`applyPattern`). Without the flag (older files) the old rules hold exactly (one part; the latest part); the interactive tool state machine is `src/sketch/controller.ts`; extrusion is `src/kernel/extrude.ts`.
  Snapping (points, line middles → Midpoint, circle centres, part edges, lining up, onto curves) is the pure `snapAt` in
  `src/sketch/snaps.ts`. Part edges: `src/sketch/links.ts` — a sketch on a part face keeps the face (`SketchPlane.face`,
  a TopoPick); lines/circles/arcs may carry `link` (the part edge they follow: "Use", or a face edge brought in as a
  construction reference when snapped to or dimensioned to — stand-in ids "ref:<n>" until then). The engine's
  `followSketch` finds the face and links again each rebuild (moves the plane with its face, re-solves via `followLinks`)
  and returns `RebuildResult.sketchLinks`; the store syncs the open sketch from it (planes compared to 1 µm, so sloping
  faces don't loop). Faces and links are re-found with `strictMatch` (topoRef.ts: near and unambiguous, else reported lost; faces
  within 0.1 × part size, links within 0.3 × among edges lying in the sketch's face
  — `linkProblem` puts it on the sketch in featureErrors). Unused references are dropped when a sketch closes
  (`pruneReferences`). Any sketch can also use what's elsewhere (`src/sketch/projected.ts`, pure): other sketches' points/lines/
  circles/arcs and every part's edges, seen square-on (projected). Each build keeps, per sketch, cheap shared copies of the parts
  and the sketches before it (`StudioBuild.snaps`); opening a sketch asks the worker (`sketchCandidates` request →
  `GeometryEngine.sketchCandidatesSince`, numbered so an unchanged list isn't sent again) without rebuilding anything — keep
  the build key free of anything about which sketch is open. connect.ts asks after every rebuild result while a sketch is open
  and keeps the answer in `store.sketchCandidates`; the controller appends it after the face's `edges` (so "ref:<n>" ids match)
  and never filters the list (hidden parts/sketches are skipped at lookup, `skipRef`, so ids stay stable). The engine caches the
  list (`candidateCache`) by plane + features before the sketch + later sketches + variables. Lookups near the pointer go
  through a grid (`src/sketch/refIndex.ts`, `nearRefs`/`refSketchOf`), never the whole list: keep pointer moves O(nearby). `RefEdge` may carry `source`
  (another sketch: `{sketch, item, ends, later}`) or `project` (part edge off the plane), and kind "point". Snapping to their
  points brings in only a fixed point with `SketchPoint.link` (`PointLink`: `{sketch, item, end?:"mid"}` or `{partId, ref, end}`,
  `linkPoint`); dimensioning/clicking their curves brings the curve in (`CurveLink` = `PartLink` (+`project`) | `SketchItemLink`,
  use `isPartLink`). Drawing never snaps *onto* their curves (only the face's own edges), so shapes aren't tied to them by
  accident. `followSketch` re-finds them each rebuild (`seeSketchCurve`/`sketchPointAt` from the earlier sketches' built
  versions — a later or deleted sketch = lost; `seeEdge`/`edgePoint3` among all the part's edges) and returns
  `SketchLinkInfo.pointLinks`; `followLinks(s, links, pointLinks)`. Sketches later in the list are offered with
  `source.later` (never snapped to; clicking one says why, `laterMessage`). The controller offers only sketches shown in the view (`sketchVisible`) and
  parts not hidden; clicks prefer the sketch's own geometry, then text/pictures, then outside refs, and the face's own corners win
  ties (`preferFace`). Faint dots near the pointer: `SketchTransient.nearby`.
  Tangent lines (`src/sketch/tangents.ts`): the line tool offers lines touching two circles/arcs (outer + crossing) or
  from a point to one (`tangentLineAt`), made by `addTangentLine` (ends `pointOnCircle`, plus `tangent` to each).
  Circular sketch patterns round a point add `patternCopy` constraints (+ `equal` with extra [1] for
  sizes); copies nothing else holds are left out of the solve and placed afterwards (`splitDerived` in solver.ts).
  Linear patterns add `patternMove` (copy = original moved a set distance along a line, or at an angle; placed afterwards too).
  Splines may carry `tangentsIn` (a point's arriving handle when it differs from the leaving one — left by Split/Trim so the
  pieces keep the exact shape; `reversedHandles` when walking one backwards); an ellipse with `start`/`end` is part of one
  (ends held on it by a hidden block; regions/areas give `ellipseArc` segments). `src/sketch/curves.ts` walks any curve by one
  parameter (`curveParam`), finds exact crossings, cuts exact pieces (`pieceOf`: de Casteljau, conic blossoms) and fits offsets;
  `curveEdits.ts` is Trim/Split/Offset for splines, conics and ellipses. An offset of a spline/ellipse is a spline with
  `offsetParams` held by the `offset` dimension: its points are placed from the original after the solve when nothing else
  holds them, its handles are worked out by `refreshOffsets` (more points if it strays past `OFFSET_TOLERANCE`). Relations
  `normal` (line square to a curve) and `curvature` (G2 where a spline ends on a line/arc/spline); Tangent with a spline or
  ellipse is either at a shared point (`frameAt`) or touching anywhere (`touchGap`).
  Text and pictures: `src/sketch/sketchText.ts` — `SketchData.texts` (hangs from an `anchor` point, so it's dimensioned and
  constrained as a point; letter outlines from `geometry/fonts.ts` are loops in regions.ts and line pieces with ids
  "<textId>.<wordsHash>.<k>" in areas.ts, so picks go "gone" when the words change) and `.images` (data: URLs, shrunk to
  ≤1600 px on insert, to trace over; drawn by SketchLayer, never shapes, not sent to the worker). Many ops build a sketch from
  points/curves/constraints only, so `store.updateSketch` runs `keepSketchExtras`: a MISSING list = "untouched, carry it", a
  present (even empty) list = deliberate; empty lists are dropped on commit (`withoutEmptyExtras`). Code that builds a whole
  sketch outside updateSketch (followLinks, deleteItems…) must spread `...s`.
  Intersect: a link with `cut` ({} = whole part, `face` = one face) is re-found among where the sketch plane cuts the part
  (`GeometryEngine.intersect`/`cutRefs`, BRepAlgoAPI_Section with a big square on the plane); `pruneReferences` keeps them.
  Insert DXF: `src/sketch/dxf.ts` (parse ENTITIES + $INSUNITS; lines, arcs, circles, (LW)polylines with bulges, splines, ellipses, points;
  angles wrapped into one turn, non-finite shapes dropped, ≤20 MB / 20,000 shapes / 50,000 points, `DxfError` = plain message).
- Visibility (the eye in the feature list): `src/model/visibility.ts`. Sketches and Plane features have `Feature.visible`
  (missing = automatic: planes shown; a sketch shown until an unsuppressed feature uses it, `usedSketches` — as Onshape
  hides consumed sketches). The Origin and Top/Front/Right hidden per Part Studio: `doc.hiddenDatums` (first studio) /
  `PartStudio.hiddenDatums`, read with the `activeHiddenDatums` selector. All saved in the file and undoable.
  P (as in Onshape; App.tsx, not in a sketch, drawing or assembly) runs `toggleAllPlanes`: if any of Top/Front/Right or an
  unsuppressed Plane feature is shown, hide them all, else show them all — one undo step; the Origin is left alone. Also in the
  feature list's right-click menu ("Show/Hide all planes", `setAllPlanesVisible`; hiding deselects a picked Plane feature).
  Global shortcuts (`useShortcuts`) ignore keys while any `Modal` is open or pressed inside a role="dialog" popup
  (`src/app/popupGuard.ts`, `inPopup`; `.feature-dialog` panels such as Insert parts excepted), as not every popup is in `store.dialog`.
  The drawing's own keys (Delete, Esc, D in DrawingUI.tsx) use the same check. Side panels that need shortcut keys (Esc…) must not
  get role="dialog" unless they also have the `.feature-dialog` class, or their keys will be ignored.
  `visible` (like folders and sketch pictures) is left out of what the engine gets (`src/kernel/buildInput.ts`), so eye clicks never rebuild.
- Part Studios: `src/model/studios.ts`. The first studio's features are `doc.features` (old files still open);
  more are in `doc.partStudios`. Feature ids are unique across the document. Store helpers `activeStudioId`,
  `activeFeatures`, `studioParts` (cached, selector-safe); feature edits go through `changeStudio`/`inStudio`.
  The engine (`rebuildStudios`) rebuilds only studios whose features/variables/part names changed and returns
  just their meshes; the client carries skipped results forward and the store merges by `studioId`.
- Assemblies: `src/assembly/` — `math.ts` (placements: move + quaternion), `assembly.ts` (pure document edits, parts
  list, parsing), `connectors.ts` (mate connector frames from display meshes), `mates.ts` (mate types, limits and the solver:
  spreads out from fixed parts; loops are only checked), `explode.ts` (exploded-view offsets; display and drawings only), `groups.ts` (Group: parts locked together; the solver links each to the group's first part), `suppress.ts` (suppressed
  instances: `withoutSuppressed` is what the solver sees; exports/checks/parts list skip them), `origin.ts` (mates to the
  assembly origin: connector instanceId `@origin`, a virtual fixed part in the solver), `properties.ts` (part number,
  description, custom properties: `doc.partProperties`), `assemblyCheck.ts` (clash report; `judgeContact` decides clash vs
  touching from the engine's measurements in `src/kernel/clash.ts`). Connectors can sit at an edge's ends, halfway round,
  or where clicked (`MateConnector.spot`/`point`, `spotFrame`). UI in `src/app/AssemblyUI.tsx`; instances are drawn as
  copies of part meshes moved with `SceneManager.setPlacements`.
  Sub-assemblies (`src/assembly/subassembly.ts`): an `Instance` with `subAssembly` (another assembly's id; `partId` "")
  is one rigid piece; its parts sit where that assembly's own mates put them (`solvedInside` in mates.ts, cached per
  document assemblies/parts/variables). A connector on a part inside one has `path` (instance ids down to the part;
  `connectorFrameFor` returns the frame in the sub-assembly's coordinates). Everything that walks parts uses `leavesOf`
  (keys "top/inner/part" — the 3D view's mesh ids, `instanceAt` resolves one) and `kernelInstances` (exports, drawings,
  clash check); the parts list takes `{ assemblies, structured }`; pass `assemblies` to `solveWithParts` whenever the
  assembly may hold sub-assemblies. Circles are refused (`insertProblem`) and dropped when a file is read
  (`tidySubAssemblies`); deleting an assembly takes its copies out of the others (and mates reaching through them). Hidden keys may be paths.
  `paths.ts` (`pathProblem`) says why a connector's path no longer leads to a part (suppressed → the mate shows as not
  used via `mateInactive(…, assemblies)`; gone → a plain mate error). Connectors are always looked up on the part the
  instance shows now (so replacing a part inside a sub-assembly carries parents' mates over). The mate dialog refuses two
  parts in the same copy (`samePieceClick`).
- Drawings: `src/drawing/` — `drawing.ts` (document edits, parsing), `cameras.ts` (view directions; first-angle),
  `annotations.ts` (centre marks/lines, section hatching, balloons), `sections.ts` (section cuts drawn on a view:
  cut plane, camera, letters; views are keyed by `viewKey` — the kind, or "section:<id>"), `sheet.ts` (lays the sheet out as simple line/text shapes in sheet mm, y up), `export.ts` (SVG and a hand-written
  PDF from those shapes, one page per sheet), `hidden.ts`, `pages.ts` (sheets 2, 3… in `Drawing.pages`; sheet 1 is the
  drawing's own fields, so old files open unchanged — work on a sheet with `pageOf`/`changePage`; a sheet may draw its own part or
  assembly, `DrawingPage.source` (null = none chosen), and have its own title and part number, `partTitle` — `pageOf` resolves them,
  `withPage` keeps only what differs from sheet 1, and choosing another part on sheet 1 or removing it leaves the other sheets showing
  theirs, `keepShowing`; "+ Sheet" is a menu: an empty sheet of this sheet's part, or a sheet of any part/assembly with the usual views), `fits.ts` (ISO 286
  limits and fits: H7, g6, H7/g6). A view may have its own `scale` (noted under it; set from View scales, or by clicking the view on the sheet —
  a scale bar and a corner handle that snaps to standard scales via `resizedScale`; `scaleView` sends a hand-placed view back to its
  automatic place if at the new size it would cover another view or leave the border, `viewClear`). Dimension arrows: `Dimension.arrows`
  / `Drawing.dimArrows` ("inside"/"outside"; missing = automatic, drawn exactly as before; Outside adds `ARROW_LEADER` lines; lengths,
  diameters and radii only — `ARROWABLE`), flipped from the panel or by right-clicking the number — decided on button-up, `rightClickFlip` in select.ts, as macOS sends contextmenu on button-down; at a chosen sheet scale `SheetLayout.offSheet` lists views off the paper or on the title block, `offSheetMessage`; the hole table wraps into columns
  when long (`holeTableShape`) or sits where it was dragged (`holeTableAt`). Dragging a dimension by its number (anywhere on its text: `dimTextOutlines` in select.ts) keeps
  the number under the pointer (`dragDimensionLabel`): lengths — across moves the line (`offset`), along slides the number
  (`textAlong`; past an extension line the line carries on to it), Shift lifts it off (`textAcross`); diameters/radii — the
  number goes anywhere, inside the circle too (`Dimension.textAt`, model mm from the centre; `circleLeader`; `angle`/`offset`
  kept roughly in step); chamfers the same (`textAt` from the edge's middle, `dimensionPaperScale`); angles — distance sets the
  arc radius, direction slides the number round it (`textAngle`, degrees from the arc's middle), crossing a line measures the
  supplementary/opposite angle (`rays` from `angleRays`: w = α·u1 + β·u2, as Onshape; `placeAngle` too), Shift keeps the angle and lets it pass an arm (`arcBeyond` carries the arc; one already past keeps its angle on a plain drag too);
  Shift into the opposite angle measures the outside angle (`Dimension.reflex`, `angleSpan`; also "Measure the outside angle" in the panel);
  nearer the corner than the arc's smallest radius (`ANGLE_MIN_R` 4 mm; arc lengths `ARC_MIN_OUT` 2 mm) the number stays under the pointer
  (`textR`, paper mm from the corner/centre) with a short `gapLeader` to the arc; a dragged diameter/radius gets `fitText` (shoulder as long as the
  measured number; missing = chars × 0.55)
  on); arc lengths the same (PlacedDim `arc`/`width`); ordinates — out along the leader is `offset`, sideways a dog-leg
  (`textAlong`, `ordinateJog`); a length slid past an extension line carries its line under the measured text when
  `fitText` (set by new drags; missing = the old chars × 0.55 estimate); missing = drawn exactly as before. Zooming: `src/viewport/zoomGuard.ts` — non-passive wheel and
  Safari gesture listeners on the sheet and on the 3D view's area (canvas + `.sketch-overlay` labels, whose wheels are passed
  on to the canvas) always `preventDefault`, so pinch / Ctrl+wheel never zooms the page there (React's onWheel is passive and can't). The engine's `project()` runs OpenCascade's hidden-line removal per view.
  UI in `src/app/DrawingUI.tsx` (the sheet is an SVG drawn over the 3D view, which stays mounted).
- Sheet metal: `src/sheetmetal/sheet.ts` keeps a sheet as walls joined by bends (base from a sketch, flanges off
  straight edges, flanges on flanges) and works out both the folded walls/bends and the flat pattern from that;
  `src/sheetmetal/profile.ts` turns an open chain of sketch lines into a sheet (first line the base, later lines flanges with a set straight length). `src/kernel/sheetMetal.ts` makes them into solids. The engine stores the sheet on the part (`BuiltPart.sheet`);
  Flange matches picked edges to wall edges (`findSheetEdge`) and fuses the new bends and walls onto the part.
  A flange's `position` ("outside"/"inside" flush) cuts its edge back when the wall is made (`setBack` in sheet.ts; the
  strips cut off are `FoldedSheet.trims`). Corner break (`SheetSpec.corners`, `cornerBreakCut`, `findSheetCorner`) cuts
  wall corners; cuts are traced on walls and bends (`bendCutLines`) and the flat pattern's `boundary` is then taken from
  the part laid flat (`laidFlat` in engine.ts). Bend/Jog are `FlangeSpec`s with a `line` (in the wall's coordinates;
  the piece on its right moves): `splitWall` cuts the wall in two (the line is the bend's middle, so the flat pattern
  keeps the drawn shape); bends already on that wall must be on the piece that stays (they're renumbered); `Bend.moved` is where the moving piece's frame
  goes, and the engine (`bendMaterial`) moves the part's own material there so earlier holes come along. A flange's
  `mitre` (gap) trims walls meeting at a corner along its diagonal as soon as both are bent (`mitreCorner`, `FoldedSheet.mitres`;
  not one up and one down, nor walls that already have flanges); the engine
  cuts the same off neighbours made earlier. Off unless chosen, so old files rebuild the same.
- Sweep: `src/kernel/sweep.ts`. Twist (the "twist" box, degrees; + = anticlockwise seen from the path's end looking back)
  winds a guide curve round the path on a rotation-minimising frame (`twistGuide`) and gives it to OCCT's pipe shell as an
  auxiliary spine; smooth open paths only, at most `MAX_TWIST` (3600°) either way. `sweepControl.lockOrientation` ("Keep profile orientation") uses a fixed
  trihedron and ignores the twist. Twist 0 and no lock take the original `genericSweep` path untouched.
- Surfaces: `src/kernel/surface.ts` (extrude/revolve/sweep/loft of a sketch's open or closed runs — `findChains` in
  `src/sketch/regions.ts` — as shells; Fill from edges; thicken, enclose and offset). A surface part has `surface: true`
  (BuiltPart and PartMesh); solid features add to / cut from the latest *solid* part, never a surface. replicad's
  helpers label every result a `Solid`: wrap surface results with `asIs()` so moves/mirrors don't fail on the type.
  Thicken builds a real solid (skin + offset + walls between their rims); Split takes a surface as the cutter
  (`splitBySurface`); Ruled surface sweeps strips from edges; STEP import brings surfaces in as a surface part.
  Fill `continuity: "tangent"` meets the neighbouring faces smoothly (OCCT filling, G1); Thicken `bothSides`; Delete face
  `leaveOpen` turns a solid into a surface; Extend surface samples curved edges and fills corners, or goes up to a face (a flat one as its whole plane) or
  part (`extendTo`: long strips split by the target, keeping the pieces touching the surface); Enclose failures name
  the open edges (`gapReport`).
- Mirror planes and pattern axes: `src/model/patternRefs.ts` (pure). A mirror's plane is a default plane, a Plane
  feature, a clicked flat face (`mirror.planePick`, found again on rebuild; `plane` keeps where it was when clicked) or a
  sketch line (`mirror.line`: the plane through it, square to its sketch). Patterns use X/Y/Z, a clicked edge/face
  (`pattern.along`/`along2`) or a sketch line (`pattern.line`/`line2`). `unset` = nothing chosen yet (new mirrors and
  circular patterns made in the dialog start so, and ask); the engine's `mirrorPlane`/`pickedAxis`/`lineAxis` resolve them.
  The dialogs' boxes are `ReferenceBox` in FeatureDialog.tsx; sketch lines are clickable in the view (`PickTarget`
  "sketchLine", `SceneManager.setPickLines`) and the chosen plane/axis is drawn (`setReference`) while one is open.
- Variables: `src/model/variables.ts`; `evaluate()` in `src/model/expr.ts` reads the document's current values
  (kept in sync by store.ts; the worker gets them with each rebuild). Changing variables re-solves sketches.
- Zustand selectors must not return a fresh array/object each call (use a shared constant), or React loops.
- Keep pure logic (model, geometry, reports) out of React and covered by Vitest tests.
- Every change: `npm run typecheck && npm test && npm run build`. CI runs the same and publishes `main`
  to GitHub Pages at https://gm7dha.github.io/JuraCAD/. The base path comes from the repository's name
  (`BASE_PATH` in the workflow, read by vite.config.ts and the smoke test), so after a repo rename just run the
  workflow again (Actions › Run workflow).
- Units are millimetres everywhere in the model. A design can be shown in inches (`doc.units`): `src/model/units.ts`
  (`storeLength`/`showLength` save typed lengths with " in" so switching never changes geometry; `useLengthUnit()`
  re-renders components that show lengths). Z is up (Onshape convention): Top = XY, Front = XZ, Right = YZ.
- Running the engine tests without npm: clone replicad (github.com/sgenoud/replicad) and point `node_modules/replicad`
  at a one-line package re-exporting `packages/replicad/src/index.ts`, symlink `node_modules/replicad-opencascadejs` to
  its `packages/replicad-opencascadejs` (the built wasm is committed there), and add tiny stubs for `flatbush`,
  `opentype.js` and `three/examples/fonts/*.json` (only Text needs the real ones). `tsx` then runs
  `tests/engine.test.ts` with the real OCCT in ~10 s, given a small vitest stand-in — far cheaper than CI round trips.
- If the npm registry is unreachable from your environment, push to a branch with an open (draft) PR and
  let CI install, test and build. CI failures are reported as check-run annotations
  (`gh api repos/gm7dha/JuraCAD/check-runs/<job id>/annotations`), readable even when job logs and
  artifacts aren't downloadable.
- `npm run smoke` (`scripts/smoke-test.mjs`) drives the built app in headless Chromium: box → drilled
  hole → colour it blue → section view → check → export STL, STEP and 3MF → edit → undo → sketch (rectangle, dimension, circle) → extrude → P hides/shows all planes, undo → fillet a face → revolve around a construction line → linear pattern → Mirror: click a face for the plane, Top, clear → Circular: Z axis → hole dialog (M4 sizes) → move a copy of a part → add a variable → save to .juracad → New → open it again → import the STEP and STL it exported → assembly: insert copies, parts list, type a position → Fasten mate by clicking two top faces → drag a part → rename a part → check the assembly (clashes) and export it as STEP → explode it → pattern a part → group two parts → sub-assembly: insert Assembly 1 twice into Assembly 2, fasten a fixed part to a part inside one (it moves), flattened and structured parts lists, double-click opens it → add a second Part Studio with a box → Help: download the Claude extension → make a drawing (4 views, title block), add a dimension by clicking two corners, save DXF and PDF → drag a dimension's number, then a slanted angle's (arc follows; across an arm it measures the supplementary angle; Shift into the opposite angle, the outside angle), undo → add a section view, a detail view and an auxiliary view → second sheet → a third sheet of Assembly 1 with its own part number → draw the assembly exploded (parts list); Live with Claude (two chats, a third later; then through Safari's link window with `?liveRelay`) (the page is opened with `?smoke`, which exposes `window.juracadViewport`, `window.juracadStore` and `window.juracadDrawing` (a view's points on the sheet on show) so the test can find faces on screen). To see the result, set `SMOKE_SCREENSHOTS: "1"` in the CI
  workflow; small screenshots then arrive as base64 notice annotations ("screenshot N-name part i/n")
  that can be joined and decoded. GitHub keeps only 50 annotations per job (~12 screenshots), so set `SMOKE_SHOW`
  to the shot names you want (e.g. "assembly,mated"; the emit steps send the 1st…16th chosen shot, whatever its number). Set `SMOKE_SCREENSHOTS` back to "0" before merging.
- JuraCAD for Claude (an MCP server, shipped as a Claude desktop extension): `src/mcp/`. `tools.ts` lists the tools
  (name, description, JSON input schema, handler) and `callTool` runs one — plain functions of a `Session` (`session.ts`:
  the document, undo, a `GeometryEngine`), tested without the SDK in `tests/mcpTools.test.ts` (real OCCT). Inputs are
  checked in `args.ts` (plain-English `InputError`s that say how to fix them); `sketchShapes.ts` turns shapes into real
  sketches with dimensions (kept only when they reduce the freedom); `featureSpec.ts` fills in the same Feature records
  the dialogs make; `picks.ts` numbers faces/edges (F3, E5, "top", "along z") and makes TopoPicks; `render.ts` + `png.ts`
  draw the views; `files.ts` keeps every file inside the chosen folder. A change that fails to build is refused, not kept.
  `server.ts` is the only file using `@modelcontextprotocol/sdk` (v1, low-level `Server`); stdout is MCP, so it logs to stderr.
  CI: `scripts/build-claude-extension.mjs` bundles it with esbuild (+ the wasm, manifest from `claude-extension/manifest.json`),
  `mcpb validate`/`pack` (pinned devDependency) make `dist/juracad-claude.mcpb` (downloaded from Help), and `scripts/check-claude-extension.mjs`
  unpacks it, starts it and builds a bracket over MCP. Locally, with esbuild and a stand-in SDK, both scripts run too.
- Live with Claude (Claude edits the design open in the user's tab): the extension also listens on 127.0.0.1 only
  (the first free port of `LIVE_PORTS` 47615–47624: Claude starts one extension process per chat, so several run at
  once, and the tab links ALL of them — `LiveClient` keeps one `Link` per port, each with its own versions; every user
  change goes to all, a change from any is applied with the usual rules and then pushed to the others; while connected
  it re-probes unlinked ports (`recheckDelay`: every 4 s for the first minute, then every 25 s; paused while the tab
  is hidden, at once on focus/showing — browsers log each refused port), so later chats join by themselves, and drops links whose process exits;
  `tests/liveLink.test.ts` "links every Claude chat" and the smoke test (two chats, then a third) cover it;
  path `/juracad-live`, sub-protocol `juracad-live.1`), via a small hand-written
  WebSocket server (`src/mcp/websocket.ts`, Node http + RFC 6455 frames; no `ws` package). It accepts only the JuraCAD
  site's Origin `https://gm7dha.github.io` — note that's every GitHub Pages site of the account, not just /JuraCAD/ —
  (localhost origins only with `JURACAD_LIVE_DEV=1`, which the smoke test sets), its own Host, text messages up to
  50 MB, and one tab at a time (a connection that doesn't say hello within 10 s is dropped, and a new tab replaces it).
  Each hello starts a new link (versions restart at 1), so the session always re-adopts the new tab's design.
  `src/live/protocol.ts` (pure, shared) has the messages and rules; `src/live/client.ts` is the app's side (only connects
  when "Connect to Claude" is clicked; `src/app/liveLink.ts` wires it to the store, `LiveButton.tsx` is the top-bar
  control); `src/mcp/live.ts` (`LiveBridge`) is the extension's side. The app sends the whole design (as .juracad text)
  and the Part Studio on show with a version number on connect and after every change (undo/redo too); while connected
  `callTool` goes through `LiveBridge.call`: the session adopts the latest design (`Session.adopt`: `doc` is that studio's
  view, `outer` the whole document, `wholeDoc()` puts it back together), runs the tool, and sends any change as `change`
  (based on version N). The app applies it as one undo step (`applyClaudeChange`, label shown as a toast) only if it's
  still at N and no dialog is open, else refuses; refused changes are rolled back (`Session.restore`) and Claude is told
  to look again — nothing is merged silently. Tools are run one at a time. The extension exits when Claude closes its
  input (so the port is freed). Tests: `tests/liveProtocol.test.ts` (pure), `tests/liveLink.test.ts` (real server, the
  real client over Node's WebSocket, real OCCT); `check-claude-extension.mjs` and the smoke test also connect for real.
  Browsers: Chrome 142+ asks the user before a public site reaches loopback ("Local Network Access"; WebSockets from
  Chrome 147); `ws://127.0.0.1` from https isn't mixed content in Chrome/Firefox, but Safari blocks it (WebKit bug 171934,
  still open in 2026), so Safari uses the link window ("relay"): Connect to Claude opens (straight from the click —
  `LiveHost.prepare`, before any await) the extension's small page `http://127.0.0.1:<port>/juracad-relay` (+ `/juracad-relay.js`;
  `relayPageFor` in websocket.ts serves them only for Host `127.0.0.1:<its own port>`, port in `LIVE_PORTS`; no-store, never
  framed, a CSP allowing only its own script and ws to the live ports, NO `upgrade-insecure-requests` and NO COOP — it must
  keep `window.opener`). `src/live/relayTransport.ts` (`RelayTransport`, pure, DOM via `RelayEnv`) tries LIVE_PORTS in turn
  (`portWait` 3 s each: pings the window with postMessage addressed to that exact origin; no pong → navigate the window to the
  next port) and then gives LiveClient WebSocket look-alikes (`makeSocket`), so the live link itself is unchanged.
  The window's script (`src/live/relayPage.ts`, a plain string so the served code is what tests run) only runs on
  http://127.0.0.1, only obeys `event.source === window.opener` with origin `SITE_ORIGIN` (local origins only in dev mode),
  ties itself to the first ping's session id (a new session closes the old links), opens only
  `ws://127.0.0.1:<live port>/juracad-live`, ≤ `RELAY_MAX_SOCKETS`, text ≤ 50 MB, never writes received data into the page,
  and closes everything (and itself) on "bye" or when the opener closes. Sizes are counted in UTF-8 bytes (`fits`). Every pong
  carries a random per-page-load id: while linked the tab pings every `heartbeat` (1 s) and, if the id changes (window
  reloaded) or `MISSED_PINGS` checks AND `deadAfter` (8 s) pass unanswered (sent Back / elsewhere; both, so throttled
  background timers don't trip it), closes every socket (`onLost("broken")`; "closed" when the window is closed). The window
  name is per tab (`RELAY_WINDOW` + an id kept in sessionStorage `juracad.liveWindow`, so a reload of the tab reuses its own
  window, never another tab's). Both files are sent with `Cross-Origin-Resource-Policy: same-origin`, so other sites can't
  load the script to detect the extension. The extensions accept the window's origin
  (`relayOriginAllowed`: exactly `http://127.0.0.1:<one of LIVE_PORTS>`) besides the site's. Closing the window disconnects
  (`relay.onLost`). `?liveRelay` forces this way in any browser (`liveRelayMode` in liveLink.ts; the smoke test uses it).
  Tests: `tests/liveRelay.test.ts` (rules, script, transport; `tests/support/relaySim.ts` simulates the tab + popup with
  real postMessage origin rules) and "Safari: through the link window" in `tests/liveLink.test.ts` (real servers + OCCT).
  Only real Safari can confirm pop-up and opener behaviour (see the PR's manual steps).
- Light/dark: `src/app/theme.ts` sets `data-theme` on <html> (CSS variables in styles.css; use variables, not
  fixed colours, for anything outside the drawing paper) and `store.theme` (the viewport recolours sketches).
- Offline/installable: `public/manifest.webmanifest` + `public/sw.js` (registered in main.tsx, production only);
  bump `CACHE` in sw.js if its caching rules change.
- Versions: bump `version` in package.json and add a CHANGELOG.md entry (with the merge commit) at the end of each
  phase. This session type can't create GitHub releases or push tags, so CHANGELOG.md is the record.
- No `package-lock.json` is committed yet (it couldn't be generated in the first session); add one when
  a session can run `npm install`.
