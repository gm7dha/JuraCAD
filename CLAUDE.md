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
  With nothing open, areas of sketches on show can be clicked to select them, in several sketches at once (`store.areaSelection`:
  `{sketch, areas, more?}`, `selectArea`; `selectionStart` turns it into `sketchRef` + `areas` + `moreAreas`; mode "nearest":
  nearer than the part's face wins, drawn only on hover/selected; an area lying on a face carries `under`, and clicking the only selected
  area again selects that face, `selectedCount`). Extrude/Revolve/Sweep then use it (a sketch highlighted in the list wins), Sketch starts on its plane;
  it's let go on any design change, tab change, dialog/sketch opening or list pick (`areaSelectionLapses`, a store subscription).
  `SceneManager.setPickAreas` takes one `PickAreaSet` per sketch, each drawn as one mesh + one LineSegments, coloured per vertex, rebuilt
  only when that sketch's outlines array (`areaOutlines`, one per map) or plane values change; PickTarget "sketchArea" (sketch + index); both use `toggleArea`, so
  picks are identical; both use `followedSketch` — a face sketch as the engine moved it; "used by all" shading is skipped above
  `MAX_SHADED_AREAS`). Onshape-style parts: Extrude/Revolve/Sweep/Hole made since then carry `apart: true` — New: each separate solid
  piece is its own part (ids `<feature>`, `<feature>~2`…); Add: each piece joins every part it touches, merged into the oldest (others
  removed, their tools re-pointed), else a new part (`addApart` → `joinApart` plan → `commitPlan`, all or nothing); Remove/Hole: cuts
  every solid part it reaches (`partsReached`, `cutParts`; the threaded-hole cache is skipped then); pattern/mirror copies of apart
  features follow the same rules (`applyPattern`). Without the flag (older files) the old rules hold exactly (one part; the latest part).
  Newer still: `intersectAll` (Extrude/Revolve/Sweep) makes Intersect keep the overlap in every part it reaches (`cutParts`, which also
  checks a modelled thread part by part, falling back to the plain hole per part; the threaded-hole cache holds every part's result).
  Merge scope (Onshape's): `Feature.mergeScope` (part ids; missing = Merge with all, exactly as before; `mergeScopePicking` = the box takes clicks — not saved, stripped by withoutPicking/featureForEngine, shows the parts before the feature via `picksPartsBefore`) on Extrude/Revolve/Sweep/Loft (add/remove/intersect), Hole, Thicken, Rib and patterns/mirrors of features (the pattern's own scope, else its source's). Pure `src/model/mergeScope.ts` (`takesMergeScope`, `setMergeWithAll`, `toggleScopePart`, `resolveScope` — ids followed through `mergedInto` —, `scopeMessage`: none picked / all gone = error, some gone = warning). Engine `scopeOf` + `applyScoped`: Add = `addApart(…, only)` (joins only scope parts it touches, else a new part), Remove/Intersect/Hole = `cutParts` on reached ∩ scope (none reached: error, unless patterned); a scoped hole measures depth in the scope only; `thickenScoped`; a rib goes on the newest scope part; applyPattern's copies change only the scope (`only`). Works on old non-apart features too. UI `src/app/MergeScopeField.tsx` (tick + parts box; view clicks in handlePick right after geomPick, Parts list via `toggleDraftPart`). Dependents: a parts list (some lost = partial, all = goes; `usesLatestPart` false). Claude: `merge_with` (part names, "all"). Tests: mergeScope (pure), engineMergeScope, mcpMergeScope.
  An apart hole measures material in the first part the drill meets (`materialAlong`). An Extrude, Revolve or Sweep (solids, `takesSeveral`) may take areas of other sketches too
  (`Feature.moreAreas`: each made from its own sketch with the same settings, fused — a revolve round the axis of its first sketch, which
  must lie in the extra sketch's plane (`revolveMore`, `axisInPlane`), a sweep along the same path (never the path itself, `pathChange`);
  `areaClickChange` adds them when the feature's own areas are picked; the extension's `more_sketches`, and its `sweep` kind; an extra sketch deleted or suppressed is left out with a warning via `buildSolid`'s `notes`). Warnings (built, with something to tell) are kept apart from failures: `RebuildResult.featureWarnings` → `store.featureWarnings` (amber note on the row and in the dialog; not counted by Check; the extension's `tryChange` passes new ones on as notes instead of refusing). Dialogs list only sketches above the feature / rollback bar (`sketchesOffered`); `draftEffect` (partLinks.ts) names
  and lights up the parts an open feature changes (merges come from `PartMesh.joined`, set in `commitPlan`); `threadedReused` counts cache hits; the interactive tool state machine is `src/sketch/controller.ts`; extrusion is `src/kernel/extrude.ts`.
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
  Planes as references (Onshape's): pure `src/sketch/planeRefs.ts` — where Top/Front/Right ("@Top"…) and Plane features cross
  the sketch (`planeCrossing`: edge-on only, a line ±`PLANE_LINE_HALF` (100) about the foot of the plane's origin, running +x/+y)
  and the origin seen square-on ("@origin", only when it isn't the sketch's own) are `RefEdge`s with `source` {sketch: <plane id>,
  item: `PLANE_ITEM` "@plane"} — so they're brought in like other sketches' curves (a construction line linked
  `{sketch, item: "@plane"}`; Delete with dependents counts a Plane feature's as a reference brought in). Not from the engine's
  candidates (its lists are unchanged): the controller (and sketchActions' `sketchRefs`) append `sketchPlaneRefs`
  (planeRefsFor.ts: `framesOf` + `builtFrames`; Plane features after the sketch = `source.later`). No ends/middle (ids q0/q1);
  drawing snaps ONTO them (snapAt step 7, as Onshape infers onto the origin's axes), and onto a default plane's line that is the
  sketch's own X/Y axis that's just `horizontal`/`vertical` with the origin (ops.ts `ownAxis`, nothing brought in). Select,
  dimension, relations, mirror line take them as any reference (bringIn); a Select click (or box) brings one in with no undo
  step and takes it out again once it's neither picked nor used (controller `dropUnusedPlaneLines` → `pruneReferences(s, only)`),
  so clicking along the axes to pick nothing leaves no copies. skipRef: Plane features' lines while their eye is on;
  default planes and the origin always. Engine `followSketch` re-finds them with `seePlaneLink` from `planeFrames` (Plane
  features placed so far this build, reset per build) — later/deleted/suppressed/now parallel = lost (`fromPlanesNote`).
  Tests: sketchPlaneRefs (pure), sketchPlaneRefsStore, sketchPlaneRefsEngine, sketchPlaneRefsRevolve (a plane's line as a revolve axis).
  Drawing feel (Onshape's, controller.ts): `linePlan` decides a line's end + inferred relation (Shift: none; a point/curve snap:
  just that; an "align" snap still gets H or V — whichever the lining up doesn't give —; else H/V within 4°; else `lineRelation`:
  parallel/perpendicular to a "woken" line (`woken`: own lines hovered while drawing + the chain's last line, ≤ `WOKEN_MAX`;
  no parallel through the start) or, starting on an arc's end, `tangent`/`normal` to it) → `LineOptions.relation` in addLine.
  Its badge is `SketchTransient.inference` (H V ∥ ⊥ T N), drawn by SketchOverlay's `.inference-badge` from `controller.current`
  each frame. Mouse press–drag–release in a DRAG_DRAWN tool: `press` (set only by the press that started a shape) + `lastEvent`
  → a release > `RELEASE_PX` (10) away is the next click (a dragged line ends the chain); touch keeps touchLiftClicks. Spline: a click
  on the last point (double-click) finishes it open. Line → tangent arc: `arcMode` (next click = addTangentArc from the chain's
  end, then lines again) by Shift+A (`toggleLineArc`, App's sketchShortcut) or the pointer back onto the last end and away
  (`followReturn`, `returning` fresh/away/back; to an arc only when leaving onwards, so sweeping back past the end for a sharp V stays a line). Midpoint line tool "midpointLine" (`addMidpointLine` in ops.ts: other end
  mirrored, `midpoint` relation on the first point, kept `standalone`), in the toolbar's "line" family. Tests: tests/sketchFeelStore.
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
  ellipse is either at a shared point (`frameAt`) or touching anywhere (`touchGap`). Relations are solved patiently
  (never given up early) so a refusal is real; `signedDistanceToBeziers` skips pieces whose control-point box is farther
  than the nearest sample so far (same answers, bit for bit). The app shows "Working…" first for curve relations
  (`relationMayTakeAWhile`, deferred a frame in sketchActions.ts).
  Text and pictures: `src/sketch/sketchText.ts` — `SketchData.texts` (hangs from an `anchor` point, so it's dimensioned and
  constrained as a point; letter outlines from `geometry/fonts.ts` are loops in regions.ts and line pieces with ids
  "<textId>.<wordsHash>.<k>" in areas.ts, so picks go "gone" when the words change; `SketchText.mirror` flips it left to right about its point, each outline walked the other way — for stamps; "Mirrored (for a stamp)" in the sketch panel) and `.images` (data: URLs, shrunk to
  ≤1600 px on insert, to trace over; drawn by SketchLayer, never shapes, not sent to the worker). Many ops build a sketch from
  points/curves/constraints only, so `store.updateSketch` runs `keepSketchExtras`: a MISSING list = "untouched, carry it", a
  present (even empty) list = deliberate; empty lists are dropped on commit (`withoutEmptyExtras`). Code that builds a whole
  sketch outside updateSketch (followLinks, deleteItems…) must spread `...s`.
  Intersect: a link with `cut` ({} = whole part, `face` = one face) is re-found among where the sketch plane cuts the part
  (`GeometryEngine.intersect`/`cutRefs`, BRepAlgoAPI_Section with a big square on the plane); `pruneReferences` keeps them.
  Use on curved edges: splines and ellipses may carry `link` too. The 3D click asks the worker (`useEdge` request →
  `GeometryEngine.useEdge`, app side `src/app/sketchUseCurve.ts`) for the edge with `RefEdge.shape` (`CurveShape`: an ellipse
  when it is one lying flat to the sketch, else a Hermite spline — points + per-piece tangents from `edgeShape` in engine.ts,
  as few pieces as keep within 0.5 µm, ≤128; `seeShape` in projected.ts; side-on = refused). `linkEdge` makes a spline
  (`splineThrough`) or ellipse with every point fixed; `followSketch` re-samples a linked spline with exactly as many pieces as
  it has, so `followLinks` moves its points and resets its handles; if that strays past 0.5 µm (`USE_TOLERANCE`) it's
  re-read adaptively and `followLinks` respaces it (ends keep their ids, new points between, unless something else uses them);
  an open↔closed change is reported lost. Face edges that are curves
  carry `shape` (Use all edges; `joinTouchingEnds` joins spline/ellipse-arc ends too).
  Seen at a slant, circles/arcs (a part's round edge: `circleOf` from its samples; another sketch's, or its ellipse) are
  `RefEdge` kind "curve" with an ellipse `shape` (`seeConic`: axes from conjugate half-diameters, long axis' end canonical —
  +x, else +y — so it's found in the same place each rebuild; side-on = null, as before only the centre is offered); another
  sketch's spline/conic is a "curve" with its exact cubic pieces (`splineShapeOf`; `CurveShape.tangentsIn` where it arrives
  differently, as Split leaves it). `seeSketchShape` makes these, `seeSketchCurve` returns them (so links follow); a closed
  one's path ends aren't snappable (`refSketchOf`: q ids when `source.ends.a` is missing); a spline's inner points stay lone
  points. The engine's `edgeShape(e, n, circles=true)` adds a circle's frame (`circle`), `seeShapeAll` = seeShape, then a
  slanted conic as an ellipse — used by `useEdge` and by linked *ellipses* only (linked splines keep `seeShape`, unchanged).
  The Use tool also takes other sketches' curves: SceneManager asks `SketchController.useAt` (pure `sketchCurveAt`) before
  picking a part. Shift while drawing/dragging: `snapAt(…, { free })` — no snap, no H/V or tangent inference, no spline
  closing, no join on drop (Onshape's "hold Shift to suppress inferencing"); a tangent arc's first click ignores it.
  Pierce: `PointLink.end === "pierce"` (part edge or another sketch's curve) = where it passes through the plane, re-found
  each rebuild as the place nearest the point's current position (`edgePierces`: `pierceSamples(at, spans)` pieces for snapping and
  rebuilding alike — `PIERCE_SAMPLES` (32), at least 4 per knot span of a spline edge (`edgeSpans` in engine.ts; a coil's
  edge has hundreds), doubled while neighbouring chords turn > 30°, ≤ `PIERCE_MAX_SAMPLES`; `remembered` shares the samples, halving at sign changes, refining near-zero minima between samples, skipping stretches lying in the plane;
  the snap list only walks curved edges whose box straddles the plane, `straddles`,
  `sketchCurvePierces` exactly via `crossings` with the line where the planes meet; `nearestPlace`). The candidates list
  includes those places as `RefEdge.pierce` points (`edgePierceRefs`, `sketchPierceRefs`), so snapping onto one brings in a
  Pierce point; the Pierce relation (`piercePoint` in links.ts, called from `applySketchRelation` with the refs) takes a
  point + a brought-in curve (or a point brought in from an edge seen end-on). Lost ones get their own message (`pierceNote`).
  Extend (`extendAt`) also does splines/conics (the end piece carried on as its own polynomial — `cubicOn` blossoming /
  `conicBetween` past 0…1 — while it turns < 90° and within 10× the sketch's size; `extendWavy`; failing that a spline gets
  a straight piece on along its end direction, `extendStraight`) and parts of ellipses
  (round the ellipse); refused when the solve would pull the end back. Offsets: `src/sketch/offsetCheck.ts`
  (`offsetNotes`, shown in the sketch panel) warns when a copy crosses itself or a line/arc copy turns over; offsets past a
  spline's/ellipse's tightest bend are made (no longer refused) and warned about; an extrude/revolve whose outline uses such a
  copy gets a `featureWarnings` note (`crossingOutlineNote`).
  Insert DXF: `src/sketch/dxf.ts` (parse ENTITIES + $INSUNITS; lines, arcs, circles, (LW)polylines with bulges, splines, ellipses
  (partial ones as ellipses with `start`/`end`, ends joined), points;
  angles wrapped into one turn, non-finite shapes dropped, ≤20 MB / 20,000 shapes / 50,000 points, `DxfError` = plain message).
  Insert SVG: `src/sketch/svg.ts` (pure; XML reader from JuraCUT's svgImport.ts): `parseSvg` → `SvgDrawing` (shapes = runs of
  `SvgPiece`s in mm, y up — path data with relative/implicit commands and run-together arc flags, rect (rounded corners = quarter
  ellipse arcs), circle, ellipse, line, polyline, polygon, through groups, transforms, nested svg and `use` (symbols' shapes; ≤ 8 deep);
  hidden ones skipped; text/images/missing `use`s counted in `skipped`); size: viewBox + width/height in mm/cm/in/pt = `sized`, else
  96 px/in — but a file from Adobe Illustrator (its generator comment / Adobe namespaces / Export As's `data-name` root) not sized
in real units is read in points, 72/in (`illustrator`, `fromIllustrator`); the page's bottom-left corner on the origin (no page size:
the shapes' own). Hidden = `display:none`/`visibility:hidden` in the style attribute, the attribute, or a simple `.class`/`#id`/tag
rule in a `<style>` element (`styleRules`; the XML reader keeps a style element's text). Exact: lines; circles/ellipses and A arcs go
  through `axesOf` (the transformed axes) → circle/arc when round, else ellipse (part: start/end, anticlockwise — flipped when the
  transform mirrors); consecutive cubics (quadratics as cubics) = ONE spline via `splineThrough` (sharp corners between them kept by
`tangentsIn`; an all-curves path back at its start is closed with or without Z; a closed run with < 3 pieces cut in
  half exactly, as closed splines need 3 points); cubics with handles on their chord = lines. `insertSvg` joins ends like insertDxf
  (returns its `InsertResult`), `svgSummary`; ≤ 20 MB / 20,000 shapes / 50,000 pieces, `SvgError`. App: `src/app/sketchInsertFile.ts`
  `insertDrawingText(kind, text)` (both DXF and SVG; the panel's `dxfScale`), sketch toolbar "Insert SVG" opens the same panel
  ("Insert DXF or SVG", two file buttons). The JuraCUT link still takes DXF only. Tests: svgInsert (pure), svgInsertStore,
  engineSvgInsert (square with a round hole, ellipse corners, a curve lens, sharp corners + a pulled-in handle — exact volumes),
  svgInsertFiles (Inkscape / Illustrator / Cricut-style / JuraCAD laser-export fixtures; 5,000 pieces in ~1 s). Over
  `MANY_SHAPES` (300) the message warns that extruding them all is slow (the engine joins separate shapes one by one: 120 ≈ 17 s). `findAreas`
  (areas.ts) looks up nearby boxes through `boxGrid` (same answers; 5,000 shapes ~0.7 s instead of ~15 s).
  The sketch check (`analyzeSketch` → `analyzeWhole` in solver.ts) row-reduces the Jacobian block by block: unknowns joined
  (union–find) through the equations that read them (`dependencies`), entries from `jacobianEntries` (the same numbers as the
  dense `jacobian`), the whole matrix's tolerance; unknowns no equation reads are free. Same answers as one dense reduction
  (`analyzeWholeDense`, kept for tests/solverBlocks), but thousands of loose points (a 400-piece jigsaw) take ~0.2 s, not minutes.
  Copy / paste / duplicate (Onshape's): pure `src/sketch/clipboard.ts` — `copySketchItems` (picked curves/points/text + their
  points; constraints only when EVERY ref is inside; `fix` and anything on the origin/outside left behind; `link`s and orphan
  `offsetParams` stripped; `middle` = the points' box centre), `pasteSketchClip` (all ids new, middle at the pointer, solved;
  returns the ids to select; a dimension whose expression can't be worked out here — a variable the design lacks — is
  pasted as its number from copy time, `SketchClip.sizes`, and `unknownNames` says so; refused if the solve fails),
  `readSketchClip` (kind "juracad-sketch" v1, through validate.ts `parseSketchData` with nothing dropped, unique ids, every
  curve point / handle key / constraint ref / text anchor inside the clip — else null). App `src/app/sketchClipboardApp.ts`
  (Ctrl/⌘+C/V/D in App.tsx's sketchShortcut, toolbar Copy/Paste; kept in memory + localStorage `juracad.copiedSketch`, so it
  pastes into other sketches/tabs). The controller's `startPaste` switches to Select; the copy follows the pointer
  (`pastePreview` via the shared `curvesPreview`, lone points as rings, text as a box) until a click (one undo step; on
  touch it follows the finger and lifting puts it down), Esc/tool change drops it; localStorage's copy wins over memory. Pressing (no
  Shift/Ctrl) on one of ≥ 2 picked things drags them all (`DragState` "group" → `dragSelection`: `moveRigid` of
  `selectionPoints`; refused — nothing moves, a message says why — when the solve doesn't move every point by the same
  amount, so a held point never stretches the shapes; pressing a circle's rim among several picked moves the group). Dimension box: variable names offered while typing (pure
  `src/model/varComplete.ts` `suggestionsAt`/`completeWith`; ↑↓, Tab/Enter take one — Enter on a name typed in full
  sets the size —, a choice or Esc hides the list until more is typed; nothing until typed).
  Tests: tests/sketchClipboard (pure), sketchClipboardStore (controller), varComplete.
  Editing tools (Onshape's): Chamfer (`src/sketch/sketchChamfer.ts` `chamferCorner`: two lines at a corner point; modes equal /
  two / angle (`ChamferOptions`); the corner stays a virtual sharp (pointOnLine on both lines, their `length` dims → `distance` to
  it, as filletCorner) and the cut-off stretches are construction lines sharp → chamfer ends carrying the sizes (`length` on the
  first, `equal` / `length` / `angle` [sign, −1, 1] to the chamfer); `cornerOfLines` joins two picked lines that don't meet at
  their crossing first, keeping the clicked parts). Round between two curves (`src/sketch/filletCurves.ts` `filletBetween`:
  lines/arcs; sharing an end → filletCorner; else the offsets' crossing nearest both clicks, each curve's end on the round's
  side of its click moved to the touch point, length/arcLength/arcAngle dims on them dropped, unused ends tidied). Done again
  with the same size while the tool stays on (controller `lastEdge`, reset on tool change), a round is `equal` to the first
  (`sizeOfRound` / `equalTo` in filletCorner) and an Equal chamfer's size line `equal` to the first's — one dimension sizes
  them all (only while the first is still that size). Slot on a curve (tool "slotAlong", `src/sketch/slotAlong.ts`): offsetCurves/offsetWavy both sides at
  `halfWidthText`, the two offset constraints merged into ONE (its id returned), round end caps centred on the run's end points
  with `tangent` to each copy (open runs only), the source made construction. Drag-trim: in Trim a press starts
  `trimStroke`; let go unmoved = the old click trim, dragged = `trimAlong` (crossing nothing from a press on a curve = still the click trim) (`src/sketch/trimStroke.ts`: the path as a
  CurveParam, `crossings` with every curve in path order, each place's curve found again after each trim) — one undo step;
  touch: `touchDragStarts` is true for trim, the lift's press just ends the path. Elliptical arc (tool "ellipticalArc",
  `src/sketch/ellipticalArc.ts`: centre, axis end, start — sets the width —, end; an ellipse with start/end, short way round; its ends keep their clicks' snaps via placePoint).
  Linear pattern's second direction (rows × columns; `src/sketch/patternGrid.ts` `patternGrid` = patternCurves, then all of
  it again along the second; previewed). Settings in `src/sketch/editToolOptions.ts` (own zustand store, session only; panel
  `src/app/SketchEditOptions.tsx`, which also has the tools' icons). Tests: tests/sketchEditTools, sketchPatternGrid (pure), sketchEditToolsStore, engineSketchEditTools (outlines extruded).
  Editable sketch patterns (Onshape's Edit pattern): new patterns are kept in `SketchData.patterns` (`SketchPatternDef`: kind,
  `sources`, `count`, centre/full/line/reverse, `second` count; `value`/`angle` only a fallback) and their patternMove/patternCopy
  carry `SketchConstraint.pattern` (`PatternStep` {id, n (signed along a line), of (circular share), second}) + `value` = the
  spacing / whole angle AS TYPED, so variables rename and re-solve it (variables.ts already maps every `value`); the solver's
  `patternAmount` = value × n / of (untagged = extra[0], exactly as before; extra[0] is still kept in step). Pure
  `src/sketch/patternEdit.ts`: `patternIdOf` (a copy, its point, an original or a rule), `readPattern`, `editPattern` (fewer =
  the last copies' points deleted with their second-direction copies; more = new copies after the last (`copyCurvesWith`, now
  exported), a grid's rows found by mapping source curves through each row's copy points; copies that stay keep their ids,
  values/extras/`of` rewritten). Copies the user deleted aren't made again unless the count grows past them. keepSketchExtras
  carries `patterns`; withoutEmptyExtras drops defs with no tagged rule left; validate.ts parses both; the clipboard pastes
  tagged rules as plain ones (`plainCopy`); transformSelection scales a tagged plain-number value (a variable refused).
  UI `src/app/PatternEditor.tsx` (panel: "Edit pattern…" when a pattern item is picked, or the menu's "Edit pattern…" →
  `editToolOptions.editingPattern`; Apply → `applyPatternChange`, one undo step). Tests: sketchPatternEdit (pure),
  sketchPatternEditStore, engineSketchPatternArcs.
  Chamfer next to arcs: `chamferCorner` takes line–arc and arc–arc corners (`leaving`, `cutPoint`: straight distance d from the
  corner round the arc, 2·asin(d/2r); the sharp held `pointOnCircle` on the arc; arcLength/arcAngle dims on it dropped; distance +
  angle refused there); two picked curves with an arc must share an end (controller via filletCurves' exported `sharedEnd`).
  Round with circles: `filletBetween` takes circles; a circle the other curve (carried on) crosses becomes an arc (same id) from
  the round's touch point, carrying on the way the round arrives there (`circleKeep`: smooth, away from the corner crossing `X1`),
  to the first place another solid curve of the sketch really crosses it (`crossings`; its end held on that curve with
  `onCurveType`); none = the circle stays whole and the touch point is held on it. The circle is clicked on the part to keep:
  rounds that would cut the click away come last, then the one nearest both clicks.
  Move / copy handles (Onshape's sketch Transform): pure `src/sketch/transformSelection.ts` — `transformSelection(s, ids,
  {dx, dy, angle, scale}, about?)` (about = `selectionCentre`: the box middle of the picked shapes as drawn — `curveOutline`: arcs
  by their curve, circles' full size, splines' paths; a centre or axis point counts only when picked itself): points
  moved/turned/scaled, picked circles' radii and text size/angle, spline handles turned; constraints wholly inside the picked set
  kept — H/V swapped on odd quarter turns, turned other than a quarter: the first H/V line's relation dropped and every other
  H/V line of the whole selection made Parallel/Perpendicular to that ONE line (so no picked shape spins on its own; point-pair H/V dropped); horizontal/verticalDistance swapped
  with signs on quarter turns, else refused (`STRAIGHT_DIMENSION_MESSAGE`); plain-number length dimensions scaled (inches kept, "0.5in" too,
  `scaledValue`), a variable/sum refused (`VARIABLE_SIZE_MESSAGE`); patternMove extra turned/scaled; then solved with `place`
  and refused (`HELD_MESSAGE`, the sketch as it was) unless every moving point and radius lands on its target.
  `transformCopy` = copySketchItems + paste on top + transform. The typed panel (Across/Up/Turn/Scale `moveScale`, Move/Copy)
  uses them too (`makeSketchTransform`; tools.ts' old transformCurves/transformMove are gone, tests/sketchTransform tests this path). Handles: `gizmoPartAt`/`gizmoShapes` (screen px: middle square = move, ring
  `GIZMO_RING_PX` = turn, square on a 45° arm = scale), `snapTurn` 15° / `snapScale` 0.05 (Shift free), drawn as preview shapes
  with `handle: true` (SketchLayer's handle colour). Controller `GizmoDrag` (sketchTransform tool: a press on a handle before
  picking; the middle snaps via `snapAt` ignoring the picked points; turns added up past 180°; live `transformSelection` each move,
  refusals said once; Make a copy ticked = a faint copy, made on release; one sketch undo step via `recordSketchStep`; Esc /
  `cancelStroke` / a tool change take it back; Ctrl+Z/Y wait while a handle is held, `draggingHandle()` in App's sketchShortcut;
  `touchDragStarts(ptr)` true on a handle, `touchLiftClicks` false while dragging one; `zoomed(mmPerPx)`, called by SceneManager
  each frame, redraws the handles after a zoom). While the handles show (Move / copy with something picked) SketchOverlay's root
  has `handles-on`, so dimension labels and relation badges let presses through to the handles (the ring's knob sits on a
  small shape's height label). Pasting:
  `pasteSnap` — the copy's middle snaps like a drawn point (points, line middles, origin, part-edge corners, lining up with points
  passed over; never onto curves; Shift = none). Offered sizes after drawing: Tab / Shift+Tab in the box → pure `nextOffered` /
  `nextOfferedDimension` (a changed value is kept first, then the next or previous one opens; the last one left stays open;
  `tabbing` ref stops the box's blur dropping the offer, reset on focus or a refused value). The box's keys are pure
  `src/sketch/offeredBox.ts` `offeredBoxKey` (Onshape's): anything typed (`typed` ref, even the size already drawn) + Tab/Enter =
  kept; Tab with nothing typed moves on unkept; Enter = `keepOfferedDimension(id, true)` (the rest offered dropped, no box
  reopens); Esc = `sketchEscape` (drops what's offered AND `cancel`s the chain, one press); a letter before anything is typed
  that no variable or `BOX_WORDS` word (pi) starts with (`couldStartName`) goes to the tool keys (blur + re-sent keydown) —
  not once the box was clicked/tapped (`engaged`: every key typed; function names deliberately don't hold letters back, they'd
  swallow L C R A S T M); drawing on keeps a typed, unconfirmed size (`noteTyped` → `discardOfferedDimensions(true)`, the
  controller's pointerDown, which then re-reads the sketch so dropped sizes don't come back); Esc never keeps it. Tests: tests/offeredBox. Use on a face: pure
  `src/model/faceEdges.ts` `edgesOfFace(mesh, face)` (every polyline point — and a straight edge's middle — on the face's
  triangles, within 1/2000 of its size, 1 µm…0.05 mm) → `src/app/sketchUseFace.ts` `takeWholeFace` (each edge the way a click
  does it — curved ones read first through `readCurvedEdge` (sketchUseCurve.ts), flat and curved linked together through
  `linkAllEdges` (ends joined), the rest `copyEdge` as plain shapes — then ONE updateSketch (one undo step), all of them picked,
  the message counting only what came in and saying which follow the part).
  Tests: tests/sketchTransformHandles, faceEdges (pure), engineFaceEdges (real meshes: discs, a plate with holes, a filleted
  top), sketchTransformStore (controller: ring, middle snap, scale + copy, touch, tool change and undo mid-drag, zoom, paste
  snapping, Tab); the smoke test types a rectangle's sizes with Tab and turns it a quarter turn by the ring's knob (checking
  the canvas, not a label, is under it).
  Ease of use (Onshape's): every sketch opens with the Select tool (`newSession` in store.ts: new, edited, on a face). Right-click menu — SceneManager's right-click that didn't orbit (or, on touch, a long press with the
  Select tool and nothing half drawn: `longPressWanted(…, sketchMenu)`, `sketchMenuOnHold`; the stroke is never sent to the
  controller) → `onSketchMenu(at, p, tol)` → `src/app/sketchMenuActions.ts` `openSketchMenu` (the nearest thing under the pointer
  joins the selection) → pure `src/sketch/sketchMenu.ts` `sketchMenuItems` (Finish while `controller.busy()`, the relations
  `relationsFor` (ops.ts: `relationConstraints` gives constraints, Pierce = a point + a linked curve) says fit, Construction,
  diameter ↔ radius / centreline, Copy/Paste/Delete, Show/Hide all constraints/dimensions — always, empty space too; hidden ones still apply, a message says how to get them back —, Select other via `sketchHitsAt`; a right-click / long press on a badge or dimension label picks it and opens the menu, `openSketchMenuOn` — not when the right button moved from its press there (`menuOn`, `MENU_SLOP`), and the label's lift then doesn't toggle it; hiding lets picked ones of that kind go, `dropPicked`) →
  `SketchContextMenu.tsx` (PlacedPopup). View settings: pure `src/sketch/sketchView.ts` (`readSketchView`/`writeSketchView`,
  localStorage `juracad.sketchView`: constraints, dimensions, expressions — `expressionText`), app store `sketchViewState.ts`
  (+ `hideConstruction`, Shift+P, session only; `lit` = `tiedIds` of the badge/dimension under the pointer; the toggles are the sketch toolbar's "sketch-show" group — not the panel, whose height the smoke test's clicks need) → SketchOverlay (hidden
  labels/badges unless picked or being typed) and `ActiveSketch.hidden/hideDimensions` in SketchLayer; Shift+P's `hiddenConstruction`
  (construction curves + points only they use, not picked) is neither drawn nor picked/snapped/boxed (`controller.setHidden` →
  `notHidden`, snaps.ts `pickAt`'s `ignore`) nor in the menu's Select other; `lit` goes by `SceneManager.setSketchLit` (redraws
  only the open sketch, so hovering a label stays cheap). Keys `SKETCH_KEYS` (`sketchKeyFor(code, shift, key)`: the letter of
  `e.key` when it is one — any layout, as the plain letters — else `e.code`; a key closes an open menu: I E B X, Shift+L/O/M/Q/J/U/G/S/P, Shift+F (Round, Onshape's sketch fillet); Shift+A left free;
  tooltips via `relationKey`), run in App's sketchShortcut before its Shift check. Dimensions: pure `src/sketch/dimensionKinds.ts`
  `switchRoundDimension` (value halved/doubled, `scaledValue`; also the ⌀/R button in the value box) and `setCentrelineDimension`
  (`SketchConstraint.doubled` on a pointLineDistance to a construction line: solver uses value/2, `measure` ×2, layout runs to the
  mirror point, ⌀ label, validate keeps it; `measureToOf` null). Sketch toolbar Extrude / Revolve → `finishSketchInto` (commit, then
  startCreate on the sketch just finished; no closed shape = refused, sketch stays open). Tests: sketchMenu (pure), sketchMenuStore.
  The Dimension tool makes the centreline (doubled) dimension when a point + construction line's number is put on the line's
  far side (`dimensionSpecAt(…, centreline)` → `acrossCentreline`; `placedLabelOffset` re-measures the label from the line;
  `addDimension(…, true)`; the preview shows ⌀) — only the controller passes `centreline`, so library/Claude sketches are unchanged.
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
- Delete with dependents (Onshape's Delete dialog): `src/model/dependents.ts` (pure). `findDependents(features, ids)` walks the
  list once, in order (returns `picked`, `dependents`, `going` = both, `partial`): a later feature goes when it can't do without
  something gone — `sketchRef`, `pathRef`, `hole.sketchRef`, a Plane feature (`planeRef` on any SketchPlane it's on or measured
  from: sketch, text, planeDef ref/ref2, split (not with a `toolPartId`), mirror, replace, neutral), a sketch line (`mirror.line`,
  `pattern.line`/`line2`), or a part made by a gone feature (`partMaker`: the id before "~"/"@") picked as a face sketch's `face`,
  text face, extrude `upTo` (only for upToFace/Vertex/Part ends), extend `target`, transform/split/mirror part, mirror `planePick`,
  pattern `along`/`along2` — or when too few of a list are left (picks, pattern/mirror sources, subtract targets/tools, deleteParts,
  simplifyParts: none; union/intersect targets and loft sections: < 2). Also an old-style (not `apart`; not `intersectAll`)
  Add/Remove/Intersect of a solid type (`usesLatestPart`) when the latest solid part's maker (`makesSolidPart`: unsuppressed New
  solids, New fasteners/derived/coils/thicken/sheet metal, Enclose, a Split keeping both pieces, mirror of a part not joined, transform copies,
  patterns of makers; an approximation — Delete part or a Boolean union can change which part is last too) goes —
  else it would silently change an earlier part (a stencil's letters carving the user's block). Losing only some list items, extra
  sketches (`moreAreas`) or sketch references brought in keeps it, in `partial` (shown "Fillet 3 will lose 1 of its 2 picked edges
  and faces"); `withoutGone` rewrites such a feature without them (the engine fails any feature with a missing reference), and
  `deleteFeatures(doc, ids, tidy)` applies it to every feature left when `tidy`, drops the ids from configurations' `suppressed`, and
  (tidy) forgets a library insert all of whose features went, with its variables unless still named elsewhere (`nameUsed`; their
  configuration values too). Not seen without geometry: an edge picked on an older part that a deleted Add feature changed. The
  extension's on_face sketches carry no `face`, so they never count. `outsideUsers`/`outsideLines`: assemblies, drawings and other
  studios' Derived features using parts that go (named, never changed); `deleteQuestion` ("Delete Sketch 2 and the 3 features that
  use it: Extrude 2, Fillet 1 and Hole 1?"). Store `deleteFeatures(ids, justThese?)` (one undo step; tidy unless justThese; clears
  selection/an open dialog on them; a rollback bar on a feature that goes moves to the nearest earlier one that stays),
  `deleteAsk`/`askDelete` → `src/app/DeleteDialog.tsx` (rendered by App): from the row's "Delete with dependents…", the folder's
  "Delete the folder's features with dependents…", or the Delete key when something uses the feature (then "Delete just this" has
  the focus, so Delete + Enter does what it always did; with nothing using it, Delete deletes at once). Plain "Delete" in the menu
  is unchanged (no tidying). Claude: `delete_feature` `with_dependents` (same function, tidied; without it, refused when anything
  would go, untidied). Tests: tests/dependents (pure), deleteDependentsStore, mcpDeleteDependents (real OCCT: a pattern of two cuts
  with one gone and a fillet over two parts still build; a stencil's sheet deleted leaves the user's block whole).
- Part Studios: `src/model/studios.ts`. The first tab's features are `doc.features` (old files still open);
  more are in `doc.partStudios`, in tab order. Feature ids are unique across the document. Store helpers `activeStudioId`,
  `activeFeatures`, `studioParts` (cached, selector-safe); feature edits go through `changeStudio`/`inStudio`.
  Every studio keeps its id for good: the first tab's is `doc.studioId` (missing = "main", `MAIN_STUDIO`), read with
  `firstStudioId(doc)` — never compare with `MAIN_STUDIO` to mean "the first tab" (it may be another studio, and "main" may be
  in `partStudios`). Tabs can be dragged (mouse/pen; window listeners in Overlays.tsx `BottomTabs`, pure `dropIndex` in
  src/app/tabDrag.ts) or moved with the tab's right-click menu (Rename, Move left/right, Delete; a held finger opens it via
  touchCompat): `moveStudio`; any studio can be deleted while another is left: `removeStudio` (also forgets library inserts and
  configuration `suppressed` ids that only lived there). Both go through `withStudios(doc, list)`, which writes the first into
  `features`/`studioName`/`hiddenDatums`/`studioId` (each left out when usual), so a never-moved document — or one moved back —
  is unchanged and saves byte for byte. The app deletes with `deleteStudio` (`src/model/studioUse.ts`, kept apart from studios.ts
  to avoid an import cycle with assembly.ts): removeStudio + `removePartCopies` (assembly copies of its parts and mates reaching
  them through sub-assemblies); drawings and Derived features are left to say their part is gone. `studioUsers` /
  `deleteStudioQuestion` give the plain warning asked first. Store `movePartStudio`/`removePartStudio` (one undo step each) keep
  the studio on show by id. Assembly instances, drawings, Derived (`derived.studioId`), configurations, versions, library inserts,
  live's "studio on show" and the extension (`firstStudioId(s.doc)` for its studio view) all work by ids, so nothing is remapped.
  A document with `studioId` is saved as file format `version: 2` (`fileVersionOf` in document.ts; serializeDocument and
  versions' packDesign), which older JuraCADs and extensions refuse with their "newer version" / "couldn't be read" messages
  instead of silently dropping the "main" entry of `partStudios`; parseDocument reads 1 or 2, readDocumentFile refuses > 2;
  everything else stays version 1, byte for byte. `partCopiesPlan` (assembly.ts) decides per assembly which copies and which
  mates (through a sub-assembly copy, its path walked level by level) go; the delete question names both. Comparing versions
  says "Part Studio tabs reordered". Tab drags end on Esc, window blur or a move with no button held.
  The engine (`rebuildStudios`) rebuilds only studios whose features/variables/part names changed and returns
  just their meshes; the client carries skipped results forward and the store merges by `studioId`.
- Assemblies: `src/assembly/` — `math.ts` (placements: move + quaternion), `assembly.ts` (pure document edits, parts
  list, parsing), `connectors.ts` (mate connector frames from display meshes), `mates.ts` (mate types, limits and the solver:
  spreads out from fixed parts; loops are only checked), `explode.ts` (exploded-view offsets; display and drawings only), `groups.ts` (Group: parts locked together; the solver links each to the group's first part), `suppress.ts` (suppressed
  instances: `withoutSuppressed` is what the solver sees; exports/checks/parts list skip them), `origin.ts` (mates to the
  assembly origin: connector instanceId `@origin`, a virtual fixed part in the solver), `properties.ts` (part number,
  description, custom properties: `doc.partProperties`), `assemblyCheck.ts` (clash report; `judgeContact` decides clash vs
  touching from the engine's measurements in `src/kernel/clash.ts`; an overlap's text says how deep it goes).
  Fit check (`src/assembly/fits.ts`, pure; Onshape/SolidWorks-style interference detection plus clearances): "Check fits
  (interference and clearance)" in the Check window (`ClashOptions.checkFits`, kept with the clash options) measures every pair;
  unticked, an assembly with marks measures only the marked pairs (`engine.clashes(…, fitRange, fitPairs)`); check_assembly's
  `fits` defaults to true. `fitRangeFor(marks)`: `FIT_RANGE` 1 mm, more for a looser marked gap, ≤ `MAX_FIT_RANGE` 3. Within it
  solids get their smallest `gap`, and `pinInHole` (clash.ts: each part's cylinder faces — ≤ `MAX_ROUND_FACES`, all face
  wrappers freed — pin vs hole from the face normal, parallel, side by side along the axis) keeps the deepest overlap ring
  (`over`) and the tightest gap ring (`gap`) apart (coaxial within 0.01 mm; `ContactMeasure.ring` = `over` when the solids overlap,
  else `gap`; `radial` = hole r − pin r, exact), and a parallel pin off by 0.01…range as `offAxis` (judged "the pin isn't lined up
  with the hole", never as an amount). `ContactMeasure.ids` = the InstanceInput ids (leaf keys); overlap Contacts carry them, and
  marked fits are matched by them, never by names. `measuredFit`: depth = −radial for a pin, else `overlapThickness`
  (judgeContact's estimate); amounts are ON THE DIAMETER for a pin in a hole (as printSettings' fits), else straight across, worded
  "0.1 mm on the diameter (0.05 mm a side)". `Assembly.fits` (`IntendedFit`: a/b leaf keys, kind press | printed | clearance,
  min/max mm; `parseFits`; missing = none; `tidyFits` drops marks whose top copy is gone — run by `updateAssembly` and
  `withoutInstances`) marks pairs. "printed" = a printed press fit: drawn with a small gap (printed holes come out small), judged as a
  gap, default range the printer's press fit ± 0.05 (`defaultFitRange`); a "press" mark with a gap says so. `judgeIntended`: OK only
  when measured round (a flat overlap = "not checked exactly", warn); too tight / loose / a gap instead / overlap instead / too far
  apart. `judgeFits` takes marked overlaps out of Clashes (`handled`, id pairs), lists unmarked clearances (pins always; flat gaps
  above the tolerance; off-centre pins) with `printFitHint`, leaves unmarked overlaps as clashes; findings carry `pair` (also "wasn't
  checked" ones, so a stuck mark can be removed). Printed fits: `printFitsFrom` — the design's fit_* variables, else the printer
  settings (app, `printFitsNow`) or DEFAULT_FITS (extension). UI: Check window `ReportView` "Mark as a fit…"/"Change…" →
  `FitEditor` (keyed by the pair; Enter saves), a mate's parts via `matePair` (names with every sub-assembly level); store
  `setAssemblyFit`/`removeAssemblyFit` (`putFit`/`removeFit`: one fit per pair). Claude: `mark_fit` (copy names or a mate; `remove`).
  Tests: tests/fits (pure), engineFits (⌀10.1 pin in ⌀10 = 0.1 on the diameter; ⌀9.8 = 0.1 a side; a stepped pin read by its body;
  a two-pin lid; an off-centre pin; marked press fit OK; flat overlap about; marked pairs only), mcpFits; the smoke test marks
  Fasten 1's parts and removes the mark. Connectors can sit at an edge's ends, halfway round,
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
  parts in the same copy (`samePieceClick`) — except a Width mate's second face on one side, which may be another part of
  the same copy (`MateConnector.path2`; `connectorFrameFor` finds each face on its own part, `widthFrame` between them).
  STEP export of a whole assembly keeps its structure (`src/assembly/stepTree.ts` → `StepTree` → `writeStepAssembly` in
  stepExport.ts: XCAF `AddComponent` with a `TopLoc_Location` per instance; each part — and its mirror image, key
  "~mirrored" — written once; each sub-assembly one product; NAUO names = instance names, PRODUCT names = part/assembly
  names). Exploded view steps can move parts inside a sub-assembly (`ExplodeStep.parts`: instanceId + path, dropped when the path is gone at any depth, `tidyStepPaths`;
  `stepPartOffsets` by "top/inner/part" key, added after the leaf is placed — Viewport and `kernelInstances(…, shift)`);
  in the exploded view a click on such a part selects its key in `asmSelection`. Mirror (an `AssemblyPattern` of kind
  "mirror") can be across a flat face (`plane`: a MateConnector; `solveWithFaceMirrors` solves without those copies to find the
  face, `mirrorFacePlanes`, then mirrors across it, and repeats while any face still moves — chains of face mirrors; a face
  that keeps moving depends on the mirror's own copies, so those copies are held where they are with a plain error) and with
  `samePart` shows symmetric parts as themselves (`ownSymmetry` in symmetry.ts, from the exact `faceRefs`/`edgeRefs` within
  0.01 mm plus face areas within 0.2%; `mirrorAcross(plane, q, own)` reflects through the part's own symmetry plane, so
  the copy is a plain move + turn). A copy with the same hand as its original uses `SolveOptions.symmetry`.
  `ownSymmetry` tries the part's own X/Y/Z first (unchanged), then slanted planes (`OwnPlane.normal`): principal directions of
  the face centres and edge points, flat-face normals and halfway between equal flat faces (≤48); a point grid keeps checks O(n).
  A mirror can also be across a mate connector you place (`AssemblyPattern.placed`: dx/dy/dz, rx/ry typed, on `plane`'s face or
  edge of any kind or an origin plane; `placedConnector`; the mirror is the connector's XY plane; picked with
  `store.mirrorFacePick === "connector"`). Whole sub-assemblies mirror too: a sub-assembly `Instance.mirrored` flips everything in
  it — `leavesOf` walks with a `flip` (places conjugated by `mirroredPlacement`, each leaf's `instance.mirrored` toggled), frames
  flip like a mirrored part's, the parts list gives "… (mirrored)" lines, STEP a product `<sub>~mirrored`; with `samePart` a
  symmetric sub-assembly (`subAssemblySymmetry`: all its parts' faces/edges together) is copied as itself.
  Flexible sub-assemblies (`Instance.flexible`, Onshape's Make flexible; `src/assembly/flexible.ts`): `solveWithParts`, when the
  assembly has one (`hasFlexible`, and `assemblies` is passed), solves `expandFlexible`'s flattened view — each copy kept as a
  frame instance (flag stripped), its instances added as "copy/inner" (recursively for flexible ones inside), its mates/patterns/
  groups/relations prefixed the same way, parent connectors through the copy re-pointed (`resolve`; a Width mate across two
  bodies is refused), the copy's own origin a body "copy/@origin". `SolveOptions.flex`: fixed inner parts are held to their frame
  (links with `flexTop`; `held()` counts them fixed when the frame is), others are "anchored" — started last, at frame ∘ rel,
  only if nothing placed them; inner patterns use their frame's stored placement for directions (`patternFrames`). Results go
  back as the assembly's own placements plus `SolveResult.inner` (key → place relative to the top copy); errors from inside go to
  `flexErrors[copy]`, inner `adjusted` amounts are dropped (never written into the sub-assembly). `solvedInside` of an assembly with
  flexible copies returns the flat keys too, so rigid parents see them. `leavesOf(…, inner?)` uses `inner` (else the cached own
  solve, `flexibleInner`); the Viewport, `instancesForKernel(…, solved)` and `stepTree(…, inner)` (a product per flexible copy,
  `<sub>@<key>`) pass the live one. `connectorFrameFor` goes through flexible copies with `frameThroughFlexible`. Mirrored copies
  and pattern copies are never flexible. Old documents (no flag) take exactly the old code paths.
- Assembly features (Onshape's) and Edit in context. Assembly features: `Assembly.features` (ordinary Feature records — sketch,
  Extrude/Revolve with operation remove, Hole; `isAssemblyFeature`; parsed by document.ts `withAssemblyFeatures` through the same
  `parseFeatures`, ids unique with the studios') + `Assembly.featureParts` (feature id → leaf keys; missing = every TOP-LEVEL part
  it reaches — parts inside sub-assemblies only when listed; `tidyFeatureParts` in updateAssembly; pattern copies keep their ids
  when a pattern is synced, so choices survive; copies a pattern removes drop out). New features made by the app and Claude
  store the parts they reach at creation (so a bolt mated into the hole later isn't drilled). Pure `src/assembly/assemblyFeatures.ts`
  (`cutsFor(asm, key)`, `assemblySketch`/`assemblyHole`/`assemblyExtrudeCut`, `deleteAssemblyFeatures` via `findDependents`,
  `assemblyFeaturesText`, `modifiedCopies`), file-reading bits in `featureParse.ts` (kept light: document.ts imports it). Sketch
  planes are fixed numbers in each assembly's own coordinates (a clicked face is `planeOnFace` with no `face` pick): the cut stays
  where it was made; a copy a mate moves is cut where it sits now. `InstanceInput.cuts` = `CutStage[]` (protocol.ts): one stage
  per assembly level — the deepest sub-assembly's own features first (at the leaf's place in it, by its own solve), out to the
  assembly's own last (at the leaf's solved place; `cutStager`/`hasAssemblyFeatures` in placed.ts) — each with `at` and
  `mirrored` (the hand in that level), so sub-assemblies' holes carry up to every parent and an exploded view moves the cut copy
  on. Through `instancesForKernel`, exports, drawings, the clash check and Claude's tools all get cut shapes. Engine `cutCopy`
  (part coordinates in and out; per stage: mirror, place, `buildSolid` each tool with `[that placed copy]` as the parts, a box test
  first, cut — a cut leaving nothing is refused with a note —, back; LRU cache ≤ 48 by part object + stages; failures go to
  `errors` and, from placeInstances, to exports' `cutNotes` — shown by the Export dialog and export_model). `assemblyCuts` (worker)
  → meshes (part coordinates), `cut`, `reached` per feature (only features that took material), `errors`. Mates on faces only a
  cut copy has (a drilled hole's wall): `SolveOptions.cutMeshes` is a `CutMeshes` (assembly id → its own copies cut by its own
  features, by instance id) → `connectorFrameFor` tries the part first, then the cut copy (`cutMeshAt`, also "copy/inner" keys of
  flattened flexible views), so mates on faces the part always had stay exactly put; passed down through `frameInside`,
  `solvedInside`, `flexibleInner` and `solveFlexibly` (cached per CutMeshes), so a sub-assembly's own mate to its own hole holds in
  its parents and a parent's mate reaches a hole drilled inside one. The solver's copies are cut with each part WHERE THE DOCUMENT
  HAS IT (`storedCutInputs` → worker `assemblyCuts` → `cutMeshesFrom`; ids "<assembly>|<instance>"), never where a solve put it,
  so they depend on the design alone and a solve settles at once (the copies shown are cut at the solved place). A mate on a
  cut-made face of a part the solve moves from its stored place (`cutFaceMoved`, `settledWithCuts`) is switched off and said ("This
  mate uses a face made by an assembly feature on …") only when it is what moves the part: solved without such mates, a part that
  still goes to the same place (moved by something upstream — the part under it made thicker, a Fasten following it) keeps them;
  at most three solves. Drilled copies a Part Studio change moves (the base a plate is fastened to made wider slides it) are
  stored where the solve now puts them: pure `src/assembly/cutSettle.ts` `settleCutCopies(assemblies, parts, cuts)` (only
  non-fixed copies the assembly's own features change; same array when nothing moved; cached, a settled state settles to
  itself; sub-assemblies first, `childrenFirst`) / `settleCutCopiesIn(doc, …)`; the app runs it once per new `parts` when the
  solver's cut copies for them arrive (`settleAfterRebuild` in assemblyFeatureState.ts, through `changeVersions` — no undo step
  of its own; while dragging or viewing an old version it waits for the next answer), the extension's `solve` solves with the settled assemblies (`withSettled`; tools that commit store
  them). So the solver's copy is cut where the copy is shown and a pin mated into the hole stays in it (tests/engineAssemblyCuts4,
  the reviewer's probe: base 40 → 46, plate slides 3 mm). `rememberCutMeshes(assemblies,
  parts, cuts)` lets every solve of that state find them without being passed (`rememberedCutMeshes`; the app's `useSolverCuts`
  once the worker answers, the extension's `solverCuts` in `solve`); a state not cut yet takes the app's latest copies
  (`carryCutMeshesOver`; kept for it when its `storedCutInputs` are the same), so edits never make mated parts jump; Accept / add_assembly_feature settle placements first, so
  the stored places are where the cut was made. `findTarget` gives a cut copy's faces as shown (named by the part's id). "Parts…"
  lists ticks, and "The parts it reaches now" (`reachNow`: every top-level copy tried once, what it really cut kept).
  Structured STEP: a top-level copy the features may cut gets its own definition ("<part> (modified in assembly)", `cuts`,
  `plain`/`plainName`), turned back into the shared plain one by the engine's `withPlainUncut` when nothing was removed (`stepTree`'s
  `cut` set skips them up front when known); when parts INSIDE sub-assemblies are cut (`cutsInsideSubAssemblies`), callers write
  the flat list instead and say `FLAT_STEP_NOTE`. Parts list: `BomOptions.modified` (key → cut volume) → "(modified in assembly)"
  lines weighed as cut (copies with the same volume share a line; flattened lists by full key, structured ones by every copy's key at
  each level — a part inside a sub-assembly is marked when any copy of it is).
  App: `src/app/assemblyFeatureState.ts` (own zustand store: cut meshes for the assembly on show, used by Viewport's
  `instanceMeshes` and connectorAt via `cutMeshFor`; the Hole/Cut draft; `acceptAsmCut` asks the worker what it reaches first;
  actions via `changeDocument`), `src/app/AssemblyFeaturesUI.tsx` (toolbar group "Hole"/"Cut", the "Assembly features" list with
  Parts…/Off/delete and each feature's problem, `AsmCutPanel`, `asmCutPick` first in handleAssemblyPick).
  Fillet / Chamfer as assembly features (Onshape's): ordinary "fillet"/"chamfer" records whose `picks` have `partId` = the copy's
  key, picked on the copy as shown (holes drilled here included). `storedEdgePicks`: an edge the plain part has (`hasRef` — a
  straight edge on the same line overlapping counts, so a notch that shortens it doesn't matter) keeps `ref` in the PART's own
  coordinates (it goes with the copy when a mate moves it); one only the assembly's cuts made (a hole's rim) is kept in that
  level's coordinates with `TopoPick.placed`, as the cut is, and `stageFeatures` (placed.ts, every stage) turns it into part
  coordinates from the copy's place each build (`toPartRef`/`toLevelRef`) — so it never jumps to the nearest other hole; `featureCuts` = has a pick on that key (featureParts unused); `cutsFor` hands each copy only its own
  picks (`onlyPicksOn`, cached objects); `assemblyEdgeFeature`; engine `cutCopy` takes the copy back to part coordinates for
  them and runs the Part Studio's own `applyEdgeFeature` on it alone (`edgeFeatureOnCopy`, `this.parts` swapped), `reached` when
  the volume changed either way. `Assembly.featureNeeds` (fillet id → the features its edges come from; `edgeNeeds`: for picks the plain
  part hasn't got, the features of this assembly that reached the copy without which the edge isn't there — the copy made with
  each left out, asked of the engine by the app and Claude; all of them only if no single one made it; parsed with
  `parseFeatureParts(…, true)`):
  `assemblyFeatureDependents` takes them with a deleted cut. `tidyFeatureParts` drops picks on removed copies (`tidyEdgePicks`).
  App: toolbar Fillet/Chamfer in the assembly-feature group, `AsmCutDraft.edges`/`size`, edge clicks → `toggleAsmEdge`,
  `acceptAsmEdges`. Claude: add_assembly_feature `kind` "fillet"/"chamfer" with `edges` [{instance, edge|edges}] and
  `radius`/`distance`. Not done: Sweep as an assembly feature, picked edges drawn highlighted in the view, a full sketch editor
  in assemblies (points/rectangles/circles only), sub-assemblies' own solve used for their stages even when flexible.
  Edit in context: `doc.contexts` (`EditContext`: studioId, assemblyId, instance key, `parts` = the OTHER parts' {key, partId,
  studioId, placement relative to the edited copy, mirrored}; `hidden`), pure `src/assembly/inContext.ts` (`takeContext` — made or
  taken again for the same assembly+copy, same object when nothing moved —, `updateContext`, `contextProblem`, `setContextHidden`,
  `removeContext`; `tidyContexts` (run by `removeStudio`), `contextGone` (assembly or copy deleted: plain words in the ContextBar,
  and `contextInputs` leaves it out), `contextInputs` in featureParse.ts; parts from the edited part's own Part Studio are left out).
  Engine: `StudioInput.contexts`. Context parts (ids `ctx:<context>:<key>`, `contextPartId`/`contextPartOf`/`isContextPartId`)
  are placed copies of other studios' built parts, kept per studio in `contextBuilds` (`placeAllContexts` after every rebuild, keyed
  by the contexts + their source studios' build keys; `RebuildResult.contextParts` + `contextRebuilt` → `keepContextParts`, never in
  `store.parts`), used for showing, the candidates list (`workOutCandidates` adds them) and useEdge. Only a studio whose features
  USE them (`usesContext`: a `"partId":"ctx:` in its features) is built after their studios (`sourcesOf`) and sees them while its
  features build (`partOrContext` in followSketch); so two studios can each be edited in the other's context, and where both use the
  other's parts the one built first says so plainly on its features (`notBuilt`). Viewport: `useShownContextParts` see-through,
  `withContextParts` for planeForFace/Use; clicking one outside a sketch says it's for reference. UI: an instance row's right-click
  (InstanceMenu) or the toolbar's "In context" → `editInContext`, `ContextBar` (Update context / Hide / Remove). Claude:
  `edit_in_context` (make/update, `hidden`; lists where each other part sits from the copy's origin) and `remove_context` (by
  name or copy) in `src/mcp/contextTools.ts` (tests/mcpContexts). Not done: Claude's own tools using context parts (sketch on /
  Use them); intersect/up-to-face/mates against context parts. Tests: assemblyCutFeatures (pure), engineAssemblyCuts,
  engineAssemblyCuts2 (a sub-assembly's holes in a parent, structured STEP sharing untouched copies, a cut copy's weight, a pin
  mated into a drilled hole, two studios in each other's context + the real cycle said plainly), engineInContext,
  mcpAssemblyFeatures (`add_assembly_feature` — keeps the parts it reached —, `delete_assembly_feature`, a pin mated into the hole,
  the base widened under a drilled plate, fillet/chamfer), engineAssemblyEdges (fillet/chamfer volumes, other copies and a mated
  pin untouched, a hole's rim bevelled and deleted with the hole), engineAssemblyEdges2 (a rim chamfer stays on its hole when the
  plate moves by the holes' spacing; needs only that hole; a notch-shortened edge needs nothing), engineAssemblyCuts4.
- Drawings: `src/drawing/` — `drawing.ts` (document edits, parsing), `cameras.ts` (view directions; first-angle),
  `annotations.ts` (centre marks/lines, section hatching, balloons), `sections.ts` (section cuts drawn on a view:
  cut plane, camera, letters; views are keyed by `viewKey` — the kind, or "section:<id>"), `sheet.ts` (lays the sheet out as simple line/text shapes in sheet mm, y up), `export.ts` (SVG and a hand-written
  PDF from those shapes, one page per sheet), `hidden.ts`, `pages.ts` (sheets 2, 3… in `Drawing.pages`; sheet 1 is the
  drawing's own fields, so old files open unchanged — work on a sheet with `pageOf`/`changePage`; a sheet may draw its own part or
  assembly, `DrawingPage.source` (null = none chosen), and have its own title and part number, `partTitle` — `pageOf` resolves them,
  `withPage`: a sheet of sheet 1's part shares sheet 1's title block (edits there change sheet 1's, as before); only a sheet of its own part
  keeps its own; choosing sheet 1's part on a sheet drops its `source` (it follows sheet 1 again); choosing another part on sheet 1 or
  removing it leaves the other sheets showing theirs, `keepShowing`; `missingPartMessage` names the sheet in the PDF error; "+ Sheet" is a menu: an empty sheet of this sheet's part, or a sheet of any part/assembly with the usual views), `viewParts.ts` (a view
  may show another part/assembly than its sheet's, as in Onshape: the base view has `DrawingView.source`, views projected from it `parent`
  (its id); their keys are "<kind>@<base id>", and sections/details/cuts/shortenings on them have that key as `host` (`ViewHost`);
  `partDrawings` splits a sheet into one drawing per part with views/hosts/dims named by kind as before, so each is asked for exactly as a
  drawing of that part and `rekeyed` back; a sheet without them is its own single part drawing — old drawings lay out byte-identically;
  layoutSheet places each part's lined-up views as its own grid right of the sheet's (`gridSuffixes`), their 3D views in the side column;
  taps per part (`SheetInfo.groupTaps`), parts list/balloons from the first assembly view when the sheet's part isn't one (`withViewParts`,
  `balloonGroup`); `autoDimensionSheet`; Claude's create/edit_drawing take `other_parts`, views named "front of Lid"), `fits.ts` (ISO 286
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
  Crop view (`DrawingView.crop`: `{a, b}` rectangle or `{points, smooth?}` outline, fractions of the view's bounds; pure
  `src/drawing/crop.ts`: `cropOutline` (smooth = closed Catmull–Rom), `clipToOutline` every drawn line in layoutSheet's `draw`,
  points on the outline count as inside (`edgeTolerance`), the view's box shrinks to the crop, dimensions/hole tags/balloon
  targets/detail letters whose points are all outside are skipped (`cropKeeps`), bend lines, detail circles and section lines are
  clipped (a section's arrows sit at the clipped ends); tools "crop" / "cropShape" (click the first point again to close; while
  one is on every view is shown and found whole), panel `CropsList`. Revisions may carry `by`/`approved` (BY and APPROVED
  columns only when any row has them; `addRevision`). `Drawing.standard` "ansi" (`setStandard`: the standard only, nothing moves, a
  no-op when unchanged; projection stays its own choice — the panel only suggests it; inch designs start ANSI;
  `DimStyle.unidirectional`: lengths' numbers read across in a gap in the line). `withProjection(whole, third)` re-places the
  lined-up views on EVERY sheet (panel, templates, edit_drawing). `decimalComma`: `withComma` on every number the sheet works out
  (dimensions, hole table, scale notes and SCALE, bend list, parts list weights) — never on the user's text.
  `inspection`: `Dimension.check` numbers given once by `numberInspections` (store `changeDrawing`, MCP `commitDrawing`; next after
  the biggest on any sheet), so deleting, hiding or cropping never renumbers; `fields` (≤ `MAX_TITLE_FIELDS` 6 entries of the user's own in a
  `FIELDS_H` row on top of the title block, counted in `bottomReserve`). Templates (`src/drawing/templates.ts`: sheet, standard,
  projection, company/drawn by/material, fields, number style; `templateFrom`/`applyTemplate`/`parseTemplates`) kept in
  localStorage by `templateStorage.ts` (`juracad.drawingTemplates`, `juracad.drawingTemplate.default` = new drawings start from it,
  store `addDrawing`). Tables from CSV: a note with `table` (rows; `tables.ts` `parseCsv` — commas, `;` or tabs, quotes; ≤ 60 × 12),
  drawn by `tablePrims`, toolbar "Table". Panel parts in `src/app/DrawingExtrasPanel.tsx`. All missing = drawn exactly as before.
  Claude: `add_revision`, `crop_view`, `set_drawing_style` (drawingExtras.ts). Tests: tests/drawingExtras (pure), mcpDrawingStyle.
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
  From a solid (Onshape's Convert): a sheetMetal feature with `sheetConvert` takes `picks` — flat faces of one part as walls
  (the first is the base) and straight edges where two walls meet as rips; `ripGap` is the gap left there, `flipSide` puts
  the metal outside the faces (else it goes into the part). `src/sheetmetal/convert.ts` (pure, `convertToSheet`) chains each
  face's edges, finds shared straight edges (bends unless ripped), walks them from the base (a ring of bends without a rip,
  a lone wall, a curved wall or bend edge, walls on both sides of the metal are refused in plain words), cuts each wall back
  by its bends' setbacks ((R+T)·tan(θ/2) up, R·tan(θ/2) down — the picked faces stay the metal's face) and at rips (the wall
  later in the walk stops `gap` clear of the other's metal; `offsetEdges`), and gives an ordinary SheetSpec: every other wall
  is a FlangeSpec with `shape` (its own outline, edge 0 the bend, may reach past the bend's ends) — foldSheet uses it instead
  of a rectangle (no straight/inset; closeCorners and mitres leave such walls alone). It checks that foldSheet puts every wall
  back on its face. The engine (`applySheetConvert`) replaces the part's shape with the folded sheet and lists all its earlier
  features in `sheetFeatures` (so the flat pattern doesn't call them missing); faces of the part not lying within some wall's
  thickness (a boss, a thicker wall) get a `featureWarnings` note, as the sheet leaves them out. While its dialog is open (new
  or edited) connect.ts builds `convertPreview`: the features before it, then it with `sheetConvertCheck` (engine copy only,
  never saved) — checked, errors/notes shown, but the part left as it was, so its faces and edges stay clickable (the smoke
  test clicks a shelled box's five walls one by one, then a rip). Starting Sheet metal with flat faces of a solid, non-sheet part
  selected opens it in this mode. Not in the Claude extension (it has no sheet metal tools yet).
- Sweep: `src/kernel/sweep.ts`. Twist (the "twist" box, degrees; + = anticlockwise seen from the path's end looking back)
  winds a guide curve round the path on a rotation-minimising frame (`twistGuide`) and gives it to OCCT's pipe shell as an
  auxiliary spine; at most `MAX_TWIST` (3600°) either way. `sweepControl.lockOrientation` ("Keep profile orientation") uses a fixed
  trihedron and ignores the twist. Twist 0 and no lock take the original `genericSweep` path untouched; smooth open paths keep the
  single-guide path. Sharp corners and closed loops are built stretch by stretch (`pathStretches` → `stretchedSweep`; the pure
  planning is `src/kernel/sweepPath.ts`): a closed loop starts where the profile's plane crosses it (`profilePlace`/`loopFrom`), a
  twist on one must be whole turns (`wholeTurns`); the twist is shared by length over the stretches between corners, and within
  `cornerRoom` of each corner (1.1 × the profile's reach, more for corners sharper than 90°) the profile goes round untwisted on a
  plain RoundCorner pipe (`twistStretches`). Each stretch starts from the drawn profile moved rigidly to its start frame
  (`placedSection`, frames carried by `carryStep`/`carryThrough`) — not from the previous pipe's end, which OCCT returns as
  BSplines that break round corners — and the pieces, which only touch end to end, are fused with `JOIN_FUZZ`. Kept facing one way,
  a closed loop is its smooth runs moved along (a smooth loop is refused: it always goes edge-on somewhere). Surfaces still refuse
  twist round corners and loops.
  Onshape's further choices (`Feature.sweepControl` = `SweepOptions`, pure `src/model/sweepOptions.ts`; all missing = exactly as
  before, `sweepSettings` gives the old `{twist, lockOrientation}`): Profile control None / Keep profile orientation / Lock profile
  direction (`lockDirection`: a GeomPick — edge, face normal/axis, X/Y/Z, sketch line, connector's Z — found by the engine via
  `PathLookup.direction` = findGeom "line"; OpenCascade's binormal SetMode(gp_Dir); refused where the path runs within 1° of it,
  `runsAlong`); Lock profile faces below. Twist `twistBy` angle (the "twist" box) / "turns" / "pitch" (lazy params `turns`,
  `pitch`: 360 × length / pitch, the length measured on the built path, `twistOf`) + `opposite`. Scale (`scaled` + lazy `scale` =
  the size at the end / at the profile): `addSection` → SetLaw with a Law_Linear (its range is spread over the path BY LENGTH, the
  section scaled about the path; RoundCorner + a law throws, so corners are stretches: `pathStretches(…, corners)` builds the
  rounded-corner plan even untwisted, `stretchedSweep(…, size)` shares the change by length over the stretches that aren't corners,
  each corner keeps the size it starts with (`scaledAbout`); a locked direction with corners tries RightCorner, which OpenCascade doesn't manage with a law in practice, so it's refused naming the corners, `SCALE_CORNERS_LOCKED`; likewise curve/edge paths with corners); refused
  round closed loops. A profile part way along an open sketch path, when scaled or twisted round corners, is swept both ways
  from it (`startOnLoop` → `splitAtPlace`, `shareHalves`: twist by length, the half walked backwards keeping its sign; size 1 at
  the profile, the far end `scale`, the start 1 − (scale − 1)·before/after, refused ≤ 0) and the halves fused; along a curve
  feature a scale needs the profile at an end (`midSpine`). Keep profile orientation refuses any stretch of the path lying in the
  profile's plane (`edgeOnAlong`, open paths too — a leg there made a flat fin). Profile from a part's flat face
  (`sweepControl.face`, `faceProfile`: outer + inner wires; `SweepProfile` is what both sketch and face profiles give the
  sweeps — `sketchProfile`, `sweepAlongSketch`, `sweepProfileAlongSpine`); no thin / more sketches / surface with a face. Surface
  sweeps along curve features and part edges (`sweepSurfaceAlongSpine`), with scale/direction too. Clicks: `sweepControl.picking`
  "face"/"direction" (not saved; stripped by withoutPicking/featureForEngine) → `sweepClick` in geomPick.ts. Dependents:
  `sweepPartsUsed`/`sweepFeaturesUsed`. Order checks in buildSolid/sweepSpine go by id (thin and extra-area sweeps pass copies).
  UI `src/app/SweepOptions.tsx`. Claude: sweep `profile_face`, `twist_turns`/`twist_pitch`/`twist_opposite`, `lock_direction`,
  `scale`, `surface`. Tests: tests/sweepOptions (pure), engineSweepMore (thin/extra areas along a helix, the fin refused, mid-path
  twist round a corner and its sign, turns/pitch = angle, exact frustums, mid-path scale, corners, a helix scaled, locked
  direction, face profiles with a hole), mcpSweepMore.
  Lock profile faces (Onshape's): `sweepControl.lockFaces` (TopoPicks of one part's faces; picking "lockFaces" toggles them,
  `sweepClick`; Profile control "faces"; dependents via `sweepPartsUsed`) — only along `pathEdges` that are edges of those faces
  (sketch/curve paths refused, `LOCK_FACES_PATH`); no twist, no scale. `src/kernel/sweepFaces.ts` `sweepLockedToFaces`: the path's
  edges walked in order (`walkedEdges`; a reversed edge's ends read as it's turned), cut into runs at > 1° turns and where the
  path passes onto another locked face (a loop starts at one; a smooth change of face needs the faces to meet within 2°,
  `FACES_TURN`), so each run lies on ONE face; each run a pipe-shell
  from the drawn profile placed by frames whose reference is the face's normal (`frameOn`, `placedSection`): a flat face = fixed
  binormal SetMode(gp_Dir) (the support mode throws "Adaptor3d_CurveOnSurface:EvalDN" on some planes' edges), a curved one
  SetMode(its own face — a compound of several fails on a fillet's arc between flat sides); each sharp corner a plain RoundCorner pipe
  over two short legs (≤ the profile's reach, ≤ half each run), refused when the faces don't turn with the path there
  (`CORNER_TWIST`); all fused (`fuseInto`). The profile anywhere on the path (`profilePlace`; open paths fall back to the start). Claude: sweep
  `lock_faces` (face choices of path_part, or {"part", "faces"}). Tests: tests/sweepLockFaces (pure), engineSweepLockFaces
  (a 2 × 2 lip round a 40 × 30 box's top edges = 2·((42·32 − 38·28) − 4(1 − π/4)) exactly, sound; a lip round a slanted cut's
  ellipse kept on the cylinder (r ≥ 10) where a plain sweep tips 1 mm in; refusals; a lopsided profile stays the way up drawn;
  a filleted box's top and a cylinder's rim = Pappus; a profile part way along an open path), mcpSweepMore.
- Loft (Onshape's): plain lofts (no `Feature.loft`) take the old `loftSketches`/`loftSurface` path untouched. `Feature.loft`
  (`LoftDef`, types.ts; pure helpers `src/model/loft.ts`, parsed by `parseLoftDef`): `profiles` (sections in order — `{sketch,
  areas?, turn?}` (one picked area), `{face}` (a flat face, its outer wire), `{point}` (a `GeomPick`: sketch point, part corner or
  plain p; first/last only, `profilesProblem`); `sections` is kept = the sketches among them and `profiles` dropped when all are
  whole sketches, `withProfiles`), `start`/`end` (`LoftEnd`: normal | tangent (a point's rounded tip) | matchTangent/matchCurvature
  (a face's neighbours), `magnitude` ≤ 4; `endChoices`), `guide`/`path` (`LoftCurve`: a sketch's one run or part edges),
  `matchCorners` (+ each section's `turn`; sketch sections with equal piece counts; ThruSections' CheckCompatibility off),
  `periodic` (the first wire added again: OCCT closes the ring), `picking` (what a view click chooses: `loftClick`, via geomPick).
  Engine: `src/kernel/loft.ts` `buildLoft` (resolves through a `LoftContext` from buildSolid). OCCT's loft has no end
  conditions. Between two parallel outlines (no guide/path/matchCorners/ruled) they're `easedStations`: the plain loft cut
  across at h(t) and moved square to the shapes to t, `easing` h = t − t(1 − t)^k (k = 4/m, curvature 2/m; the end's the
  mirror image, both composed) — flat at the end, about as full as a plain loft at magnitude 1, never past either outline;
  cut edges rebuilt light (`lighter`, else the loft through them takes minutes); a face's neighbours' slope (`faceSpread`)
  grows the cuts. Otherwise helper copies of the end wire 0.01·D and ≤ 0.3·D out (shrinking capped at diag/8; inward =
  flipped, `helpers`). A rounded tip = the neighbour scaled cos θ, moved sin θ square to it and 1 − cos θ across (θ 25…82°),
  so an off-centre tip isn't passed. Faces with holes refused. Guide (one): the unguided loft cut at `STATIONS` planes,
  each outline stretched along the guide's direction only, from its far side (`guidedStation`: lines exact, curves as
  B-splines), lofted again. Path: BRepOffsetAPI_MakePipeShell (RightCorner transitions) with every section; each must sit
  on the path (`offPath`, else refused) and starts where the first one's start is carried along the path
  (`alignAlongPath`: a rotation-minimising reference), else the pipe twists between them. `loft.picking` is stripped by
  `withoutPicking` and `featureForEngine`. Dependents: `loftUses`/`loftWithoutGone` (sections a list of ≥ 2, guide/path
  needed); `loftSketches` for the eyes and partLinks. Claude: add_feature "loft" (sections, start_point/end_point, start/end,
  magnitudes, guide, path, straight, match_corners + turns, closed_loop; `applyLoft`). UI `src/app/LoftOptions.tsx`. Not done: end conditions eased only between parallel outlines.
  Tests: tests/loft (pure; picking stripped, ends tidied), engineLoft (exact pyramid/cone, dome, off-centre tip, upright
  sides at a normal start and on a box's top face, no lip at any magnitude, into-the-part refused, holed face refused, guide
  moving one side only, arc and L paths' volumes and ends, a shape off the path refused, twist, ring), mcpLoft.
  More (Onshape's): new lofts carry `apart` + `intersectAll` (createFeature; document.ts keeps them for lofts), so Add/Remove/
  Intersect reach every part — old lofts the latest part as before. Sections all on one plane are refused
  (`samePlaneProblem`, both paths; not along a path; only some on one plane builds as before). When a loft with helper copies fails,
  the end wires are split as a plain loft splits them (`compatibleEnds`: the plain loft's edges lying on each end, joined) and it's
  tried again — OCCT's own splitting gives up once helpers are added (a square to a slanted circle); older lofts build unchanged. Ruled + any end condition refused. Sections may be curved faces (outer wire; `curved`: ends dropped with a note; a
  solid closes that end with the face itself, `closedWithFaces` → encloseSurfaces, New only — fusing along the shared face fails)
  and `{edges}` (part edges, `chainEdges`; open only for surfaces; `toggleSectionEdge`, picking newSectionEdges/sectionEdges).
  `LoftCurve` `{curve}`: a curve feature as guide/path (`LoftContext.curve`, engine via the `loftCurves` WeakMap per features list;
  an open one walked from the end nearest the first shape). Ends `profileTangent` (copies a hair on and grown/shrunk a lot,
  `PROFILE_STEPS`, grow towards the neighbour's size) and `direction` (`towards`: a GeomPick — axis, edge, face normal, plane,
  connector, sketch line; `dirOf`; copies moved along it; lying in the plane refused; picking startDir/endDir, lineFromClick).
  Thin (`Feature.thin`, lazy `thickness`/`thickness2` params, ThinOptions): `thinLoft` — each sketch section's ring from
  `thinSketches` → outer and inner outlines (`Overrides`), both lofted with the same settings, inner cut away; points, faces,
  edges and a guide refused. Claude: `surface`, `thin…`, guide/path a curve name, sections `{part, edges}` and curved faces, ends
  `tangent_to_profile` / `direction` + `start_direction`/`end_direction`. Tests: loftMore (pure), engineLoftMore (two boxes
  cut and joined exactly, same plane, slanted ends sound, fit spline path/guide, curved face and box-edge sections, flared and
  directed ends, thin volumes exact), mcpLoftMore. Not done: curved-face sections joined to their part, thin with faces/points.
  Several guides, connections, sketch-on-face ends: `LoftDef.moreGuides` (guides after `guide`; `loftGuides`/`withGuide`) and
  `connections` (`LoftConnection` = `{points: GeomPick[]}`, each point found on the section it lies on, so section order doesn't
  matter); missing = as before. One guide alone (parallel sections or not) keeps the old `guidedStation` path exactly (main built
  tipped tops that way; volumes must not change); 2+ guides, guides with a path or with connections go through `guidedLoft`: the unguided loft
  (ThruSections, or `pipeLoft` along the path) cut at `STATIONS` planes per gap — origin/normal interpolated between the two
  sections (normals turned to face along the loft), along a path square to it — and `warpedStation` bends each cut in its
  plane (pure `src/geometry/warp2d.ts`: anchor = the outline's farthest point from its middle towards the guide's crossing
  (`outermostTowards`, ties by nearness; else `rayHit`), so nothing pokes out past a guide; one guide = `stretchTowards` (along
  the guide's way, far side kept, as guidedStation); `fitWarp` 2 = the affine closest to identity (stretch/shear along the line between the
  anchors), 3+ = thin-plate spline; lines stay lines only for affine warps); guides swapping places between stations (any pair's
  difference vector turning round) or missing a section are refused, named "guide curve k"; stations ordered by `alongLine`
  (the path, or the line through the section middles). Connections (`connectSections`): every wire walked the same way round
  (`chainOf` + Newell `windingAbout` against the way along), split at its connection points (`placeOnChain`, `splitPiece`),
  each stretch between connections given as many pieces as the shape with most there (longest pieces halved), restarted at
  connection 1 (`pieceEdge` rebuilds lines/arcs exactly, other curves fitted; whole edges kept/reversed), then lofted with
  CheckCompatibility off (`lined` = matchCorners || connections; not both); stations of a lined guided loft are restarted near
  the interpolated section starts (`restartNear`). Refusals: a connection with no / two points on a shape, two at one corner,
  different orders round the shapes. Sketch-on-face ends: `endChoices(p, sketchOnFace)` / `tidyEnds(…, onFace)` (app: the
  plane's `face`; Claude: any non-default plane) offer match tangent/curvature; the engine's `faceUnder` uses `SketchPlane.face`,
  else a flat face of a part (`LoftContext.allParts`) lying in the sketch's plane with the whole outline on it
  (faces of two parts there = refused, never guessed); `spreadOf` its neighbours,
  `Section.adjacent` (as `isFace` for the checks), normal turned out of the part; none = refused plainly. UI: guide list (+ Add
  another guide curve; picking `moreGuide:<k>` for edges), Connections fieldset (per section sketch a corner select —
  `cornerPoints`, `setConnectionSketchPoint` — and "Click corners of faces…", picking `connection:<k>` → `loftClick` corner or
  edge end, `toggleConnectionPoint`; `cornerWanted` turns corner picking on). Dependents: guides needed (`loftUses`); connection
  points on gone sketches/parts dropped by `loftWithoutGone`. Claude: `guides` (list), `connections` ([[x, y, z], …] per
  connection), match_tangent on sketch sections. Tests: loftGuides (pure), engineLoftGuides (two/three guides, crossing and missing
  refused, tipped top, guides along a path, square straight/twisted by connections, square→hexagon, sketch on a frustum's face =
  the face's own result, found without the pick, refused off any face), mcpLoftGuides. Not done: clicking sketch points in
  the 3D view for connections (chosen in the dialog's lists), connections on circles (no corner to pick), anchors that follow a
  guide by its own touch point rather than the ray from the middle (very lopsided shapes).
  Guide continuity (Onshape's): a part-edge guide may carry `continuity: "matchTangent"` (+ `otherFace`; `LoftCurve` edges
  variant, parsed in document.ts, kept by `toggleEdge`; `GUIDE_CONTINUITY`/`guideContinuityOf`/`withGuideContinuity` in
  model/loft.ts; a "Continuity" select under each edge guide in LoftOptions). Any such guide sends the loft through `guidedLoft`
  (no continuity = the old paths exactly); `facesBeside` gives its first edge's two faces; in `warpedStation`, after the warp,
  pure `src/geometry/guideTangent.ts` `tangentBend` turns the outline near the guide point (cosine fade over `BEND_REACH` 0.35 ×
  its size) so it leaves along the face carried on past the edge (`awayFromFace`: the face's normal × the station's, away from
  the face): at a corner of the outline only the branch nearer that way, on a smooth stretch both; a face a branch already
  runs into (the loft sits on it) is skipped, so the other is matched; `otherFace` prefers the second. The user's sections stay
  as drawn (matched between them only). Claude: guide/guides items {"part", "edges", "continuity": "match_tangent",
  "other_face"} (`loftGuideOf`). Tests: loftGuideTangent (pure), engineLoftGuideTangent (a leaning triangle on a box's top edge:
  the loft's side within 4° of the front face at x 12…28, ~20.6° without), mcpLoftGuides. Not done: Match curvature, Normal to
  guide / Tangent to guide (sketch and curve guides).
- Thin (Onshape's "Thin" on Extrude/Revolve/Sweep, solids): `Feature.thin` (`midPlane`: the whole `thickness` centred; else
  `thickness` on the first side + `thickness2` (default 0) on the other; `flip` swaps; missing = solid, old files unchanged;
  params in group "thin", shown by `ThinOptions` in FeatureDialog.tsx, hidden by `visibleParamKeys` unless thin — only that type's group "thin" params, never Shell/Thicken/Rib/Sheet metal/Gusset's own `thickness` (tests/visibleParams pins every type's boxes hidden at first); draft hidden).
  Pure `src/sketch/thin.ts` `thinSketches(data, sides, { keep, axis, areas, verb })`: with areas picked, a ring round each
  picked area's outline and holes (`map.join`), first side into the area; else every curve: `sketchRuns` (findChains with
  branching, then a junction group's curves joined end to end through points where just two meet — only real junctions
  (3+ ends) split runs; a run back at its own start is closed). Closed runs anticlockwise (first side inside); open runs
  `facing` the area they border (an area on just one side → that side first; else from the bottom-left end), and open runs
  with no area either side take their side from the wall they carry on from at a junction (`settleFreeRuns`: the
  smallest turn, the first side kept on the same hand). Offsets
  (`offsetPieces`: lines/arcs only, splines/ellipses refused; neighbours carried on or cut back to where they meet; an
  outside corner reaching past `MITRE_LIMIT` (4) × d is cut off square, `squareCut`); open ends square, but at a junction each
  pair of neighbouring arms (sorted by angle) is settled by `junctionGap`: a gap past a half turn has both facing sides
  carried on to meet (≤ MITRE_LIMIT, else a shared midpoint); in a narrower one a wall facing into it is carried on to the
  neighbour's facing face (its line where it has no thickness there) when that lies behind its end — so one-sided walls
  join along a face, never at a point — and a square end is cut back to the neighbour's far
  face when it reaches past it (a wall stays on its own side of the other line: no spilling into the next area or out of
  the shape); closed runs through a junction keep their own mitred loops. Too thick = a plain `ThinError`. Each run → its
  own SketchData (original points + construction lines kept; revolve axis line and solid lines lying on the axis turned
  construction, `withoutAxis`). The engine's `buildThin` (top of `buildSolid`) builds each as the feature would (same ends,
  depths, axis, path), fuses them, ignores other sketches' areas and a draft (notes say so; inner notes passed on).
  `areasTaken` skips thin features (a floor can fill the wall's area later). "Surface" is the other checkbox (a skin);
  the two are exclusive. Revolve "Two ways": `revolve.second` + `angle2` (not with `symmetric`): revolved by angle + angle2
  (`twoWayAngle`, ≤ 360) then turned back by angle2 (`twoWayRevolve`; `revolveMore` too); dialog One way / Symmetric / Two
  ways through pure `revolveWay` (features.ts: switching to Two ways keeps the sum ≤ 360 — 360 + 90 → 180 + 90). Claude:
  `thin`, `thin_other_side`, `thin_centred`, `thin_flip` (areas kept; more_sketches and a draft given with thin refused; a draft already set is left for the engine to skip) and revolve's
  `second_angle` (featureSpec `thinWall`). Tests: tests/sketchThin (pure), engineThin, mcpThin.
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
  Boundary surface (Onshape's): feature "boundary", `Feature.boundary` (`BoundaryDef` u/v lists of `BoundaryCurve` — a part
  `edge` TopoPick (+ `match` tangent/curvature: the face beside it; `otherFace` = a solid edge's second face), a `curve` feature or
  a `sketch`'s one run; ≤ 2 each way, `picking` not saved/not sent to the engine). Engine `boundaryShape` (the face used is named in
  a featureNotes note) → `src/kernel/boundary.ts` `boundarySurface`. No match: BRepOffsetAPI_MakeFilling with the curves as edges,
  an open outline closed by straight lines (one open run: one line; two: two, uncrossed). Matched (`matchedPatch`; one pair only,
  both U or both V): Hermite across the pair — cubic (tangent: slope = the face carried on past the edge, `acrossFace` (away from
  the face, decided mid-edge), × the span) or quintic (curvature: slope × `CURVATURE_REACH` 0.6, second derivative = the face's
  bend from a point h back, κ·|slope|²; an unmatched end bends as the cubic would) + Coons correction for V curves (which must
  leave a matched edge within 10° of the face, else refused). Made ONE B-spline surface by tensor interpolation (`interpolate` =
  GeomAPI_Interpolate at given parameters, so every row shares knots): across (cosine-spaced t, the blend's exact end slopes
  `Load`ed when there are no V curves), then each pole along, at places `spread` over the stretches between both curves'
  C3 `breaks` (else a spline curve's own knots cap convergence); `bsplineSurfaceAt` (local Cox–de Boor) measures each curve
  against the surface's edge at ¼ ½ ¾ between places; along/across grow ~(gap/1e-4)^¼ × 1.6 (h⁴) within `MOST_ALONG` 1025 /
  `MOST_ACROSS` 129 / `ROUNDS`, else refused; `makeBSplineFace`. Not tried again: the filling with G1 (folds back over the
  face), LoadInitSurface (crashes on curved edges in this build), lofting rows (wiggles along). Curves with a sharp corner
  (> 1° between edges, `hasCorner`) are refused with a smooth side. Face blend (Onshape's): feature
  "faceBlend", side 1 = `picks` (faces), `Feature.blend` (`FaceBlendDef`: `side2`, `flip1`/`flip2`, `noTrim`, `picking`), param
  `radius`. `src/kernel/faceBlend.ts` `faceBlend`: per pair of faces the spine = section of the two faces moved out by r
  (MakeOffsetShape skin) to the ball's side — tried (+,+), (−,−), (+,−), (−,+), flips relative to the side found; arcs from the
  nearest points on each face lofted (ThruSections; 2 sections on a straight spine, a closed spine re-adds its first). Engine
  `applyFaceBlend` (a featureNotes note says which side the ball rolls on): trimmed + all faces on one solid that share edges →
  those edges filleted (= the rolling ball; flips refused; faces meeting none of the other side's left out with a warning);
  trimmed surfaces: `trimAndJoin` — each cut where the blend touches it (`trimUnder`: a thin strip square to the face through the
  touching points, carried only 2r + 1 past its ends, BRepAlgoAPI_Splitter, the piece just past the touch on the blend's side
  dropped), everything sewn (`sewnLoosely`, 0.01); kept only if one shell, BRepCheck-valid and each surface keeps > 5% of its area
  — else the blend alone with a "couldn't be trimmed cleanly" warning (a blend ending mid-face, e.g. a half tube on a floor);
  solids' faces otherwise left alone with a warning. Dependents: boundary curves are needed; side 2 a list (`withoutGone`).
  Clicks: `src/model/surfaceClicks.ts` (Viewport handlePick; curve features via geomPick). UI `src/app/BoundaryBlendOptions.tsx`.
  Claude: `boundary_surface` (u/v, other_face), `face_blend` (faces/faces2, flip1/2, trim). Not done: Onshape's constant-width
  blend, more than two curves each way, smooth sides on both pairs, a solid boundary, trimming a solid's faces that don't meet,
  trimming where the blend ends mid-face, Constrained surface. Tests: tests/boundaryBlendModel (pure), engineBoundaryBlend, mcpBoundaryBlend.
- Simplify (tidy triangles into real faces): an Import's `Feature.simplify` (`SimplifyLevel` fine/normal/coarse; missing = as
  before) or a "simplify" feature (`simplifyParts` + `simplify`; in the toolbar's Boolean ▾ list ("parts" group), Parts list right-click, Claude's
  `simplify_part`). Levels/tolerances and the summary text (`simplifyReport`: "4,812 faces → 38 faces: 22 flat, 12 round
  (holes Ø5, Ø8, rounded edges R2), 4 left as mesh.") are pure in `src/model/simplify.ts`; the summary reaches the app as
  `RebuildResult.featureNotes` → `store.featureNotes` (blue `.dialog-note` in the dialog, the row's tooltip; MCP `Build.notes`).
  Stage 1 always: `checkedUnify` (ShapeUpgrade_UnifySameDomain, faces + edges + B-splines) — mends STEP files with split
  faces. Exact (non-faceted) shapes use OpenCascade's own tight tolerances (never the level's: faces 0.86° apart are a real
  edge); only faceted ones get the level's. Every unify is checked (BRepCheck + volume to 1e-6); a failure falls back to the
  tight tolerances, then to the untouched input (`unchanged` in the summary: "nothing was changed"). Stage 2 for faceted input (an STL; a shape whose faces are ≥ 90% flat with straight edges,
  `isFaceted`): `planMesh` (`src/geometry/meshSimplify.ts`, pure) — triangles grouped flat (angle + distance), round faces grown
  from the biggest group over gently-turning neighbours (most shared edge first, much bigger neighbours skipped, until not flat
  within 2 × distance), fitted by `src/geometry/shapeFit.ts` (cylinder: axis from facet normals then tilted; cone: linear in
  x²+y²; sphere; torus: tube radius searched so normals step onto one spine circle) and accepted only if every corner is within
  the distance and every facet faces like the surface (`faces`, max(2 × angle, 1.5°) — what tells a fillet from the flat beside
  it); one-facet-tall rings with gentle turns beyond both ends are refused (`thinBand`); then triangles along smooth joins go to
  the face they lie on (`triRegion`); surfaces tidied to X/Y/Z and round sizes only within the fit's own scatter (≥ 2 µm, ≤ half
  the distance; `tidySurface`, `snapNice`: 2R 4.9998 → 5, but Ø5.06 stays); limits: over `MAX_TRIANGLES` (50k) or past
  `WORK_LIMIT` (points looked at by fits — a count, not a clock) planMesh returns `TOO_DETAILED`; `FRUITLESS_SEEDS` (150)
  failed seeds — and more than `FRUITLESS_RATIO` (20) misses per round face found — stop the search; nothing round + hardly
  any flats joined, or a plan that would leave over half the triangles (or > `MAX_FACET_FACES`, 5,000) as facets (a figurine
  on a round base), returns `NOTHING_TO_TIDY` before any edge or OpenCascade work — both brought in by the ordinary import
  with a plain note (`PlanOptions.stats` gives the work count, for tests). Partial cylinders and tori are "rounded edges" in
  the summary. Growing keeps its frontier up to date as members join and checks
  flatness every 25%; edges are chains of mesh edges between corners, each an exact line or arc (from the surfaces where possible —
  `meetCircle`: plane ⟂ axis, sphere/plane, coaxial cylinder/cone/torus; else fitted and snapped onto the axis), corners placed
  on all their surfaces (`meetPoint`) and exactly on their arcs; whole circles start at `canonicalX` (where round faces'
  seams are; a loop with no corner keeps that start). A round face with an edge that's none of these is given back as flat facets ("left as mesh"), and that repeats. The
  engine (`src/kernel/simplify.ts`) builds faces with ShapeFix_Face on each surface (always on the surface's own side: a
  reversed face's loops are walked backwards, then the face is turned round — else partial concave faces, slot ends and
  inside fillets, never close) (round bands bounded by whole circles —
  holes, bosses, torus rings, ball caps — from parameter ranges, `bandOf`, as ShapeFix can't add their seam), sews, makes the
  solid and keeps it only if BRepCheck passes and the volume is within 2% of the mesh's; else retries flat faces only, else
  stage 1's result with "only flat areas were joined". An STL with Simplify goes mesh → solid directly (`readStlSimplified`:
  skips making a face per triangle, the slow part); open bodies, and closed ones that couldn't be rebuilt, go through the
  ordinary import on their own (rewritten as an STL), the rest are still tidied. A throw anywhere = the ordinary import
  ("couldn't be tidied"). Mesh faces in the summary are found by the plan's facet samples (`describeFaces(…, meshPoints)`).
  Simplify part's cache keys imports by `importKey` and leaves names out; failures are cached too. A STEP file whose triangles
  come as a skin (no solid; brought in as a surface without Simplify) becomes a solid when they close up (`solidFromFacets`). Results are cached
  (importer: by file + level, `importCacheKey`; Simplify part: `GeometryEngine.simplified`, by the features up to it).
  Newer edges and faces: `fitChain` tries, in order, an exact `ellipse` PlanCurve (`meetEllipse`: plane across a cylinder
  at a slant — centre on the axis, short axis r square to it in the plane, long r/|cos θ|; every chain corner on it and on
  both surfaces; a loop starts on the cylinder's seam, `canonicalX`, and the engine makes it from that parameter,
  `ellipseParam`), then lines/arcs as before (`fitLineOrArc`), then a `spline` where two surfaces cross (`crossingChain`:
  each corner moved onto both by `ontoBoth` — Gauss–Newton square to both, refused where they meet at < 3° (touching, as
  equal bars' saddle sides) — plus `CROSSING_STEPS` exact points between, ≤ `MOST_CROSSING_POINTS`; smooth, one way; a loop
  turned to start farthest from either round face's seam) → GeomAPI_Interpolate through them (periodic for loops). Round
  faces going all the way round that aren't two-circle bands (a slanted hole, a pipe a branch joins) are `cutFromBand`: a
  band of the cylinder/cone past all loops, split by the loop edges (BRepAlgoAPI_Splitter), the piece nearest the face's
  sample kept (ShapeFix can't add their seam). Partial tori: neighbouring round regions one surface fits together are
  merged after growing (a corner's slivers of cylinders → one torus); a too-big first growth is retried with its first half,
  quarter… (a boss's fillet ring); a flat group's facing is asked per triangle when its middle fails (a strip round a ring's
  top); `fitTorus` is polished by Gauss–Newton on the points (`polishTorus`); the same face grown and turned down from `SAME_TURNED_DOWN` (12) seeds isn't seeded again (a printed nut's thread crest was regrown hundreds of times once tori fitted better: 13× the work; tests/engineSimplifyThread); a real flat face's own triangles never move to a
  round face they lie on within the distance (they made a chord of a fillet's curved edge); where two round faces meet
  smoothly in a `meetCircle` (new: a straight fillet into a corner's torus — the cylinder's axis touching the torus's middle
  circle) whose plane parts them, triangles near the join go to their side of it and both are fitted again (cylinders,
  cones, spheres; tori keep their fit); outlines are walked through each face's triangle fans (`nextHalf`), and a vertex
  with more than two boundary edges round it is a corner (a face's outline passing twice). Summary: `SimplifiedFace.slanted`
  (an ellipse edge) → "slanted hole Ø8", `meets` (spline edges shared by two round faces, halved) → "1 curved edge where
  round faces meet". Measure reads a cylinder's radius from its surface when it has no circle edge. Not done: a chamfer or
  fillet along a slanted rim (OCCT's surface there is no cone/torus), equal bars' T (tangent saddle), a torus whose tube
  reaches its axis (pocket corner radius = 2 × floor fillet), fillets faceted coarser than ~12 per quarter turn round a
  corner, free-form (B-spline) surfaces. Tests: meshSimplifyMore (pure: slanted hole, T of bars, the T as a hollow = a hole
  through a hole, a rounded plate's corner tori), engineSimplifyMore (heavy: the same from real parts' STLs — face counts,
  radii within 0.001, volumes within 0.5%, a fillet on a recovered ellipse rim; a rounded pocket floor; a boss's foot fillet).
  Tests: tests/shapeFit, meshSimplify (pure; meshes from tests/support/meshShapes.ts), engineSimplify
  (heavy: a machined block's STL from the app's exporter → 10 faces, Ø5/Ø8/R2 within 0.01, volume within 0.5%, fillet on a
  recovered edge; slot ends, inside fillets and a notch; a STEP with split faces → 6 faces, same volume; a roof at 0.86° left
  alone; a mesh-like STEP skin → a solid; a lumpy ball stays sound), mcpSimplify.
- Big STL imports: an STL becomes a solid of one face per triangle (readStl), which OpenCascade's WASM can't do past
  ~50k (`SOLID_STL_TRIANGLES`; measured 20k 15 s / 1.7 GB, 50k 36 s / 3.6 GB, 100k out of memory — the display meshing is
  the heavy part; this OCCT build has no BRep_Builder to give faces a ready triangulation). So `readImport` (importFile.ts)
  answers `{ok: "reduce"}` for 50k…`MAX_STL_TRIANGLES` (2M) triangles or files over 25 MB (STL bytes ≤ `MAX_STL_BYTES` 250 MB),
  and `reduceStl` (pure) welds (`weldCorners`, a numeric hash, 1e-5 rounding as `weld`), reduces with `decimate`
  (src/geometry/decimate.ts: Garland–Heckbert quadric edge collapse, area-weighted planes, open edges held by standing planes
  ×1000 and open corners kept in place; placed at the least error ALONG the edge only — off-edge optima pull rough meshes
  inward; refused when the ends share more than the two opposite corners (stays closed/manifold), a triangle turns > 78° or
  becomes a sliver (`thinness` < `SLIVER` 0.01 — a triangle that was one already, as CAD files' fans and hole strips are, may move if
  it gets no thinner; refusing those left CAD meshes stuck above the target until only collapses through walls were left), or a body would drop under 4 corners; dead triangles are taken off the opposite corners' lists — leaving
  them folded rough meshes) and keeps ONLY the reduced binary STL with `ImportedFile.reducedFrom` (missing = as before; old
  files and STLs ≤ 50k byte-identical). App: fileActions reduces to `USUAL_REDUCE` 25k in `src/app/stlReduce.worker.ts`
  (`stlReduce.ts` keeps the last 2 originals in memory, session only), the Import dialog's `ReducedStlChoice` says how far and
  offers Less detail / Usual / Most detail (`REDUCE_CHOICES` 10k/25k/50k) while the original is still in memory. Simplify then
  works on the reduced mesh (≤ 50k = planMesh's MAX_TRIANGLES). 1M → 25k reduces in ~16 s, 300k in ~4 s; 25k builds in ~20 s.
  Tests: tests/decimate (pure: closed, count, volume, box edges exact, open sheet outline, a pathological rough ball),
  decimateMore (a plate with Ø8/Ø3 holes at 25k and 10k: corners on their faces, Simplify still finds both holes and 6 planes; a 1 mm
  walled cup down to 3k: volume within 0.2%, no triangles crossing; small raised letters kept; two bodies, duplicate/flipped triangles and
  a hole in the mesh), importFile (limits, reducing), engineStlReduce (heavy: 300k → 25k built, volume within 1%).
  3MF and OBJ imports (Onshape's): pure `src/geometry/meshFiles.ts` — `zipEntries` (stored/deflated, no zip64) + `inflateRaw`
  (DecompressionStream "deflate-raw", Node too), a tiny tag reader, `parseModel3mf`/`read3mfMeshes` (main model from
  `_rels/.rels`; build items × component transforms, rows p·M, `composeTransforms`; `p:path` components in other .model files
  as Bambu/Prusa save them; a mirroring transform walks triangles the other way; `type` support skipped; `UNITS_3MF` → mm;
  colours/materials not read), `readObj` (v/f, a/t/n forms, negative indices, faces fanned, `\` continuations; numbers as mm).
  `src/model/meshImport.ts` `meshFileToStl` turns them into a binary STL; fileActions passes it to `readImport(…, from)`, so the
  design keeps `format: "stl"` + `ImportedFile.from` ("3mf"/"obj"; missing = an STL; parsed only for stl) and everything after
  (reduce, Simplify, File units, Scale, cache) is the STL path. A 3MF's own unit is applied when read and kept as
  `ImportedFile.unitMm` (missing = mm; OBJ always mm), which `fileUnitMm` returns for `from` files, so File units are measured
  against it (Inches on an inch 3MF = ×1, Millimetres = ÷25.4); `from` files never use the STL's on-the-file mm/in. Slicer projects:
  `slicerSkips` leaves out Bambu/Orca `Metadata/model_settings.config` parts whose `subtype` isn't normal_part (part id = the root
  object's component objectid) and PrusaSlicer `Slic3r_PE_model.config` volumes (triangle ranges) not ModelPart; `type="other"`
  objects too (a toast counts them). Items keep the file's coordinates (Bambu plates centre at 128, 128; later plates further along).
  Zip: central directory sizes (data descriptors fine), zip64 refused; no "deflate-raw" = "browser too old".
  Not done: OBJ/STL "Y axis is up" (Onshape has it), negative parts subtracted, colours.
  Dialog `importKind`. Tests: meshImport (pure; fixtures in tests/support/meshFixtures.ts), engineMeshImport.
- Move / copy (Onshape's Transform): `Feature.transform` (`TransformDef` in types.ts). `mode` (missing = "free": turns about
  X, then Y, then Z, then the move — the original way) or "xyz" (Translate by XYZ: moves only), "distance" (`distance` box along
  `along`: the triad's X/Y/Z or a clicked `{dir, through}`), "line" (`line` {a, b}: a clicked straight edge, from the end nearer the
  click), "rotate" (`turn` box about `along`), "mates" (`from` → `to` frames, Z onto Z; `flip` turns it over about X); `flip` also
  reverses distance/line/turn. `triad` ("Move triad": a `TransformFrame` origin/x/z) makes free/xyz moves and turns go along and
  about its directions through its origin; missing = the part's centre (or the origin with `about`), X/Y/Z. Every clicked thing is kept
  as numbers, as clicked (it doesn't follow later edits); a click on the moved part itself is taken back through the current move
  first (transformTriad.ts `shownMotion`). Pure maths `src/model/transformMath.ts` (`transformMotion` → a `Rigid`, `transformTriad`,
  `valuesInFrame` — re-expresses the move for a new triad so placing or resetting it never moves the part; `transformKeys` = the boxes
  shown, via `visibleParamKeys`); clicks → frames/directions/lines in `src/model/transformPicks.ts` (a flat face's middle, an edge's
  nearest end or middle, a round edge's centre from `SceneManager.edgePoints`, a plane). The engine's `applyTransform` keeps the old
  code path exactly when `isClassicTransform` (free, no triad), else applies the Rigid as one turn + move (`toAxisAngle`); it reports
  each transform's turning centre (`RebuildResult.transformCentres` → `store.transformCentres`, merged per rebuild) so the view can
  place the triad. The triad (`src/viewport/transformDrag.ts`, pure: `handleAt` screen-space hit tests, `startTriadDrag` → arrows by
  the nearest point of the ray to the axis line, squares by ray ∩ plane, the ball in the view plane, rings by angle in their plane —
  added up, so past 180° — or, edge-on, by sliding along the grabbed point's tangent; in free mode a ring's turn goes on top of the turn
  so far, R' = Rot(drawn axis, Δ)·R, and all three angle boxes are read back from R' (`turnOf`/`turnsOf`, also used by `valuesInFrame`; `turnsNear` picks of the two XYZ solutions, each shifted by whole turns, the one nearest the boxes shown last — the ring's own box nearest start + Δ — so they never jump to an equivalent set and long drags go past 180°), so a
  ring always turns about the axis it's drawn round; arrows seen within `MIN_ARROW_SIDE` of end-on and squares within `MIN_SQUARE_FACING` of
  edge-on are faded and can't be grabbed (`handleUsable`); `snapTo` with `lengthStep` (1 mm / 0.05 in, more
  zoomed out) and 5°; Shift via `shiftHeld` = free) is drawn by `SceneManager.setTriad` (constant `TRIAD_PIXELS` on screen, depthTest
  off) and dragged through `onTriadStart/Move/End/Cancel` (mouse: a press on a handle wins over everything else; touch/pen: a finger
  landing on a handle drags it on `dragStart`, never orbits; a second finger or lost capture = cancel). Glue in
  `src/viewport/transformTriad.ts`: live values → `store.transformLive` (the dialog's boxes show them) and `setPreviewMove` (the part's
  mesh moved by M(live)·M(shown)⁻¹ until the rebuilt parts arrive, `partsArrived`); letting go is one `changeDraftStep` (the open
  dialog's own undo, `draftSteps`, reset by startCreate/startEdit/commitDraft/cancelDraft; Ctrl+Z while Move / copy is open → `undoDraftStep`;
  mode/flip/clicked refs are steps too, and so is typing — `setDraftParam`/`setDraftField` on a Move draft go through `draftStepAfter`,
  typing on in the same box merging into one step, a change of `picking` alone not a step). A triad press blurs a box in the dialog (so
  Ctrl+Z reaches the dialog's undo); Esc mid-drag takes back only the drag (`escapeTriadDrag` → `SceneManager.cancelTriadDrag`), and a
  drag whose dialog closed is dropped; finger taps on handles do nothing; a live move only shifts the triad's drawing.
  `transform.picking` says what a click chooses (missing = the part). Tests: tests/transformDrag.test.ts (pure), tests/transformStore.test.ts,
  tests/engineTransform.test.ts.
  Scale uniformly (Onshape's): `mode` "scale", lazy param `factor` (> 0), about `triad.origin` (Click a point: corner/edge/face/plane,
  or a mate connector via geomPick) else the centre / origin (`about`); `scaleOf`/`scaling` (a Rigid with r = k·I — only
  compose/applyPoint/`invert` (Rᵀ/k² when det ≠ 1; plain moves exactly as before) take it; no triad drawn). Engine: `scaledShape`
  (src/kernel/scaleShape.ts, gp_Trsf SetScale) instead of toAxisAngle; a resized part drops its threads and sheet; owned
  connectors keep unit directions. Claude: add_feature "scale_part" (part, scale, about, copy). Import: lazy param `scale` + `Feature.importUnits`
  (`ImportUnit` mm/cm/m/in/ft; missing = as in the file; an STL's mm/in stay `ImportedFile.units`) → pure src/model/importScale.ts
  (`stepLengthUnit` reads the STEP's LENGTH_UNIT, `importScaleFactor` = scale × chosen ÷ file's own, exactly 1 when unset);
  `importSolids(file, simplify, scale)` scales only the cached copies (file read + Simplify cached unscaled, as before), mesh keys get
  `scaleKey`. Dialog "File units" + "Size: a × b × c" (`.import-size`); Claude's edit_feature on an import takes `scale`/`units`.
  Tests: tests/importScale (pure), engineScale, mcpScale; the smoke test imports the STEP at Scale 2. Not done: a drag handle for the factor.
- Manipulators (Onshape's in-view handles for feature dialogs): pure `src/model/manipulators.ts` (`MANIPULATED` types: extrude,
  revolve, fillet, chamfer, shell, thicken; `manipulatorsFor(draft, {sketch, parts})` → `Manipulator`s: an arrow (`origin` = where the
  value is 0, `dir`, handle at value × `scale`) or an arc round `axis`; Extrude blind/symmetric (two arrows, scale ½, both edit `depth`)
  and `depth2`, from the profile's middle (`profileMiddle`: chosen regions' box, cached per sketch data); Revolve one way/symmetric/two
  ways (`max` = what the other angle leaves of 360); Fillet/Chamfer on the first EDGE pick (`edgeCorner`, cached per pick: bisector of
  the two flat faces holding the edge — an inside corner (each face reaching in front of the other) points out into the open corner —,
  the rounded/cut face's middle r(1/cos(α/2) − 1) / d·sin(α/2) in; a round edge by a flat face (`roundCorner`: hole vs pin from one mesh
  corner of the round face, `meshCorner`); else towards the faces' middle; no arrow for two-distance / distance-angle chamfers);
  Shell (walls outside with `flipSide`)/Thicken on the first face pick; open profiles (thin, surface) from their points' box. A box holding a variable/sum (`isPlainNumber`) = `locked`: drawn grey with a
  tooltip, never dragged. `manipPatch` (an Extrude's blind end with no second side dragged past 0 flips `extrude.flip`). Drag maths
  pure in `src/viewport/manipulatorDrag.ts` (`manipHandleAt`, `startManipDrag`: arrows via transformDrag's `axisParam`, arcs added up
  like the triad's rings, edge-on along the tangent; `manipStep` 1 mm / 0.05 in, finer only right zoomed in, coarser out; 1°; Shift free;
  least min(step, start), ≤ `max`; nothing changes until the pointer has moved half a step, so grabbing never jumps; `axisParam`
  ignores a line point behind the eye). A mouse press let go without moving, and a finger tap, pass through as plain clicks; a refused
  arrow (locked, end-on) says why only once the pointer moves. App's dialog-undo Ctrl+Z works after ticking boxes (`isTypingText`). Glue `src/viewport/manipulatorGlue.ts`: SceneManager's triad hit test returns `ViewHandle` (= TriadHandle |
  ManipHandle, manipulators first), so mouse priority, fingers dragging (never orbiting), hover colour, Esc (`escapeTriadDrag` →
  `escapeManipDrag`) all reuse the triad's paths; the Viewport dispatches the onTriad* callbacks. A drag changes the draft live
  (`store.dragDraft`, rebuilt as usual — the box and preview follow), letting go = one dialog undo step (`endDraftDrag(before)`;
  cancel puts `before` back). These dialogs keep the dialog undo like Move / copy (`keepsSteps`: typing, fields, picks are steps;
  Ctrl+Z in App). `SceneManager.setManipulators`/`manipulatorsShown`/`manipulatorOnScreen`/`setManipLabel` (`.manip-label`, the value
  by the tip while dragging). Tests: tests/manipulators (pure), manipulatorStore; the smoke test drags the Extrude's depth arrow
  60 px and Ctrl+Z puts 15 back. More (same paths): Draft (an arc round where the first face meets the neutral plane, + = leans
  in along the pull as BRepOffsetAPI_DraftAngle; `signed`: may go minus, never lands on 0, |v| ≤ `max` 44), Hole (blind only: from its
  first `holePositionsIn` point along ∓n as `holeAxes`; the glue reads `hole.sketchRef`), Move face / Offset surface (signed, along the
  face's normal), Extend surface (from a straight edge along its flat face, away from it; worked out once per pick, `extendDir`; none
  with `extendTo`), lopsided chamfers (`chamferFaces` = the engine's lopsidedChamfer order — a picked face holding the edge first, both picked = no arrows — `intoFace` along each face, outside or
  inside corner; distance-angle: + an arc round the cut's line on the first face), Shell/Thicken on the face as built (`faceNow`:
  strictMatch, else as picked), an Extrude's Up to end = a greyed `noEdit` arrow saying why. Still clicks/taps on an arrow pass through only for
  Extrude/Revolve (`Manipulator.passesClicks`, the areas round the profile); the others sit on the dialog's own pick and keep their
  clicks (`manipClickOnly`). Double-click (or double-tap) an arrow: `SceneCallbacks.onManipDoubleClick` → `manipEdit` (first puts back
  what a passing arrow's two clicks picked, with no undo step: presses remembered by manipStart / `onManipPress`) → `SceneManager.editManipValue`
  (`.manip-edit` box by the tip; Enter → `typedManipValue` — the box's own text via storeLength, checked by resolveParams, a problem
  stays shown — then `setDraftParam`, so it's the same dialog undo step as typing in the panel; variables/sums allowed, locked arrows
  too; Esc/blur closes; a touch on an arrow preventDefaults its pointerdown so no made-up mousedown takes the box's focus, and a blur
  in its first 400 ms refocuses). Face features refuse clicks on their own result (`madeByDraft`: an offset copy). Tests: manipulators2 (pure + the box's undo), engineManipulators (real OCCT: draft sign both pulls and minus,
  hole direction, chamfer handles on the cut at outside/inside corners, offset/extend/move face ends, shell following), engineManipulators2
  (the reviewer's: pocket faces, other neutral planes ±7°/±44°, upright edges, face + edge picks); the smoke test drags a Hole's depth
  arrow and types "12 + 3" by it, and on the touch page double-taps Move face's arrow and types 3. Not done: assembly features, Offset face (JuraCAD has none), arcs for curved draft faces.
- Mirror planes and pattern axes: `src/model/patternRefs.ts` (pure). A mirror's plane is a default plane, a Plane
  feature, a clicked flat face (`mirror.planePick`, found again on rebuild; `plane` keeps where it was when clicked) or a
  sketch line (`mirror.line`: the plane through it, square to its sketch). Patterns use X/Y/Z, a clicked edge/face
  (`pattern.along`/`along2`) or a sketch line (`pattern.line`/`line2`). `unset` = nothing chosen yet (new mirrors and
  circular patterns made in the dialog start so, and ask); the engine's `mirrorPlane`/`pickedAxis`/`lineAxis` resolve them.
  The dialogs' boxes are `ReferenceBox` in FeatureDialog.tsx; sketch lines are clickable in the view (`PickTarget`
  "sketchLine", `SceneManager.setPickLines`) and the chosen plane/axis is drawn (`setReference`) while one is open.
- Onshape's other Plane types and Part Studio mate connectors. `PlaneOptions.mode` also "point" (Plane point: `points[0]`, parallel
  to `ref`), "pointNormal" (`points[0]` + `line`), "lineAngle" (`line`, the `angle` param from the upright plane holding it —
  `lineAngleReference`), "threePoint", "curvePoint" (`points[0]` on an edge at `position` 0…1, its `dir` the edge's direction there),
  "fit" (least squares, ≥ 3); `flip`; missing for old modes, so old files read the same. Each point/line is a `GeomPick` (types.ts):
  numbers as last found (`p`, `dir`) + what it follows (`pick` edge/face with `end` a/b/mid, `sketchPoint`, `sketchLine`,
  `connector`, `axis`). Pure maths `src/sketch/planeTypes.ts` (`morePlaneFrame`, called by `planeFeatureFrame`; `fitPlane`,
  `connectorFrame`); clicks → picks `src/model/geomClicks.ts` (`planeClick`: Point normal takes a corner as its point, an edge/face/
  sketch line as its line; Three point/Fit toggle points; `connectorFromClick`); viewport glue `src/viewport/geomPick.ts`
  (`geomPick`, called first in handlePick). Mate connector = feature type "mateConnector", `Feature.connector`
  (`MateConnectorDef`: `at` (GeomPick + `spot` as assembly connectors), `plane`, `owner`, `flipZ`, `base` = where it was last found),
  params dx/dy/dz/rx/ry/rz along/about its own axes. The ENGINE follows them (`followedFeature`, `placeMorePlane`, `placeConnector`,
  `findGeom`, `connectorBase` in engine.ts): at their place in the list it re-finds each pick, works out the frame, and things
  placed on them (`planeRef`) are repointed in the same build (`repointFeature` in planeFeature.ts — only new-type planes and
  connectors go in that map, so old files build exactly as before); Move / copy's `fromConnector`/`toConnector` are filled in as
  `from`/`to`; connectors owned by a moved part go with it (`moveOwnedConnectors`) and pass to the part theirs is merged into
  (`reassignOwners`, after each feature and before a configuration's ids get their suffix: `mergedInto`, recorded by a Boolean
  union, `commitPlan` joins and `applyComposite` (each member → the composite); a part used up otherwise — Subtract, Delete part — leaves them unowned with a `featureWarnings` note). Any plane (old modes too) whose
  ref was repointed goes in the map as well, so chains follow in ONE build. Where each is built comes back as
  `RebuildResult.followed` (id → frame, every studio, like sketchLinks) → store `builtFrames` → `framesOf(features, scope,
  built)` (planes drawn, connector marks, geomPick, dialogs; the extension passes `Build.followed`); a sketch repointed this way
  gets `SketchLinkInfo.plane`, so `followedSketch` shows/edits it there. The DESIGN IS NEVER CHANGED BY A REBUILD (stays as
  clicked; tests/planeStore). Owned connectors ride on `PartMesh.connectors` (part
  coordinates), so assemblies use them: `MateConnector.connector` (+ a stand-in `pick`, `ownConnectorPick`), resolved by
  `connectorFrameOnParts` → `ownConnectorFrame`. Connectors are drawn/clicked as `SceneManager.setConnectorMarks` (PickTarget
  "connector", within `CONNECTOR_PICK_PIXELS` of the middle, before faces unless behind the face hit; only while `connectorWanted`
  (geomClicks.ts) says the tool open takes one — `setConnectorPicking`; Text: "notOnRound", as a round face wraps it); in an assembly only while a mate is made (key
  "<leaf key>|<id>"). They're sketch planes (`framesOf`/`refreshPlaneRefs` include them as `planeRef`s), have an eye
  (`hasEye`), and Delete with dependents knows `GeomPick`s, `connector.plane`/`owner`, `from/toConnector` (and `outsideUsers` names
  assembly mates on a connector that goes, `connectorMates`). Curve point's `position` is a share of the edge's LENGTH on both
  sides (`fractionAlong` / the engine's `paramAtLength`). Not done: Onshape has
  no Tangent plane; sketch points can't be clicked in the 3D view (the extension takes them); a connector clicked while a Mirror is
  open is its plane (XY), but patterns can't use one as an axis yet. Claude: add_feature "plane" (plane_type…) / "mate_connector", add_sketch "plane":
  a Plane or connector name, add_mate end `{"instance", "connector"}` (`src/mcp/planeSpec.ts`). Tests: tests/planeTypes (pure),
  enginePlaneTypes (follow a variable, sketch on it in one build, Move / copy by connectors, owned connector), mcpPlanes.
- Pattern types and Composite part (Onshape's): Linear/Circular/Curve pattern `pattern.of` ("part" | "face"; missing =
  features, `sources`, exactly as before) and Mirror `mirror.of` "face" (beside `part` = whole part). Part: `pattern.parts`,
  each copy a new part (`patternParts` in engine.ts: ids `<feature>`, `~2`…, solids "Part N" numbered on, surfaces
  "<name> (copy k)", a composite's copies keep `members` (ids "<copy>#<member>" — never "/", assembly keys use it); threads not copied; sheet metal refused). Face: faces of one part in
  `Feature.picks` (parsed only when `of` is "face") → `src/kernel/facePattern.ts` `regionOfFaces`: the faces' open rim
  (edges only one picked face uses) chained into loops, each capped flat (a rim that isn't flat is refused in plain words),
  made a solid; inside the part = a boss (copies fused; a copy that would float off is refused), outside = a pocket/hole
  (copies cut); half and half refused. `patternFaces` does both patterns and face mirrors (same placements; copy numbers
  ride along as `numbers`); a copy that changes no volume gets a `featureWarnings` note ("Copy 3 doesn't reach Part 1…"). Dialog: Parts /
  Features / Faces segmented choice (mirror: Whole part / Features / Faces), `PatternItemsBox` takes view clicks while
  `pattern.picking === "items"` / `mirror.picking === "faces"` (not saved; "Done — show the copies" stops it). While picking
  (and always for an open Composite part), `picksPartsBefore` → connect.ts builds `pickingPreview` (the features before it),
  so the real parts are clicked and lit (the Viewport's part highlight; setRebuildResult keeps hidden/see-through/selected
  part ids meanwhile; `withoutPicking` drops `picking` on Accept); the Composite dialog shows `compositeProblem`
  (src/model/composite.ts) at once; `madeByDraft` refuses its own copies anyway. Parts
  list clicks go to `toggleDraftPart`; the view shows picked faces together with the mirror plane / pattern direction; starting a pattern with parts / faces selected picks them (store startCreate). Composite part:
  feature "composite", `compositeParts` (≥ 2 solid parts; the toolbar's Boolean ▾ list, Parts list's several-parts menu) →
  `applyComposite`: the members are taken out and one part with id = the feature's, name = its name, shape = a compound of
  theirs (separate solids inside), their featureIds/threads, `BuiltPart.members` → `PartMesh.members` (listed under it in
  the Parts list, renamed by partNames; `membersNow`: once later features join or split its solids, one "<name> piece k"
  entry per solid instead) is put at the end; Export for laser of it gives one panel per solid (named after its parts);
  the check report calls its pieces fine (`PartCheck.members`); so selection, colour, exports, assemblies treat it as one. Only
  "closed" composites (members aren't selectable on their own). Dependents: part lists for `pattern.parts` /
  `compositeParts` (least 2, as a union; `withoutGone` drops gone ones). Claude: linear/circular_pattern `parts` | `faces` (+ `part`) | `features`,
  `skip`; mirror `faces` (+ `part`); `composite_part` `parts`. Tests: tests/patternTypes (pure), enginePartPattern (counts,
  ids, names, skip, boss/hole/pocket by faces, face mirror, composite export/assembly), mcpPatternTypes.
- Curve features (Onshape's Helix, Projected curve, Bridging curve, Composite curve, Fit spline, Intersection curve): ONE
  feature type "curve" with `Feature.curve` (`CurveDef`, types.ts: `kind` + its picks; sizes in params height/turns/pitch/
  diameter/startAngle/taper/bulge, shown by `curveParamKeys`); missing everywhere else, so old files are unchanged. Pure in
  `src/model/curves.ts` (`CURVE_KINDS` names/descriptions, `curveName` "Helix 1", `newCurveDef`, `helixSizes`, `bridgePoints` —
  a line, a cubic matching directions, or a quintic matching curvature vectors too (P2 = 2P1 − P0 + 25h²K/20), `bulge` scales the
  handles — `fitSplineProblem`, `curveUses` for dependents, `parseCurveDef`). Clicks: `src/model/curveClicks.ts` (`curveClick`,
  `curvePoint`, `pathClick`), glue at the top of geomPick.ts. Engine (`buildCurve`/`makeCurve` in engine.ts, OCC in
  `src/kernel/curves.ts`): helix = a straight line on an unrolled cylinder, or a cone when tapered (`helixWire`, exact; round a
  face from its circles, `roundOfFace`; frenet sweeps), fit spline = GeomAPI_Interpolate, bridge = a Bézier edge (ends from
  `endFrame`: finite differences), projected = the sketch's runs pushed out ±5 m along its normal (`sheetAlong`) cut by the faces
  or the other sketch's sheets (`sectionEdges`), intersection = faces against faces or a big square on `plane`; every result
  chained into wires (`chainEdges`). Wires live per build (`StudioBuild.curves`, freed in `disposeBuild`); drawn lines go out as
  `RebuildResult.curves` → `store.builtCurves` → `SceneManager.setCurves` (PickTarget "curve"; shown with the eye like planes,
  `hasEye`). Used by: Sweep/Curve pattern `pathRef` = a curve feature, or `pathEdges` (TopoPicks of part edges, chained) —
  engine `sweepSpine` (open paths start at the end nearest the profile as built; `sweepAlongSpine` in sweep.ts), handed to
  buildSolid as its `paths` argument; a twist round a curve's/edges' sharp corners is refused (a sketch path does it), and kept
  facing one way a result under 5% of the profile's real area (holes out) × ∫|t·n| ds along the path (`pathCrossing`) —
  a flattened, edge-on sweep — is refused (`refuseFlattened`, sketch paths too; edge-on only at an end is fine); curve patterns walk its polyline (`walkPoints` in pathSample.ts). Drawn lines
  are one per wire in the wire's own order and direction (`wirePolyline`: BRepAdaptor_CompCurve by C0 intervals), so their ends
  are the wire's; GeomPick `curve` (+ end a/b/mid): an end is the wire end nearest `p` across all pieces (`curveEndNear`), mid
  and Curve point `position` are by length (`paramAtLength` on the wire). Helix axes from faces/edges point one fixed way
  (`canonicalAxis`); projected sheets reach 2 × the size of the sketches and faces.
  Dialog `src/app/CurveOptions.tsx` (`CurveOptions`, `PathChoice`: sketch / curve / "Part edges (click them)"); the curves are in the
  toolbar's "planes" group, after Plane and Mate connector (`startCurve`). Claude: add_feature "curve" with `curve_type` (`src/mcp/curveSpec.ts`), sweep `path` (sketch or
  curve) / `path_edges` + `path_part`; points may be {"curve", "end"}. Newer kinds (`src/kernel/curvesMore.ts`, params
  `distance`/`angle` — `ParamDef.lazy`: left out of `defaultParams`, so older features save byte for byte; `max` 90 on the
  angle): Offset curve (`picks` = edges + at most one face to move across; a face alone = its outline less seams; edges only =
  the face holding them all, else the first beside the first edge, with a note; on a flat face everything exact via
  BRepOffsetAPI_MakeOffset — open chains with IsOpenResult, so inside corners are cut back and outside ones rounded; the sign
  chosen by whether the result lies on the face; on curved faces `walkedOffset`: the wire split into smooth stretches at
  direction jumps > 2° (`smoothStretches`), each sample walked across the surface square to the edge, inside corners cut back
  where the moved stretches cross (`segmentGap`), outside ones joined by an arc walked round the corner, a spline per piece;
  moved into the face, a result that leaves the face or touches itself is refused, `checkInside`; `flip` = out of the face),
  Isocline (`picks` = faces, `axis` = the direction, default Z; n·d = sin(angle), `flip` = −; the face's (u, v) box sampled with
  BRepGProp_Face, pure marching squares + bisection on each crossing, then `clipRun` cuts the lines to the face's pcurve outline
  (`uvOutline`), the crossing found exactly by bisection along the edge's own curve, so lines run right up to the face's edge;
  `joinRuns` across seams; all in `src/geometry/isoContour.ts`; splines fitted), Trim curve (`curves` = [curve to trim, bound
  curve?], else `plane`, else face `picks`; BRepAlgoAPI_Splitter on the wire, pieces walked from its start — or, `flip`, its end —
  up to the first that ends on the bound; a meeting at the start doesn't count, and one touching only there is said plainly;
  `curveUses` needs both curves). Sketches use curve features like part edges: `curveFeatureRefs` gives each edge of its
  wires as a `RefEdge` with `source` {sketch: <curve id>, item "e<k>", ends "e<k>.a"/".b"/".c"} (+ shape, + pierce places), so
  links are ordinary SketchItemLinks (old files unchanged; Delete with dependents counts them as "references brought in");
  `workOutCandidates` offers curves before the sketch (from `StudioBuild.curves`); `followCurveLinks` (engine; links whose
  id `this.curves` has, else the old sketch lookup) takes each curve feature's links together and, per group (curves; each kind of point end), always weighs its edge numbers
  against the cheapest one-edge-per-link matching (`assignCheapest`, `src/geometry/assign.ts`, Hungarian): cost = distance from
  where the move puts it + 3 × size change (a line's length, an arc's/circle's radius; nearer of as it was or stretched), edges of
  the wrong kind excluded (ends only from open edges, centres only from round ones, never a closed edge's seam point). The move
  = per-axis scale + shift fitted from the links at their own numbers (refitted without stray pairs) — only from 3+ links; with
  fewer, none (a move could "explain" any swap). Edge k stands unless the matching is clearly cheaper overall AND by size (a
  hole growing, shrinking or moving keeps its circle; two holes whose loops come back swapped follow their own); a link whose own
  number is gone or of another kind takes its matched edge only when it's near or the only one of its size; a free rival as
  good = lost (null). Pierce points stay on edge k.
  Whole-face inward offsets on flat faces also check nesting (`checkNesting`: each moved hole inside a moved outer outline and
  none round it — roles by the way round the loops run, or from which source loop they came). The controller's `skipRef` treats a curve as shown unless its eye is off. Not done: surface sweeps along
  curves; trimming an offset that runs off its face (it's refused). Tests: tests/curves, curveClicks (pure), engineCurves
  (helix length/pitch/taper/face, spring volume, ellipse of a slanted cut, projected onto a ball, fit spline, bridge, sweep along
  an edge, composite, curve pattern on a helix), mcpCurves; tests/curvesMore (pure; an old helix saves byte for byte), engineCurvesMore
  (box top 5 mm in/out, an L of edges in (60 mm, cut back) and out (rounded), an L with a corner across a cylinder, a hole's
  outline growing off the face refused, ball isocline at 45° = R/√2 circle and on a cut ball up to the cut, helix trimmed by a
  plane/a face/only touching at its start, a sketch using/piercing a helix and following it, every edge of an offset (with and
  without a hole) followed as the box grows 40 → 80 → 120, two holes' circles kept on their own holes when their loops swap order or a hole grows/shrinks/moves, a number that no longer fits matched by nearness, a hole grown round
  the outline refused), mcpCurvesMore.
- Frames (Onshape's Frame, Trim frame, Gusset, Cut list): feature types "frame" (`Feature.frame`, `FrameDef` in
  model/frameTypes.ts: `paths` = sketches, all their lines/arcs/circles or `items`; `profile` = a built-in family + size key
  ("custom" = the width/height/wall params) or `{kind:"sketch"}` (its closed regions' polygons); `anchor` (9 points of the
  outline's box), `mirror`, `noMerge`, `corners` (choices keyed by `cornerKey` = the sorted "sketch/curve" ids meeting there,
  "|on:<id>" for a T; `through` = the curve of the member that runs through); params angle, gap), "trimFrame" (`trimFrame`:
  member `parts`, `plane` (keeps the side with more of each member; `flip`) or `to` (a part — a frame member is met by its
  outside only — biggest piece kept); `picking` not saved, stripped in buildInput) and "gusset" (`gusset.parts` = 2 members,
  `chamfer`, `flip` = the other side where one ends on the other's side; params size/thickness/chamfer). Missing everywhere
  else, so old files are unchanged. Pure: `src/model/frameProfiles.ts` (`PROFILE_KINDS`: T-slot extrusion 2020/2040/3030/4040 —
  outside + slots with 45° V sides, cavities left solid, ≈40 edges + bore; `ProfileShape.outline` = its 20×20… square, the
  outside copes/trims meet (`envelopeOf`: else the regions' outers without holes) —, box section, angle, round tube, flat bar,
  planed timber; `placedProfile`, `reachAlong` exact for circles) and `src/model/frame.ts`:
  - `sketchPathSegments` (lines/arcs/circles in 3D); `buildMembers`: with merge, segments carry on where they meet straight on /
    tangent; where 3+ meet only the longest straight line-line pair carries on (a post split at a rail = one post; a + = one
    member, two ending on its side); never through a point lying inside another line (rails each side of a post stay apart);
    collinear lines fused into one line (id = the earliest curve's); `Member.key`/`order` = the earliest curve in the path.
  - `orientMembers`: lines run on from one to the next through 2-member corners (reversed if drawn the other way), and the
    profile's axes (`Member.start`, carried along arcs, `segFrames`) are carried round 2-member corners by the least turn
    (`carryRound`; a U-turn turns about up), so a one-sided anchor stays on one side all round and sections match at mitres
    across sketches; each path's first member (and every member at 3+-way corners) starts from its sketch: x = n × t, y = n
    (`profileAxes`); a loop coming back turned over gets a note.
  - `findCorners`: ends at a point inside another member's LINE segment = a T (any number of ends; inside an arc = a note,
    left square); 3+ ends with a straight-on line pair = a "run" (the pair meet square and run on, the rest butt against it);
    2 ends = mitre (none if straight on); 3+ = butt. `frameLayout` applies choices; `usualThrough` = the longest, then the one
    most along X, then Y, then Z, then path order (a rectangle: two pairs; a cube: front/back rails run through, side rails and
    uprights stop — 300 cube in 2040: 4×340, 4×260, 4×280). `planFrame` → per member end `EndCut` {extend, cuts: half-spaces
    "keep n·(x − o) ≥ 0", cope: members, label}: mitre = the bisector (± gap/2); butt = others stop at the through member's
    near face (+ gap), it reaches their far face; coped = cut at its axis plane then minus its OUTSIDE (envelope) solid; < 10°
    refused. `memberRange`/`cutLength` (straight: over the profile's points, clipped by cuts and copes — boundary points count
    as inside), curved = path + extensions; `centreLine`/`clipPolyline` re-measure a curved member a plane trims.
  - `memberInfo` → `FrameMemberInfo` on BuiltPart/PartMesh `.frame`; `trimmedInfo`/`trimmedEnd`; `gussetOutline` (corner or
    T; the inside corner where the inner faces meet, legs `size`, optional chamfer, centred on the members' plane);
    `cutList`/`frameCutList` (profile + length to 0.1 + ends; mass from the part's material or `usualMaterial`),
    `cutListCsv`, `togglePathLine`, `frameCornersFor`, `frameUses` + parsers.
  Solids `src/kernel/frame.ts` (`memberSolid`: prisms/revolves with the plan's frames, fused, half-space boxes cut). Engine
  `applyFrame` (part ids `<feature>~<sketch>_<curve>` of the member's first curve — stable when other lines change; names
  "<Frame> member k" by path order; copes cut with the through members' envelope solids), `applyTrimFrame` (to a part: which
  end is told by `alongRange` of the cut solid vs `memberRange`, then a square plane at the measured end, label "coped"),
  `applyGusset` (`frameMembers` per build). A 12-member cube frame builds in ~3 s. UI: Toolbar group "frames" (Frame, Trim
  frame, Gusset, and Cut list in its ▾ list → `CutListDialog.tsx`, dialog "cutList", Save as CSV), dialogs in `src/app/FrameOptions.tsx`;
  clicking a sketch line while a Frame is open leaves it out / puts it back (lineDraftId), Trim frame's Members / To a plane
  or face / To a part, Gusset picks 2 parts. Dependents: path sketches a list, profile sketch / gusset parts / trim target
  needed, trim members a list, trim plane via planesOf; frames and gussets make solid parts. Claude: add_feature "frame" /
  "trim_frame" / "gusset" and `describe_cut_list` (csv) in `src/mcp/frameSpec.ts`. Not done: gussets off the middle plane, Ts on
  arcs or curves, copes against curved members (Trim frame to one uses its part).
  - More paths: `FrameDef.edges` (`FrameEdge` = TopoPick + `key`, a lasting name from `edgeKeyFor` — a hash of the part and the
    edge's ends/middle as picked, so re-picking an edge gives its name back and removing one renames nothing; filled in when
    missing by parseFrameDef; segment ids `edgeSegId` "<part>/<key>"; a part's picks re-found together, two on one edge refused) and `.curves` (curve
    feature ids, `curveSegId` "<curve>/<wire>.<edge>"), mixed with sketch paths (missing = none; old files unchanged). Engine
    `framePathPieces` samples each edge (`pointAt`/`tangentAt`, tangents turned to run with the points) → pure `edgeSegment`:
    a line, an arc (all samples on one circle in one plane) or a `CurveSeg` (samples + exact length; `normals` when the curve
    is `frenet`, a helix — then `n` = the binormal, so the profile's across faces the axis); `withPathNormal` gives a group's
    lines/curves the plane they share (facing +Z, else +Y, else +X; else Z). `carryCurve` carries the profile's axes: kept at
    the same angle to `normals`, else rotation-minimising (double reflection, exactly undone going back). Curve members are
    `pipeLoop`s (MakePipeShell: Frenet for helices, else steered by `plannedGuide` — a B-spline `curveAcross` puts 0.2 × the
    tightest bend (≤ 5) off the curve along the planned across, as sweep.ts's twistGuide, since CorrectedFrenet drifts ~1° on 3D
    curves) along the real edge (`FrameSpines`, by seg id; `reversed` walks it back), holes swept and cut. A closed curve is
    swept in two halves (`halves`: BRep_Tool.Curve cut at the middle of its parameter — the samples are even, so the middle
    sample is there), each with an open guide, the frame's turn round the loop shared out (`curveAcross(…, close)`); a pipe
    round a closed spine unguided is made a solid from its shell (MakeSolid would cap the seam). Each way is tried in turn
    and the first sound (BRepCheck) result kept; OpenCascade's own error text is never shown (applyFrame's catch). `RebuildResult.framePaths` →
    `store.framePaths` (connect.ts) give the dialog's corners those pieces; Claude's frame builds itself once without corners
    first (`pathSegments` in frameSpec.ts) so corners on edges/curves go in the same call. Clicks: an edge (Viewport, not the
    frame's own) → `togglePathEdge` with `builtEdgeKey` (the clicked edge matched — ends and middle — against the pieces as
    re-found in the last build, "<part>/<key>", so a changed part's edge is still recognised; Claude giving `edges` again
    keeps the names the same way), a curve (geomPick) → `togglePathCurve`; things later in the list are refused at once
    (`laterPathMessage`). Dependents: the path is one list
    of sketches + curves + edges' parts (`frameUses` pathCurves/pathParts; `withoutGone` drops gone ones).
  - Mitres where 3+ meet: `findCorners` offers "mitre" when `mitreable` (no straight-on pair, `sharpestPair` ≥ SHARPEST); each
    end is cut by the halfway plane to every other member there (two members: exactly the old mitre), extended by the most any
    plane needs, labelled with the largest angle and `EndCut.compound` → `FrameMemberInfo.compound` ("compound mitre 45°" in the
    cut list; a trimmed end drops it). A cube corner of s × s: 3 s²(L − s/6), no overlaps. Butt stays the usual.
  - Cut list on drawings: `DrawingNote.cutList` ({studio?}) → `src/drawing/cutListTable.ts` (`sheetCutList`: the studio named,
    else the sheet's part's studio, else one piece per copy in the sheet's assembly; `cutListRows` = heading, a line per
    length, a total per profile; inch designs in inches to 0.01) → `SheetInfo.cutList` (sheetInfo) → drawn by layoutSheet with `tablePrims` (decimal comma
    applied), so SVG/PDF/DXF carry it. Toolbar "Cut list" (`addCutListTable`, one per sheet), panel `CutListNoteProperties`;
    Claude's add_drawing_note `cut_list` (+ `studio`); describe_drawing lists its rows. Tests: tests/frameMore (pure),
    engineFrameMore (box top edges, sketch + edge, helix rail, circle edge, fit spline, cube corner), mcpFrameMore. Tests: tests/frame (pure),
  engineFrame (volumes, butt pairs, the 2040 cube, split-post T both orders and unmerged, +, rails each side of a post and at an
  angle, lines drawn either way, an L across sketches, copes 290/280, stable ids, gussets at a corner and a T, trims), mcpFrame.
- Split face and Modify fillet (Onshape's). Split face = a "split" with `splitDef.mode: "face"` (missing = Split part, exactly as
  before): `picks` = faces of one part (+ edges when `splitDef.tool` is "edges"); `tool` missing = `splitDef.plane` (its section with
  each face, `planeCutEdges`), "sketch" = the feature's `sketchRef` (its curves as an `extrudeSurface` symmetric past the parts, sectioned
  with each face), "edges" = picked edges lying on the faces. `src/kernel/splitFace.ts` `splitFaces`: BRepAlgoAPI_Splitter with the
  section edges as tools; refused when nothing crosses, no face is added or the volume changes; one part, more faces, so Draft /
  Move face / colour etc. can take half a face (the halves are ordinary face picks). Dialog: Part / Faces segmented choice in
  `SplitOptionsField` → `SplitFaceFields`; view clicks by `splitDef.picking` ("faces"/"plane"/"edges"). Modify fillet = feature
  "modifyFillet": `picks` = rounded faces, `radius` param, `modifyFillet.remove` (take off), `noPropagate` (Onshape's Propagate is on
  unless set). `src/kernel/modifyFillet.ts` `modifyFillets`: faces' adjacency by edge hash; every piece must blend SMOOTHLY
  (normals within 1°) into the faces along its long sides (`onSide`: a cylinder's sides run along it, a torus's round it; else
  `NotAFillet` "…meets the face beside it at a corner") and its ends may meet flat faces or other chain pieces only (a smooth
  round end → "Tick Propagate", a mitre → "pick the pieces meeting it too"). Propagate follows ends only, to tangent pieces of
  the same tube radius or to corner blends (balls), never sideways or across mitres. Only what the fillets took away goes back
  (never a region round them — that filled holes, grooves, pockets and chamfers beside them): each cylinder/torus piece's wedge
  (its cross-section, arc + tangent lines to their corner, pushed along / spun round; cylinders carried 4 r past ends cut by flat
  faces — a box end, a slanted end, a chamfer — and trimmed back to them, `within`; tori must end square), fused (outside) or cut
  (inside corner), plus each corner ball's corner block (within r of each of the three flat faces its neighbours blend into;
  outside corners only, exactly three faces, else refused). Refused if unsound or a round face is
  left where a picked one was (`leftovers`). Change radius fillets the recovered edges (on the wedges' corner lines/circles, carried past their ends by
  the balls' radius, `recoveredEdges`) — refused if OpenCascade's check rejects the result (an r that ends exactly on a hole's rim).
  Propagate's note names what it also took (`describeExtra`: "4 upright edges and 8 corner pieces where edges meet"). Works on imported STEP/simplified parts (no history).
  Not BRepAlgoAPI_Defeaturing (missing from this OCCT build — Delete face can't remove blended fillets). Fillet/Chamfer `allEdges`: every edge of the picked parts (equal
  chamfers only). Not done (OCCT can't): conic/curvature fillet sections, partial fillets, turning tangent propagation off.
  Dependents: split face needs its sketch (tool sketch only — the plane only for tool plane) and its picks' parts, makes no part.
  Claude: `modify_fillet` (faces, radius | remove, propagate), `split_face` (faces, plane + offset | sketch), fillet/chamfer `all_edges`.
  Tests: tests/splitFaceModel (pure), engineSplitFillet (split counts/volume, draft on the top half, radius 2 → 4, removed, hole rim,
  rounded-rectangle chain, a sharp scoop refused, slanted ends, a fully rounded box off/resized vs direct, mitres, inside corner
  resized vs direct, holes/grooves/pockets/a chamfer beside fillets left alone (exact volumes), imported STEP, all edges), mcpSplitFillet.
  Variable fillet (Onshape's Fillet › Variable): `Feature.variableFillet` (`{points, straight?}`; missing = the ordinary fillet,
  byte for byte; `endRadius` hidden and ignored while it's set). A `FilletRadiusPoint` = `part` + `edge` (its pick's `ref.mid`, so
  `tidyRadiusPoints` — store toggle/setDraftField, withoutGone, featureSpec — drops it with the pick), `at` (share of the LENGTH from
  the pick's `a`), `radius` (expression; renamed with variables, mapExpressions). Pure `src/model/variableFillet.ts`: `runRadii` (a
  run's points + the main radius at ends without one; a closed run's ends are one place; two radii at one place refused),
  `radiusAt` (straight, or monotone cubic — never past the radii typed), `edgeRadii` (one edge's (share, r) list: ends, points,
  `SAMPLES_BETWEEN` samples when > 2 radii), `clickRadiusPoint` (a click on an already-picked edge adds a point, `END_SNAP` to the
  ends, by `clickShare`; the Viewport passes `at` only for variable fillets). Engine: `applyEdgeFeature` → `radiusPointsOf` /
  `variableEdges` → `src/kernel/variableFillet.ts` (`Add(E)` each edge, then per contour `SetRadius(UandR, IC, j)` for every edge
  j, spans from OCCT's `RelativeAbscissa` — run shares by length — so tangent chains agree at their joins; the pick's stored a/b
  decide which end is which; runs without points `SetRadius(r, IC, 1)`). Law_Function overloads don't build in this OCCT
  (Add/SetRadius with a Law fail), hence samples for straight steps. Dialog `src/app/VariableFilletOptions.tsx` (tick, points list:
  edge, start/part way %/end, radius; Smooth/Straight). Manipulators: an arrow per placeable point (`radiusPointAt`), key `vf:<i>`
  (`manipPatch` writes the point; `noEdit` — typed in the list). Claude: fillet `variable` [{edge, at, radius}] / false,
  `variable_straight`. Not done: vertex radii shared by a chain's edges in one box (each edge's point is its own), `allEdges` +
  variable, conic sections. Tests: tests/variableFillet (pure), engineVariableFillet (1 → 4 probed at both ends, three points smooth
  and straight, a reversed pick, main radius on the rest, a tangent run, the ordinary fillet unchanged, too big refused), mcpVariableFillet.
- Move face types (Onshape's Offset / Translate / Rotate): `Feature.moveFace` (`MoveFaceDef`: `mode`, `axis` X/Y/Z or `along`
  (TopoPick, followed via the engine's `pickedAxis`; Translate: straight edge or flat face's normal, Rotate: straight/round edge or
  round face's axis — `moveFaceAxisProblem`), `flip`, `picking` "along" not saved/stripped in buildInput); missing = the original
  Move face (flat faces swept along their normals), exactly as before; new ones are made `{mode: "offset"}` (createFeature). Param
  `angle` is `lazy` (Rotate only, `visibleParamKeys`). Pure `src/model/moveFace.ts` (parse, `withMoveFaceMode`/`Axis`,
  `moveFaceAxisNow` for the view, `rotationPivot`: the turned plane as pivot line + lean + tilt). Kernel `src/kernel/moveFace.ts`:
  `moveFacesBy` — flat faces swept (`basicFaceExtrusion`) along the normal (Offset) or the vector (Translate; curved refused),
  curved faces' room = `MakeThickSolidBySimple` (oriented with `OrientClosedSolid`; a hole/boss closing up — cylinder/sphere radius
  from BRepAdaptor — refused first; a whole closed sphere face, which OCCT can't thicken, = the shell between two balls); added rooms fall back to box − ((box − part) − room) as the plain fuse returns nothing for a room
  sharing a curved face; with a curved face picked the volume must be V ± rooms exactly (flat-only moves add/cut as the original did — a top pushed into a pocket opens it), else refused ("out through the other side" / "into another part"),
  unless a neighbour isn't square to the move or two moved faces meet — then built with a `featureWarnings` note. `rotateFaces` =
  BRepOffsetAPI_DraftAngle per face (pull = lean, angle = tilt < 80°, neutral plane through the pivot square to the lean), so
  neighbours re-trim. Dialog `src/app/MoveFaceOptions.tsx` (segmented choice; Direction/Axis slot → view clicks in Viewport's
  handlePick, edges allowed then); manipulators: Translate arrow along the direction, Rotate arc round a straight/X/Y/Z axis (none
  round a round face's axis). Claude: add_feature "move_face" (`move`, `distance`/`angle`, `direction`/`axis` "x"|"y"|"z"|{edge}|{face},
  `flip`). Dependents: `along`'s part (not for Offset). Not done: Translate of round faces (moving a hole), Rotate of curved faces,
  neighbours that aren't square carried on to meet (warned), filling the corner where two moved faces meet. Tests: tests/moveFace
  (pure), engineMoveFace (exact volumes: box ±2, Ø10 hole → Ø10.4 and Ø9.6, boss +1, pocket floor, slanted face up Z, along an
  edge, 5° about an edge, refusals, an old Move face as before), mcpMoveFace.
- Everyday picking and views (Onshape's): selection filter `src/viewport/selectionFilter.ts` (pure; `store.selectFilter`, session
  only; empty = everything; kinds face/edge/vertex ("Corners")/part/plane/sketch; `partHitAs`: a face/edge
  whose kind is off becomes its whole part when Parts is on (`PickTarget.whole`, handlePick → `selectedParts`; only with nothing
  open, else "Parts" = faces and edges); `SceneManager.setSelectFilter` applies it in `pickAt` (a filtered face still hides what's
  behind), hover (`hoverWhole`) and box select (`boxPicks`: faces/edges only → `itemsInBox` → `onBoxSelectItems`; else parts as
  before); Part Studios only, toolbar "Pick" button in `src/app/ViewTools.tsx`). Select other: mouse held still `HOLD_MS` 800 ms (not
  in sketches/assemblies; the release then picks nothing, `holdFired`; cancelled on leaving the view; dragging on after it opened
  closes it, `onSelectOtherCancel`), a right-click that didn't orbit, or a touch long press in a Part Studio (`longPressWanted` in
  gestures.ts: never in a sketch or on a Move/copy triad handle — there the drag must stay the triad's; a drag after the list opened
  closes it and orbits) → `otherHitsAt` (every face/edge/area/curve/plane on the ray, plus mate connectors and sketch lines a tool
  wants) → pure `src/viewport/selectOther.ts` `orderChoices` (front to back, edges before their face, once each, filter,
  whole parts last, ≤ `MOST_CHOICES`) + `choiceLabel` → `selectOtherState.ts` → `SelectOtherMenu` (hover = `previewPick`, click =
  `pickChoice` → handlePick as a click). Named views `src/model/namedViews.ts` (pure): `doc.namedViews` (`NamedView`: owner = Part
  Studio or assembly id, dir/target/zoom/up; saved by fileFormat, parsed by parseDocument, missing = none; a same name replaces;
  views of a deleted studio/assembly are dropped), store `saveNamedView`/`renameNamedView`/`deleteNamedView` (undoable),
  `viewOwner`; `SceneManager.cameraState`/`goToCamera`; toolbar "Views" (studios and assemblies) and the Picture window's View
  choice. Not in drawings or the Claude extension. Copy/paste features `src/model/featureClipboard.ts` (pure): `copyFeatures` (picked
  + the sketches/curves they use + variables used, `outside` = other features referred to), JSON text `juracad-features` v1 read back
  through document.ts's `parseFeatures`; `pasteFeatures` — new ids, every id remapped as a whole word in the JSON (`remapIds`: also
  "<id>~2", "<id>@…"; never inside a longer id — "lib_x" ≠ "lib_x_plate", "<id>-2", "<id>.3", "<id>_p3" — except
  "~<sketch>_<curve>" of frame members), pasted sketches re-solved with the target's variables (`resolveSketches`), outside refs kept if the studio has them else `withoutGone` + `needsPick`, names `freeName`,
  after the rollback bar (which moves past them); store `pasteFeatures` (one undo step with any variables added), `pasteAsk` →
  `PasteDialog` (add missing variables?). App side `src/app/featureClipboardApp.ts`: Ctrl/⌘+C on the selected feature (clipboard +
  localStorage `juracad.copiedFeatures`), Ctrl/⌘+V via the paste event (only features on the clipboard are pasted;
  this browser's copy only when no paste event comes at all — Safari away from a text box; both skip text boxes, popups,
  windows and the paste question, `blocked`), row/folder/list menus Copy/Paste.
  Tests: tests/viewTools, featureClipboard (pure), viewToolsStore.
  Mass properties and feature-list feedback (Onshape's): engine `massProperties(partIds)` (worker request; `src/kernel/massProps.ts`
  `massPropsOf` — GProp volume/area/centre of mass exactly, OCCT box; [] ids = every part) → pure `src/model/massProps.ts`
  (`massSummary` mass-weighted centre, union box, one `density` when all alike; `printedGrams` = area × `PRINT_SHELL` 0.84 solid +
  `PRINT_INFILL` 15% of the rest — only when every solid is `printable` (≤ 2 g/cm³, not a metal/wood key); `massRows`/`rowsText` (copy); `massIn` lb/oz for inch designs) → `src/app/MassPanel.tsx`
  (`MassButton` "Mass" + panel in `.readout-stack` bottom right with Measure; open/density in `massState.ts`, session only; parts =
  picked parts, else the parts of picked faces/edges, else all shown; "Weigh as" each part's material / one material / a density;
  `SceneManager.setCentreMark` draws the centre). Measure: `Measurement.closest` (BRepExtrema points, `closestPoints`) → closest
  X/Y/Z; round edges' length; Copy. Which feature made each face: `src/kernel/faceMakers.ts` `FaceMakers.after` at every step
  of `featureSteps` (OpenCascade's explorer, each Current() freed — no replicad Face per face; parts over `MOST_FACES` 3000 — a mesh import — skipped; only parts whose shape object changed; after a Move / copy without a copy (`moved`) a part with as many faces keeps its makers in explorer order, `order`; a kept face hash keeps its maker, a new face on a plane/cylinder the
  part had keeps that surface's maker, else the feature) → `PartMesh.faceMakers` (by faceGroups, missing = none). Pure
  `src/model/featureSearch.ts`: `matchingFeatures` (every word in name/kind/folder; FeaturePanel's "Search features" box, Esc
  clears, folders/groups opened, datums hidden; `rollbackBarAfter` keeps the rollback bar after the last shown feature at or above it), `featureOfFace` (maker, else the part's latest), `facesMadeBy`.
  `src/viewport/featureFaces.ts`: hovered row (`setHoveredFeature`) → Viewport `setListHover` (its faces, else its parts; a
  hidden sketch shown — only that id is a dep of the sketch scene; cleared when the list unmounts); double-click a face (`SceneCallbacks.onDoubleClick` → `editFeatureAt`) or Select other's "Edit <feature>…"
  opens it. Parts list "Show only this part"/"Show all parts" were already there. Tests: tests/massProps (pure), engineMassProps.
  Feature list (Onshape's): several features picked — `store.featureSelection` (counts only while it holds
  `selectedFeatureId`, the main one; read with the selector-safe `pickedFeatures`; `selectFeatures(ids, primary)`; reset by
  selectFeature/startCreate/startEdit) via `src/app/featureListState.ts` (`clickFeatureRow` over listSelection's `clickRow` on
  `shownFeatureOrder` — the rows as listed, shut folders/searches left out; `stepFeatureSelection` for ↑/↓, Shift grows; `setRenaming`
  for F2 / the menu's Rename: `RenameBox` in place, Enter keeps, Esc puts back). Several picked: the row menu is `groupMenu`
  (Suppress/Unsuppress these N = `setFeaturesSuppressed`, one undo step; new folder; Copy; Delete these N = deleteFeatures(ids,
  true); with dependents); Delete key and Ctrl+C take them all; a Mirror/pattern starts with every picked solid feature as sources.
  Esc lets several go. Enter edits the one picked; with a dialog open, Enter with nothing focused clicks its ✓
  (`acceptsEnter` in App.tsx). The heading's "N failed" / "N notes" chips cycle through `failingFeatures` (`nextOf`; Shift back),
  opening folders/clearing the search; a rebuild that makes a new one fail scrolls it into view (`firstNew`, not picked). The rollback
  bar drags (`ROLLBACK_DRAG`) onto a row = rolled back above it (`rollbackDrop`; not above the first) or the end zone = Roll to end
  (also in the row menu). Pure `src/model/featureList.ts` (`uniqueIds`: grouped rows repeat). `pickedFeatures` drops ids gone from the studio
  (undo, Claude). List keys only with nothing focused (`onPage`: body or `.viewport`); with a dialog open Enter also takes over a
  `[role=toolbar]` button, never other buttons. Last-used options for NEW features, session only: pure
  `src/model/lastOptions.ts` (`REMEMBERED_TYPES`; plain-number params but thin/position groups, extrude end blind/symmetric/
  throughAll + `second` (through all only into a remove/intersect of the same operation; surfaces/thin never remembered), revolve symmetric/second, hole kind/standard/fit/end, chamfer type) — `remembered` in the store closure,
  `rememberOptions` on commitDraft (create only), `withRemembered` in startCreate. Tests: tests/featureList (pure), featureListStore.
  Final (Onshape's): editing an existing non-sketch feature shows the Part Studio rolled back to just after it unless the
  dialog header's "Final" tick (`FinalToggle.tsx`, `store.showFinal`, session only, default off) is on — pure
  `src/model/finalPreview.ts` (`finalChoice`: an unsuppressed feature after it, before any bar; `editRollback` = the bar
  connect.ts builds with; a bar already above it wins; new features unchanged); `shownRollback(s)` greys later rows and lets
  setRebuildResult keep later parts' hidden/see-through flags. That studio goes with `StudioInput.preview`: the engine parks
  its whole build (`parked`, `sourceBuild`), so Derived/context studios aren't rebuilt, later features' errors/warnings/notes
  stay on their rows, and closing unchanged or ticking Final takes it back without building (only meshed). Sketches are left
  as before (their snap list and "ref:<n>" ids come from the whole build). Tests: tests/finalPreview, engineFinalPreview.
  Dialog starting values and Accept (Onshape's): pure `src/model/newFeatureDefaults.ts` — `withAutoValues` keeps a NEW
  feature's self-worked-out values up to date only while they still equal the last value set (`AutoValues`, store closure
  `autoValues`, reset by startCreate; `autoParts` = the parts when the dialog opened, before its preview): an Extrude's `flip`
  (`aimedFlip`: a sketch on a part's face — `materialBehind`, its plane normal vs the face pick's outward normal — Remove/
  Intersect point in, New/Add out; plain planes unknown = left), a Linear pattern's `spacing`/`spacing2` (`suggestedSpacing`:
  the repeated parts' box along the direction × 1.2, rounded up; parts picked, or the parts its sources made), run from
  startCreate, setDraftField, toggleDraftPart/Source. Edits never change. A new Hole's sketch: `holeSketchFor` (highlighted,
  else the last feature if an unused sketch with points, else none). Hole face clicks (Viewport handlePick, create mode):
  `placeHoleAt(plane, point)` puts a standalone point in a sketch on that face made for the hole (store closure `holeSketch`:
  written into `history.present` without an undo step; Cancel/startCreate/startEdit put `before` back only while nothing
  else changed the design since the first click (`clean` + `placed`), else just take the sketch out — never an older design
  back (a rename mid-dialog, New/Open); Accept inserts it just before the hole in ONE step; another face is refused; the
  toolbar's Hole needs only a part). Accept waits: pure `src/model/draftReady.ts` `missingPick` (fillet/
  chamfer with no picks, Shell Open with no face, face features, split face, part lists, part/face patterns, a hole with no
  sketch…) — the ✓ disabled with it as the tooltip, commitDraft refuses with a toast; `acceptBlocker` lets an edited feature
  that was already missing it when opened (picks lost upstream, an old Open shell with no face) be accepted, so no one's trapped. After Accept nothing is selected (a
  sketch stays highlighted). Engine: solid Extrude/Revolve/Sweep/Loft Add/Remove/Intersect (not a pattern/mirror source) that
  leaves every solid part's id, volume (1e-8) and face count as it was gets the `noChangeMessage` warning ("This doesn't
  change anything — …"; `watchChange`/`noChangeNote`, `sizeOf` cached per shape object; the face count keeps a tiny hole in
  a big block from looking like nothing). No library design warns at insert. Tests: featureDialogDefaults, engineNoChange.
  Editing an existing sketch shows the parts as rolled back to it WITHOUT a rebuild (candidates/ids untouched): pure
  `partsAfterSketch` (finalPreview.ts) — parts whose making feature comes after the sketch hidden, parts made before but
  changed later see-through; Viewport adds them to setHidden/setTransparent only (never `store.hiddenParts`). The snap list is
  already as at the sketch (`snap.parts`), but a Use click (edge, face, corner) on a see-through part's FINISHED shape is checked
  first (`notThereYet` in Viewport → pure `src/sketch/rolledBack.ts` `edgeThen`/`cornerThen`: strictMatch 0.3 among that part's
  face edges + snap-list picks, as followSketch re-finds links; unknown list = allowed) and refused with `NOT_THERE_YET`. The rollback bar
  at rest: `RollbackEnd` (FeaturePanel, `.rollback-end`, a slim draggable line under the last feature while not rolled back;
  drops go through `dropRollbackAbove` as the rolled-back bar's). A new drawing (`addDrawing`) draws the picked part, else
  `mainPart` (src/drawing/defaultPart.ts: the biggest solid, first of equals to 1e-6 — not a pattern copy). Tests: editRollbackView, rolledBackSketch.
- Corners (vertices, Onshape's): pure `src/geometry/vertexRef.ts` — `VertexRef` {p, rel (share of the part's box), dirs (unit
  directions its edges leave in)} / `VertexPick` {partId, ref}; `cornersFromEnds` groups edge ends (`SAME_CORNER` 1 µm; closed
  edges have none), `meshCorners`/`cornersOf` (cached per PartMesh: ends from `edgeRefs`, directions from the drawn lines — no
  PartMesh change), `matchVertex` = strictMatch's rules (min of distance and rel × size; every wanted dir must be one of the
  candidate's, dot ≥ 0.9; within max(0.5, 0.1 × size), unambiguous, else lost), `parseVertexPick`. Engine `src/kernel/corners.ts`
  (`shapeCorners` from OCCT edges' ends + tangents, seams skipped as the view skips them — `seamEdgeIds`, now in topology.ts; both
  sides offer/find none past `MOST_CORNER_EDGES` 20,000 edges; `findCorner(parts, pick)` → point or a plain message). SelectionItem kind
  "vertex" (index into `cornersOf`; `pickFor` returns null for it, `cornerPickFor` gives the VertexPick), so plain selection,
  Measure (engine `measure` takes VertexPicks: a point, "Corner — X / Y / Z", closest distance via a made vertex; no angle) and
  the status line include corners. SceneManager: `setCornerPicking` (Viewport from pure `cornerWanted` in geomClicks.ts: nothing
  open, Extrude Up to vertex, Plane point/pointNormal/threePoint/fit, Mate connector, Move triad/from/to — never assemblies or
  sketches, so other tools' clicks are unchanged), `cornerAt` (projected corners within `CORNER_PICK_PIXELS` 7 × reach, nearest
  first, in sight by a ray from the eye through the corner — separate `occluder` Raycaster), checked in `pickAt` right after mate
  connectors (before areas, curves, edges, faces), `otherHitsAt` (kind "vertex", listed first by `orderChoices`), dots for the
  hovered/picked corners (`drawCornerDots`, a Points object, depthTest off), `cornerOnScreen` (smoke). Uses: `extrude.upToCorner`
  (wins over the old `upTo` + `upToEnd`, which still build as before), `GeomPick.vertex` (planes' points; `pointFromClick` /
  `connectorFromClick` via GeomClick kind "corner"; connector on a corner = X/Y/Z, owned by the corner's part), Move's triad /
  from / to (`SpotSource` "corner"), Toolbar's mate connector from a selected corner. Dependents: `g.vertex.partId`,
  `upToCorner.partId`; the feature clipboard remaps its partId like any id. Claude: points `{"vertex": [x, y, z], "part"}`
  (`pickCorner` in picks.ts, nearest within 0.5 mm / 2 %), extrude `end: "up_to_vertex"` + `up_to_vertex`, list_edges
  `corners: true`. Tests: tests/vertexPicking (pure), engineCorners (box corner followed, up-to-corner,
  three-point plane, connector, measure, a lost corner), mcpCorners; the smoke test hovers and clicks a corner of the block.
  More uses (`cornerWanted` also: an assembly while `mateDraft` or `mirrorFacePick === "connector"`; a sketch with the Use tool;
  a Loft's `picking` start/end). Assemblies: `MateConnector.vertex` (a VertexRef in the PART's own coordinates; `pick` a stand-in
  flat face at it facing +Z, `vertexConnectorPick`) → `connectorFrameOnParts` → `vertexFrame` (`findVertex` = matchVertex on the
  part's mesh corners; frame at the corner with X/Y/Z), so mirrored copies (flipFrame) and sub-assembly paths go the
  usual way; on a cut copy `cornerOnCopy` (exact on the part, exact on the cut copy, else the nearer — never a plain corner merely
  near a pocket's; also for its dot and `cutFaceMoved`, "uses a corner made by an assembly feature"); parsed by `parseConnector` (not with `connector`/`pick2`); Viewport `connectorAt` on a vertex target (corners of the
  copy as shown), `connectorItems` lights its dot; Width refuses it (`pickConnector`), a mirror across a face refuses it
  (`pickMirrorFace`); a NEW mate between two corners starts with `flip` (`cornerFlip`: same way, so parts keep their way up); no
  spot choice; label "corner". Loft: `loftClick` takes GeomClick "corner" as `{point: {p, vertex}}`, engine `pointOf` →
  `cornerOnShape` (corners.ts); `loftUses`/`loftWithoutGone`/`profileLabel` know `vertex`. Sketch Use: `linkCorner(s, frame,
  pick)` (links.ts) = a fixed `standalone` point (kept on close, can take a hole) with `PointLink` `{partId, ref: VertexRef, end:
  "corner"}` (validate.ts parses it; one per corner, `samePointLink`; not Pierce's), re-found in `followSketch` among
  `shapeCorners` by matchVertex (lost = its own note, `cornerNote`). Claude: add_mate ends `{"instance", "vertex": [x, y, z]}` (as the copy sits now, `placedCorner`;
  two corners default `flip` true). Not done: box selection, dots for every corner of a hovered part, corners in Measure in
  assemblies (none there), the smoke test mating corners. Tests: tests/cornersMore (pure), engineCornersMore (a corner mate
  followed as w grows, a mirrored copy, a lost corner, a loft to a corner, a Use'd corner point followed), mcpCorners.
- Variables: `src/model/variables.ts`; `evaluate()` in `src/model/expr.ts` reads the document's current values
  (kept in sync by store.ts; the worker gets them with each rebuild). Changing variables re-solves sketches.
  Functions and angles (Onshape's): `FUNCTIONS` in expr.ts (sin cos tan asin acos atan atan2 sqrt abs min/max (2+) round
  floor ceil log = ln, log10 exp pow; case-insensitive; a function only when a "(" follows, so old variables called max/rad
  still work — none of them, nor deg/rad, are reserved) and units deg/°/rad (after a number or ")", like mm). Values are
  {plain | angle (radians)}: trig takes an angle (plain = DEGREES, as Onshape's boxes: sin(30) = 0.5; "pi rad" allowed), inverse trig gives one;
  a plain number added to / min-maxed with an angle counts as degrees; angle×angle, ÷angle, angle^ refused. Also
  degree(s)/radian(s). A unit applies to the product before it (as "1/4 in": "360 / 12 deg" = 30°), except an angle unit
  after "<angle> / <number>" goes with that number ("90 deg / 30 deg" = 3, `last` in term()). `hasUnitsOrNames` ignores
  angle units, so an inch box stores "sin(30 deg) * 2" as "(…) in"; varComplete keeps a variable typed in full first
  (Enter sets the size, not "asin("). An angle result comes out in
  DEGREES with `EvalResult.angle` (angle boxes take "30 deg"/"0.5 rad"); length boxes (resolveParams, args.amount,
  setDimensionValue) refuse one. Lengths stay plain mm numbers (no further dimensional analysis). Angle variables are
  marked in the scope by `ANGLE_KEY(name)` ("°name", set by resolveVariables; `isAngleVariable`; the dialog shows "30°").
  `namesIn`/`hasUnitsOrNames` skip function calls; `renameInExpression` leaves "name(" alone. varComplete offers
  `functionMatches` ("sin(") after variables — prefixes only, never after a number/")" (a unit goes there). Older
  expressions give exactly what they gave (tests/exprFunctions). Library designs keep `trigOf` (six-place numbers;
  switching would change what they make).
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
  hole → colour it blue → glossy finish (the colour popover wholly inside the window at 1180 × 760, short and narrow sizes) → save a 2× see-through picture → section view → check → export STL, STEP and 3MF → Laser: click the top face, save SVG (40 × 30 mm, blue hole, red outline) and DXF → edit → undo → sketch (rectangle, dimension, circle) → extrude → P hides/shows all planes, undo → fillet a face → a second fillet on a straight edge of the extruded part, then Delete with dependents on the extruded sketch (it, its extrude and that fillet go in one undo step; Fillet 1 too if it rounds that part), undo twice → revolve around a construction line → linear pattern → Mirror: click a face for the plane, Top, clear → Circular: Z axis → hole dialog (M4 sizes) → move a copy of a part → open Move again and drag the triad's X arrow a measured 120 px (Move X follows live, snapped to the step; the part moves by it once rebuilt; one dialog undo step; Ctrl+Z puts it back to 0) → open Move again (no undo left over from the cancelled one), type 40° about Z, drag the X ring (the turn added is about X) → add a variable → save to .juracad → New → open it again → import the STEP and STL it exported → the STL again with Simplify on (the summary shows, fewer faces), undo → assembly: insert copies, parts list, type a position → Fasten mate by clicking two top faces → drag a part → rename a part → check the assembly (clashes) and export it as STEP → explode it → pattern a part → group two parts → sub-assembly: insert Assembly 1 twice into Assembly 2, fasten a fixed part to a part inside one (it moves), flattened and structured parts lists, make a copy flexible (nothing jumps), undo, double-click opens it → add a second Part Studio with a box (and, on a page of its own, three studios: one dragged to the front, one moved with Move right, Part Studio 1 deleted — the question names the assembly using it — and undone) → Help: download the Claude extension → Extend a spline up to a line → make a drawing (4 views, title block), add a dimension by clicking two corners, save DXF and PDF → drag a dimension's number, then a slanted angle's (arc follows; across an arm it measures the supplementary angle; Shift into the opposite angle, the outside angle), undo → add a section view, a detail view and an auxiliary view → second sheet → a third sheet of Assembly 1 with its own part number → a view of another part with a projected top view (lined up), auto-dimensioned, then removed → draw the assembly exploded (parts list) → sheet metal from a part (a shelled box in a new Part Studio: its walls clicked one at a time from views that see them, a rip clicked, three more added, Accept: 4 bends); Design library: a finger-joint box inserted (6 panels, 140 mm) and widened to 170 mm in Variables, then a box with lid from the 3D printing tab (2 parts), then a bolt, nut and washer set found by searching, then a stencil of HELLO exported for laser (1 red outline, 5 blue holes), a 12-piece jigsaw's sketch (1 red, 17 blue) and a dice tower found by searching, all its parts saved for laser (7 red outlines, 20 blue slots), then a bird box found by searching (7 pieces, 182 mm across the roof), all saved for laser (7 red, 7 blue holes), and a Honeycomb wall tile found by searching (1 part, 122.63 mm); a touch screen (an iPad-sized page with `hasTouch`, fingers sent through CDP `Input.dispatchTouchEvent`: pinch zooms the 3D view and not the page, double-tap fits, a tap selects a face, in a sketch two fingers pan and draw nothing, a one-finger drag draws a line); Live with Claude (two chats, a third later; then through Safari's link window with `?liveRelay`) (the page is opened with `?smoke`, which exposes `window.juracadViewport`, `window.juracadStore` and `window.juracadDrawing` (a view's points on the sheet on show) so the test can find faces on screen). To see the result, set `SMOKE_SCREENSHOTS: "1"` in the CI
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
  `toolKit.ts` holds what every tool shares (ToolDef, `say`, `writeOut` — the only way tools write files). Assemblies:
  `assemblyTools.ts` (create_assembly, insert_into_assembly, place_instance, remove_from_assembly, add_mate, delete_mate,
  describe_assembly, check_assembly, explode_assembly; get_views/list_faces/list_edges/export_model take "assembly"/"instance"):
  the same pure edits as the app (`src/assembly`; `placed.ts` has explodeAssembly/instancesForKernel/partBox, re-exported by
  app/assemblySolve.ts); a copy's faces are picked as it sits in the assembly (placed refs, then the part's own ref by index);
  a change that makes a working mate fail is refused; parts are left where the solve put them (`settleSolved`). Drawings:
  `drawingTools.ts` (create_drawing, edit_drawing, add_section_view, add_detail_view, auto_dimension, add_dimension,
  describe_drawing, view_drawing, export_drawing) lays sheets out with the app's own code (`src/drawing/sheetSource.ts`:
  drawingSubject, projectionPlan, finishProjections, sheetInfo, viewScales — shared with DrawingUI.tsx); `sheetPicture.ts`
  rasterises a sheet's prims (font `font5x7.ts`). Assemblies and drawings need every Part Studio's parts: `Session.buildAll()`
  builds the whole document (+ configured studios, `documentStudioInputs` in kernel/buildInput.ts) on a second engine.
  More: `assemblyExtras.ts` (add_assembly_pattern — linear/circular/mirror, across a plane or a face, `same_part`; group_parts;
  edit_mate — values, limits, flip, suppressed; add_mate_relation; replicate_part — holes from `assembly/replicateHoles.ts`, shared
  with the store; add_explode_step — top copies or "Sub <1> / Part <1>"; remove_assembly_item), Width ends take `instance2` (→ `path2`);
  `tryAssemblyChange` refuses any new problem of a mate, relation, pattern or group (`assemblyProblems`). `drawingExtras.ts` (add_sheet,
  remove_sheet, add_drawing_note — text, datum, gdt (fcf), finish; delete_drawing_item by describe_drawing's D1/N1 numbers);
  add_dimension also makes angle, chamfer, arc_length and ordinate/baseline/chain runs (`linearDims.ts`); edit_drawing takes
  "part"/"assembly" for a sheet, and its title goes through `changePage` (a sheet of its own part keeps its own title).
  Builds stop between features: the engine's rebuild is a generator (`rebuildSteps`/`featureSteps`, yielding before each feature;
  `rebuildStudiosAsync(…, pause)`; stopped or failed part-way, `forgetUnfinished` frees the studio being built and marks the ones
  rebuilt in that call to be built again); `Session.buildAsync`/`buildAllAsync` pause at `checkpoint` (only with a signal). The
  second engine is freed after `WHOLE_ENGINE_IDLE_MS` unused, never during a call (`releaseWholeEngine`; WASM memory doesn't
  shrink, but the space is reused). Tests: tests/mcpAssemblyMore, mcpDrawingMore, mcpBuildStop.
  Cancelling (MCP notifications/cancelled → server.ts passes `extra.signal` to `callTool`): tools call `await s.checkpoint()`
  between slow steps (builds, each drawing view, before writing); it yields to the event loop (two setImmediate hops, so
  the cancel notification is read) and throws `Cancelled`; callTool then restores the snapshot (also when cancelled after
  the tool finished, unless a file was written). LiveBridge doesn't send a cancelled call's change; once sent, the tab's
  reply decides (so the session stays in step). Tests: tests/mcpAssemblyDrawing.test.ts, tests/mcpCancel.test.ts.
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
- Printers (`src/model/printBed.ts` `PRINTERS`, listed in the print bed, 3D print panel and puzzle windows; `bedSize` is what
  layouts and bed checks use): a two-nozzle printer may have `bothNozzles` (the room both reach) and a `note` (shown under the
  printer choice). The Bambu Lab X2D is 256 × 256 × 260 (main nozzle; `bothNozzles` 235.5 × 256 × 256, from 3D Printing
  Industry's launch article); nothing yet knows whether a print uses both nozzles, so `bedSize` is the main nozzle's and the print
  bed panel adds `bothNozzlesNote` when a part fits only that way. The H2D has no `bothNozzles` yet. The Bambu Lab H3C (full colour,
  Bambu Studio combines and layers CMYKW filaments) is 330 × 320 × 325, from 3DPrinting.com's launch news (on sale 3 Nov 2026).
- 3D printing: `src/model/printCheck.ts` (pure: `bedRotation(down)` turns a part so `down` faces the bed, `findOverhangs`,
  `arrangeOnBed`, `printPartReport`), `src/model/printSettings.ts` (nozzle, limits, printed fits + `withFitVariables`:
  fit_press/snug/sliding/loose; a hole's size `fitExpression` "5 mm + fit_sliding"), `src/model/slicers.ts` (why there's no
  open-in-slicer link: the slicers' URL schemes only download https URLs). Engine: `printCheck` (`src/kernel/printAnalysis.ts`:
  walls measured from exact points/normals — planes, cylinders and spheres worked out directly, other surfaces via OCCT — at
  about `samples` (2500) places spread by area, rays through a BVH of the view's own mesh (`displayMeshes`, kept by makePartMesh),
  hits refined onto the exact surface; a reading that ends on a face adjacent to the sampled one near their shared edge is a
  sharp edge, not a thin wall (`sharpEdges`); whole cylinders for holes/pins) and `exportPrint3mf` (turned, standing at z 0, laid out; build-item moves). UI `src/app/PrintPanel.tsx`
  ("3D print" toolbar button; per-part bed face in `printState.ts`, session only, never in the file), marks via
  `SceneManager.setPrintMarks`; the printer setting (`partsmith.printer`, `printerSetting.ts`) also holds the print settings;
  the panel checks on opening and when the parts/face/limits change, not on every rebuild ("Check again"; stale results say so);
  worker replies go through `uniqueTransfers` (a buffer listed twice is a DataCloneError). Hole dialog's "Printed fit" is
  `PrintedFit.tsx` (not on tapped holes); without fit_* variables it uses the number and `HoleOptions.printedFit`, and
  `commitDraft` adds the variables in the same undo step (`settlePrintedFit`).
- Export for laser (the owner cuts on a Bambu Lab R1 CO2 laser from Bambu Studio's laser mode): true-size 2D outlines as SVG
  (width/height in mm + a mm viewBox, hairline 0.05 mm) and DXF (R12, $INSUNITS 4). Pure in `src/laser/`: `laser.ts` — pieces of
  regions.ts `Segment`s (lines, 3-point arcs, circles, Béziers, ellipses; ellipse arcs become Bézier pieces when moved), `chainEdges`
  (joins pieces in any order/direction, grid lookup; a chain passing a point twice — a figure-8 — is split into its loops, `splitAtRevisits`), `sortLoops` (a loop inside another = "inner", else "outer"; deepest first, so an island is cut before its hole; pieces that close but enclose no area — a line drawn there and back — come back as one open run, doubles removed by `withoutDoubles`), `layoutPieces`
  (`arrangeOnBed` from printCheck.ts in rows up to `width`, default 600 = the R1's bed, `gap` 5; rows widen to the biggest piece's narrow side and the bed is as deep as all pieces stacked, so nothing is left beside it; then to (0, 0); `mirror` flips the
  whole sheet), exact `pathsBox`; layers `LASER_LAYERS` (outer #FF0000 CUT_OUTER, inner #0000FF CUT_INNER, score #00FF00 SCORE,
  engrave black filled ENGRAVE, written in `LAYER_ORDER` = engrave, score, inner, outer). `laserFiles.ts` — `laserSvg` (one closed
  `<path>` per loop, lone circles as `<circle>`, arcs as SVG arcs, Béziers as `C`, ellipses as two arcs; named `<g>` per layer with
  inkscape layer labels; all engraving in one even-odd filled path; `preview` = non-scaling strokes on white for the panel) and
  `laserDxf` (closed POLYLINEs with bulges, so arcs stay exact; lone circles as CIRCLE; Béziers/ellipses as straight pieces within
  `FLAT_TOLERANCE` 0.005 mm). `sources.ts` — `sketchPiece` (`findChains(…, { branching: true })` gives each curve of a junction group as its own run; `junctionCurves`
  asks the areas made by its own junction group's curves only (`Chain.group`/`curve`; `sketchAreas().areaAt` just either side of its middle; the same line drawn twice is kept once, `uniqueRuns`): open space on one side = outline, chained into closed loops; area on both
  sides or neither = a line (cut or scored) — so a house or a rectangle with a diagonal keeps its red outline; text from `textContours`, engraved by default; shapes cut or engraved; open lines cut or scored; `background` (rubber stamps, "Engrave the background" in the panel, `background` in export_for_laser): every closed loop, text too, into one even–odd engraving and the outermost loops also cut red; shapes that cross rather than nest are both outermost, so both outlines are cut and their overlap is left unengraved) and `outlinePiece`
  (engine outlines + bend lines as scores). Engine: `GeometryEngine.laserOutlines(sources)` (worker request `laserOutlines`) with
  `src/kernel/laserFaces.ts` — a face's wires read edge by edge through BRepAdaptor_Curve into the face's frame (`faceFrame`: seen
  from outside; across = X for up/down faces, else level), circles/arcs/whole ellipses exact, other curves Hermite→Bézier within
  0.5 µm (straight pieces only as a last resort); "part" = `biggestFlatFace` (ties: facing `LaserSource.toward` — `partFacing`, the normal of the sketch plane of the part's first
  feature, followed — else +Z, −Y, +X, so a plate drawn on Front/Right isn't mirrored); `uniqueSources` drops a part whose face is also picked; "flat" = the part
  laid flat (`laidFlat`) in its first wall's frame, `planeOutline` drops edges two flat faces share, bend lines from `flatOf`; curved
  faces refused ("Pick a flat face"). UI: the toolbar's "Laser" button (next to 3D print; also a link in the Export dialog, `toggleLaser`) → `src/app/LaserPanel.tsx` (side panel where the 3D print /
  section panels sit, so faces can be clicked while it's open; state in `laserState.ts`, session only; closes on section / 3D print /
  tab change), sources "selection" (clicked faces + picked parts, a sheet metal part as its flat pattern), "all", "sketch:<id>"
  (`followedSketch`), "flat:<part>"; preview, size, colour key, Save SVG / DXF named after the part or sketch. Claude:
  `export_for_laser` in `src/mcp/laserTools.ts`. Tests: tests/laser.test.ts (pure), tests/engineLaser.test.ts, tests/mcpLaser.test.ts.
- Appearances (Onshape's Appearance): a part's colour is `doc.appearance` (part id → "#rrggbb", as before) and its finish
  `doc.finishes` (part id → `FinishId`: matte, glossy, silk, brushed, polished, rubber, clear, wood; missing = matte, so old
  files open unchanged). Pure in `src/model/finishes.ts`: `FINISHES` (MeshPhysical settings + Phong shininess/specular for the
  quick view), `parseFinishes`, `setFinishIn`/`setColourIn`, `chooseFinish` (one undo step; a grey part given wood/metal also
  gets a colour that suits it), `exportColours` (what STEP/3MF get: the colour, and "#rrggbbaa" for see-through finishes —
  3MF displaycolor carries the alpha, STEP a SURFACE_STYLE_TRANSPARENT via `colourOpacity` in stepExport.ts; every exporter
  uses it), `finishFromWords`, `finishesByKey` (assembly copies look like their part). Picked under the colours in the Parts
  list's colour popover (FeaturePanel.tsx `ColourSwatch`, drawn with `PlacedPopup` (src/app/PlacedPopup.tsx: portalled into
  document.body, `position: fixed`, placed by the pure `placePopup` in popupPlace.ts — below, else above, else beside the swatch,
  scrolling inside only when taller than the window; closes on a click elsewhere or Escape) so no panel clips it; swatch size via
  `--swatch-size`, bigger under `(pointer: coarse)`; the smoke test's `popoverFits` checks it at several window sizes and in dark mode); store `setPartFinish`/`setPartsFinish`. Drawings ignore it (line
  drawings). No colour per face (face indices aren't stable across rebuilds). Claude's `set_appearance` (colour and/or finish).
  3D view: `src/viewport/studio.ts` (`finishMaterial`: matte in the quick view is still the original Phong material and grey
  matte parts share the old one, so the everyday view is unchanged; `studioEnvironment`: three's RoomEnvironment made in code,
  turned Z-up, through PMREM — no downloaded assets; `studioRig`: four slightly spread shadow-casting key lights = a soft
  shadow on a ShadowMaterial ground, plus a fill; `paintBackground`). "Nicer lighting in the 3D view" (Settings, this computer,
  `store.niceLighting`, localStorage `juracad.niceLighting`) = physical materials + the room's reflections live.
  Save picture (toolbar "Picture", next to Fit, in Part Studios and assemblies → `PictureDialog.tsx` → `SceneManager.savePicture`): a
  second WebGLRenderer, made once and kept (`pictureRendererFor`; remade if its context was lost; shrunk to 1 × 1 after each picture;
  no MSAA — pictures up to 2048 a side are drawn 2× and shrunk, `supersample`; preserveDrawingBuffer, shadows, Neutral tone
  mapping, its own environment) renders the same scene and camera at 1/2/4 × the view in device pixels (`src/viewport/pictureSize.ts`:
  ≤ 8192 a side, ≤ `MAX_PICTURE_PIXELS` 16,777,216 = iOS Safari's canvas limit; the drawing buffer the browser really gave is
  checked, `fitToBuffer`, so a big picture is made smaller, never cropped; ground only when looking down, `showGround`), with every
  scene child but the parts hidden, highlights off, edges optional, then everything is put back synchronously (no frame in
  between); the background (light/dark gradient or see-through) is painted under it on a 2D canvas. Errors are plain English (three's
  "Error creating WebGL context." is replaced). A see-through finish stays see-through when hovered/selected (`seeThroughHighlight`).
  The print layout 3MF (PrintPanel) gets plain #RRGGBB colours (slicers); only Export's 3MF/STEP carry see-through.
  The smoke test decodes the saved PNG (`pngPixels`, zlib) and checks transparent corners and solid pixels in the middle.
- Touch screens (iPad, Android tablets, Apple Pencil), as in Onshape's tablet app. The mouse never takes these paths, so mouse
  behaviour is unchanged. Gestures are pure in `src/viewport/gestures.ts` (`GestureTracker`: pointers in with times, actions out —
  tap (count 2 = double-tap), dragStart/drag/dragEnd, longPress/holdDrag/holdEnd, pinchStart/pan/zoom/pinchEnd, and `cancel` when a
  second finger lands mid-gesture; after a pinch nothing happens until every finger is off; `slopFor`/`reachFor` per pointer type:
  touch 10 px / 2.2×, pen 6 px / 1.5×, mouse 4 px / 1×). SceneManager sends every "touch" pointerdown there, and a pen's tip only on a
  `(pointer: coarse)` screen (`usesGestures`: a desktop Wacom/Surface pen and any side button keep the mouse path), with
  `stopImmediatePropagation`, so OrbitControls never sees fingers: one finger orbits, two pan (`panBy`) and pinch about their
  middle (`zoomAt`), tap picks (`pickAt(x, y, reach)`), double-tap fits, view-cube taps turn the view; long press only where
  `dragEnabled` (assemblies): on a part it picks it up and the drag moves it, elsewhere the drag just orbits; a second finger then
  takes the move back (`onDragCancel`). Fingers landing while the pen is down are ignored down to their lift (a resting palm; `TouchRouter` in gestures.ts keeps their ids, so their moves never take the mouse path). Wider reach only for fingers and a tablet pen, never a desktop pen. `lostpointercapture`
  counts as a cancel (here, on the sheet and in guardZoom), and timers/frames are cancelled on dispose/unmount. `touchTiming`
  (long press 500 ms, double-tap 350 ms) is lengthened by the smoke test (CI's software-drawn browser is slow); `touchDebug` only
  with ?smoke. In a sketch one finger/the pen is the tool: nothing reaches the controller until the finger moves or
  lifts (so a second finger landing leaves no stray point); a tap = press+release; a drag with Select = press, moves, release; a
  drag with a shape tool (`DRAG_DRAWN`, nothing placed yet) presses where it went down, and lifting is a click (`touchDragStarts`,
  `touchLiftClicks`); a second finger mid-drag calls `cancelStroke` (back to `beginStroke`'s placed points / the drag's start data).
  `SketchPointer.reach` widens every snap/pick distance (`pickMm(e)` in controller.ts). Held keys a tablet lacks: `src/viewport/touchKeys.ts`
  ("Add to selection" = Ctrl/⌘, "No snapping"/"Shift" = Shift) — read modifiers through `additive`/`addHeld`/`shiftHeld`, never
  `e.shiftKey` alone. The touch bar (`src/app/TouchBar.tsx`, only on `(pointer: coarse)` or after a finger touched the page) has those
  toggles plus Clear/Back (Esc), Delete, Planes (P), Look at (N), Fit — the plain keys are sent as real keydown events (`pressKey`,
  sent from the focused element unless that's the bar itself — so while a text box has the focus the shortcuts leave it alone), so each button does exactly what its key does; both held
  keys are let go when the tab changes. `src/app/touchCompat.ts`: on ordinary controls (not the canvas, the sheet, text
  boxes or `[data-own-touch]`) a long press sends `contextmenu` (and drops the made-up mouse events/click of that finger only: for
  `LIFT_MS` after it lifts, only events from touch — `sourceCapabilities.firesTouchEvents`, else near the lift point — and never
  after a mouse/pen pointerdown, so a touchscreen laptop's or an iPad's trackpad clicks always get through; tests/touchCompat.test.ts) and a
  double-tap sends `dblclick`; a browser's own one that follows is dropped. Drawing sheet: capture handlers on the SVG feed a
  GestureTracker — two fingers pan/zoom (`zoomBox`), a second finger drops the first one's drag/box (`dropSheetStroke`), a long press
  on a dimension's number flips its arrows, and a placing tool's press waits for the tap. `guardZoom` only stops (doesn't pass on)
  Safari's gesture events while a finger is down on the view, so an iPad pinch isn't zoomed twice. CSS: `@media (pointer: coarse)`
  at the end of styles.css (44 px targets, eye/row buttons always shown, 16 px inputs so Safari doesn't zoom into them, no
  callout/text selection); feature rows aren't HTML-draggable there (Move up/down in their menu instead). Tests: tests/gestures.test.ts,
  tests/zoomGuard.test.ts, tests/touchCompat.test.ts, tests/sketchTouchStroke.test.ts (cancelStroke after a drag began); the smoke test's touch section. Only a real iPad can confirm Safari's own touch quirks.
- The link with JuraCUT (send a flat design either way): `src/link/juraLink.ts` (pure, the SAME file in JuraCUT — keep them
  identical): both apps are pages of gm7dha.github.io, so their tabs talk over a BroadcastChannel (`LINK_CHANNEL`
  "jura-link.v1"); each tab's `LinkEnd` says here/who/bye, `send` posts a `Parcel` to the other app's newest tab or opens it
  (`siblingUrl`, `?link=<id>` — within the click) and hands it over when that tab says "ready"; the receiver answers "got"
  with what it did, which the sender shows as a toast; messages checked by `readMessage`. App side `src/app/juraLinkApp.ts`
  (`startLink` in App; `sendToJuraCUT` — the Laser panel's "Send to JuraCUT", SVG of the sheet unmirrored; `receiveParcel` →
  `store.addLinkedSketch` → pure `src/link/receive.ts` `sketchFromDxf`: the DXF through Insert DXF's own `parseDxf`/`insertDxf`
  into a new sketch "From JuraCUT: <name>" on Top at the end of the Part Studio on show, or a new studio from an assembly or
  drawing; refused while a feature/sketch is open or an old version shown). Tests: tests/juraLink, tests/linkReceive; the smoke
  test's laser step plays a JuraCUT tab both ways.
- **Laser designs are shared with JuraCUT** (github.com/gm7dha/JuraCUT, the owner's laser design-and-cut app; the owner's
  standing wish): every laser design here (`category: "laser"`) has a JuraCUT twin with the same id, name, heading, icon,
  inputs and maths (JuraCUT's `src/library/`, numbers instead of `Ex`, flat Items instead of sketches). When a laser design is
  added or changed here, port it to JuraCUT in the same session if it's attached (add_repo gm7dha/JuraCUT), else say that
  JuraCUT needs it. JuraCUT's tests/library.test.ts lists the ids it must have.
- Design library (Onshape-style configurable library parts): `src/library/` (pure). `insert.ts` has `LIBRARY` (`designs/*.ts`) in two
  sections, `LibraryDesign.category` "laser" (Laser cutting: finger-joint box, flat-pack phone stand, and `designs/laserSet.ts`'s
  stencil, rubber stamp, name/key tag, coasters, picture frame, living-hinge panel, gear, ruler, then `designs/laserSet3.ts`'s
  sliding-lid box, tray with dividers, bookend, clock face, cord winders, tealight holder, jigsaw, ornament, then `designs/laserSet4.ts`'s
  living-hinge box, card deck box, business card holder, spice rack, tealight lantern, key rack, dice tower, name puzzle, then `designs/laserSet5.ts`'s
  bird box, earring stand, box with drawers, honeycomb desk pot, sunburst mirror frame, tablet/book stand, coaster holder, tissue box cover — flat panels for Export for laser)
  and "print" (3D printing: tray, box with lid, shelf bracket, wall hook, cable clip, phone/tablet stand, print-in-place hinge,
  spacer/washer, grip knob, stamp with handle, and — in `printDesigns.ts`, appended to LIBRARY — bolt/nut/washer set, hex
  standoff, piano hinge, screw-top jar, bit holder block, pegboard hook, drawer pull, desk cable grommet, corner protector, then the third
  batch: Gridfinity baseplate and bin, name plate, battery organiser, spool holder, under-desk headphone hook, plant pot + saucer,
  bag clip, knurled thumb knob, hose/vacuum adapter, SD card holder — each
  sits flat on the bed at z ≥ 0); `LIBRARY_CATEGORIES`, `designsIn`, `categoryFrom`;
  optional `LibraryDesign.group` = a heading within the tab (`designGroups` = `groupDesigns(designsIn(c))`: ungrouped first, then
  groups — that section's `GROUP_ORDER` first (print: Puzzles, Fixings, Hinges, Storage, Gridfinity, Household, Moulds and casting, Desk, Garden, Workshop, Electronics, Test prints; laser: none), the rest in order of first use;
  laser: Boxes and stands, Signs and stamps, Home, Workshop, Toys and gifts, Garden, Desk). The window also has a search box (`browse.ts` `searchDesigns`: every
  typed word must start a word of the name/group/section/description or a choice's label — "M8" finds the bolt set — name matches first; results across both tabs, under
  section headings; cleared on close).
  Text inputs: `InputKind` "text" (`maxLength` default 60, `multiline` = lines split by "\n", ≤ `MAX_TEXT_LINES` 6, `optional`;
  CRLF → LF in `completeValues`; parse.ts keeps strings ≤ 1000) — saved in the insert's `values`, changed by Edit design sizes,
  never variables; the font is a plain "choice" (`textKit.fontInput`). `textKit.ts`: words go in as ordinary sketch Text (one
  `SketchText` per line, anchor "centre" at a point dimensioned from the origin, `addTextBlock`), sized so capitals are the given
  height (`sizeForCaps`/`capShare`: the H's height), measured with the very same outlines (`blockContours` → textContours);
  `missingLetters` (a stand-in font with no glyphs can't be judged). `stableIds` (now `stableIds.ts`) also gives texts ids
  `<feature>_t<i>` and re-points their anchors. Stencil (`designs/stencil.ts`): Sheet sketch (letters' box + margin, variables
  margin/thickness) → Letters sketch (Text) Remove through all → Bridges sketch (rectangles) Add — so the part's face exports red
  outline + blue holes. Bridges are pure in `bridges.ts` (`planBridges`): an outline inside an odd number of others is an island;
  strips of the bridge width are tried up/down/left/right (outlines turned so the direction is +y) at `PLACES` spots across it,
  each checked on `LINES` lines across its width — it must start in the island, cross exactly one stroke (2 crossings) and end in
  sheet or another island (`stencilAt`), and no other outline may enter it (`segmentInBox`); upright before sideways, then the
  shortest; `perIsland` 2 = one on the opposite side; `unheldIslands` follows island→island links to the sheet (the design refuses
  unheld ones). `stencilPlan` caches plans (the preview asks each key). Rubber stamp (`designs/stamp.ts`): Plate sketch → Plate
  extruded *down* (flip) from Top, then "Stamp sketch" (outline + border as two outlines + mirrored Text) Remove down by `relief` —
  with no areas picked its even–odd shapes are exactly the background; `LibraryDesign.laser` = Export for laser settings for a
  sketch by role ({"stamp-sketch": {background: true}}), looked up by `laserDefaultsFor(doc, sketchId)` (LaserPanel applies them when
  that sketch is chosen, via `sketchSettingsFor` in sources.ts: a design's settings over `SKETCH_DEFAULTS`, and back to the defaults
  when the next sketch has none — `laserState.fromDesign` — else the user's choices stay; export_for_laser uses them unless told
  otherwise; the living hinge sets `open: "cut"`). The printed stamp: block + Words sketch (border ring +
  mirrored text) Add from z 0 to base + relief, handle a New cylinder beside it. Engraved plates (`designs/engraved.ts`: coasters, tag,
  ruler): one sketch (outline(s), holes, Text, lines); per plate (a coaster set: `pieceOf`, nearest coaster) a New extrude down with
  `areas` = that plate's areas but the holes, then its letters a plain (not `apart`) Remove down `ENGRAVE_DEPTH` 0.4 with `areas` =
  its letters — so it cuts only the latest part, the plate just made, never a user's part or other coasters (engineLibraryLaser
  "engraving reaches only the design's own plates") (`laserKit.pickAreas`: stableIds first, so the picks' curve ids are the
  feature's; areas classed by a point inside and how many letter outlines are round it, `onLetters`). `extrudeFeature` takes
  `areas` and `apart`.
  Loose lines (`laserKit.addLines`: free points, no relations — "fix" on hundreds of points makes analyzeSketch take seconds):
  living hinge (`hingeCuts`: columns `spacing` apart over the zone, every other one offset half a step, clear of the edges by
  `gap`; the panel extrude ignores them; Export for laser cuts them blue), gear (`gearOutline`: involute flanks
  β(r) = π/2z + inv φ − inv(acos(rb/r)), radial below the base circle, root/tip as short lines, `gearFlankPoints` per flank — 6 + 2 per mm of module, ≤ 1400 / teeth — within ~0.01 mm; `gearSizes`;
  the summary warns below `UNDERCUT_TEETH` 13 at 20°, 23 at 14.5°), ruler marks
  (`rulerMarks`, `MARK_GAP` 0.5 mm off the edge so they don't split the outline; laser setting `open: "score"`). These sketches
  aren't fully defined (library.test's `LOOSE_LINES`). Picture frame (`designs/workshop.ts`): back (hang hole), middle (a U open at
  the top, photo + 0.5 mm), front (window = photo − overlap), stacked with Moves; sizes are variables. Each is a `LibraryDesign` (id, name,
  description, `icon` = fixed SVG markup, `inputs` with defaults/limits, `problems`, `make`, `preview` shapes, `summary`).
  The library window shows the sections as tabs (3D printing first time, then the last one in localStorage `juracad.libraryTab`, `tabMemory.ts`, try/catch; roving tabIndex);
  `libraryInserts` don't store the category. Newer designs: box with lid (`boxLid.ts`: lid = a tray upside down, inside = box
  outside + 2 × clearance, default `DEFAULT_FITS.snug`; "on the box" = a Move turned 180° about X and lowered), hook and cable clip
  (profile on Top made `width` upwards, so they print on their side; the screw-head face is on the Right plane, x = 0, so
  `countersunkHoleFeature` (a Hole, not apart, through all) drills it; `moveFeature` in sketchKit too), stands (`standProfile.ts`,
  shared by the printed `phoneStand.ts` and laser `flatStand.ts`: the lean angle is a whole-number input, not a variable — no trig
  in expressions — so its sine/cosine go in as 6-place numbers, `trigOf`; the flat-pack one is a side on Front + two feet on Right
  with cross halving notches drawn `kerf` narrower; the front foot right under the slot's back corner (x = 0…t, the origin), its top flush with the slot floor, so the phone stands on it), hinge (`hinge.ts`: per leaf a plate, a full-length knuckle cylinder,
  then the other leaf's knuckles cut away ± clearance and a bore — exactly the pin for leaf 1 (it prints joined to the pin), pin +
  2 × clearance for leaf 2; the pin a New part; `hingeFeatures(ctx, n, { patterned, afterLeaf })` is shared with the piano hinge,
  whose knuckle count comes from a knuckle length (`pianoKnuckles`, odd, ≤ 199), whose cut-outs are one gap + a Linear pattern, and
  whose countersunk holes are drilled from each leaf's top face — a sketch on the face (`printKit.topFacePlane`: a face plane with
  `face` TopoPick, so `followSketch` moves it when the thickness variable changes), as the faces that meet when folded must take the
  heads). Printed threads (`printKit.ts`): the designs' Thread features are always the whole face (`length` 0, so which end is
  the face's "far end" — `cylinderOfFace`'s axis follows the edge's parametrisation and can point either way, which also shifts
  where the groove starts round the turn — never matters) and give somewhere clear to run out: a bolt's rod is turned down to
  the thread's root for `RELIEF` (1.75) × pitch above the head (rod New from z = 0, an annulus removed, the head Added back), a
  jar's neck and lid have a pitch-long run-out then a 45° slope. They use the Thread feature's optional `depth` param (mm; 0 =
  standard; capped at `maxGrooveDepth` = 7/8 pitch wide at the surface): `PRINTED_DEPTH` 0.75 × pitch for both bolt and nut,
  placed `THREAD_SHIFT` × pitch apart so a fit of 0 just touches along the flanks; printed fit c = rod −2c, nut hole +2c = a
  gap of exactly c square to the flanks (`threadGap`), teeth overlapping 0.634 × pitch − 2c (`threadOverlap`; refused below
  `minOverlap`, `maxFit` named). With the engine's standard pointed grooves the overlap is only 0.29 × pitch − 2c (gone at
  0.2 mm on M8), hence the deeper groove. Sizes: `boltSizes.ts` (`printFastener`: M3–M12 from model/fasteners.ts, a custom
  size in ISO proportions; `ISO_COARSE_PITCH` = kernel ISO_COARSE, pure). Bolts stand on their heads (round threads, no
  supports). Other builders there: `revolveFeature` (Front-plane profiles round Z; New = apart), `gridPatternFeature` (count or
  rows may be 1). Pegboard hook: plate + arm drawn on Top, `width` up from the bed; round pegs from the Right plane out the
  back (flip), their middles at z = peg / 2 so their undersides rest on the bed; the top peg has a short round lip hanging down
  at its end (a second rod `lip` lower, the peg's length, then the part of it outside the peg cut back to just behind the
  board: a Remove with `areas` = the crescent, picked with laserKit's `pickAreas`). Peg + lip ≤ hole − `PEG_ROOM` (0.3), so
  held up it goes straight in, then drops onto the holes' bottoms and the lip catches behind the board; lift by the lip and
  pull to take it off (engineLibraryPrint2 does exactly that against boards with real 6 and 6.35 mm holes, step by step). The printed stamp is under Household. A Thread `depth` over `maxGrooveDepth` is held to it with a
  `featureWarnings` note; drawings' thread marks use the given depth's root (`minor` = major − 2 × depth). A sketch can't start above a plane, so floors under cut-through holes are Added back (bit holder: holes cut
  right through by one patterned Remove, then a floor Added; corner protector: a C extruded, then an end plate Added).
  `ex.ts` `wholeNegation`: only strip "-( … )" that wraps the whole text.
  `insertDesign(doc, design, values, { into: "new" | studioId })` adds variables `<prefix>_<key>` for inputs marked
  `variable` (`freePrefix`: box, box2…), the features (ordinary sketches/extrudes/copies/patterns, in a folder named after the
  insert, ids `<insert id>_<role>`), part names and a record in `doc.libraryInserts` (`LibraryInsert`, parsed by
  `library/parse.ts`; missing in older files). Inputs that change what's made (finger width, lid, holes, gussets) aren't
  variables: `editInsert` ("Edit design sizes", the folder's right-click menu or the library window) makes the features
  again with the same ids, each in its own place in the list (the user's features don't move; name, folder, `suppressed` and
  `visible` kept; ones the user deleted come back before the next design feature and are named in `remade` → a toast), after
  `applyVariables`. `LibraryInsert.variables` holds its variables' ids, so a renamed variable is still the one used. Sketch
  items get ids from their place (`stableIds`: `<feature>_p3`…), so links from other sketches survive an edit. Only the
  designs' New extrudes carry `apart`; their Add/Remove extrudes and patterns keep the old rules (the latest part = the design's
  own), so a design put into a Part Studio with parts never cuts or joins the user's parts. Insert/edit put the expression
  scope back afterwards (`keepingScope`; the store and the extension set it themselves). Sizes are `Ex` (`ex.ts`:
  value + expression text, `plus`/`minus`/`times`/`fraction`…; `signed` gives a dimension's side, so "-(box_kerf / 2)" works
  at kerf 0). `sketchKit.ts`: `outlineSketch` (every corner dimensioned from the origin with the expressions — fully
  defined), `shapesSketch` (mcp/sketchShapes' buildSketch with expression sizes), `roundCorners` (sketch fillets), Feature
  builders. Finger box maths in `fingers.ts`: odd finger counts (`fingerCount`, wide enough for thickness + kerf; at least 3 whenever 3 fit), the 8
  corner cubes belong to the front/back, bottom/lid ↔ sides run between them (D − 2t); `panelOutlines` (bottom, front,
  left; lid/back/right are Move/copy copies), kerf = every edge kerf/2 further out (`grow`; the 3D panels then overlap by
  that). No Plane features (they'd need `refreshDocumentPlanes` wherever variables change). UI `src/app/LibraryDialog.tsx`
  (`store.library`: browse / a design picked / edit; Toolbar "Library"); store `insertLibraryDesign`/`editLibraryDesign` (one
  undo step; a new Part Studio is shown). Claude: `src/mcp/libraryTools.ts` (list_library_designs, insert_library_design —
  into the Part Studio on show). Tests: tests/libraryFingers, library, libraryLaser (pure: text inputs, mirrored text, bridges, background engraving, maths), engineLibrary, engineLibraryLaser (stencil holes with no island left floating, the stamp's engraved background = plate − border − letters, every laser design) and engineLibraryPrint (volumes, no overlaps, the hinge's and lid's
  gaps by nudging a part 90% of the clearance, variables, a user's overlapping part left alone), mcpLibrary (incl. the
  `category` filter of list_library_designs); the smoke test inserts a box and widens it in Variables, then a box with lid from
  the 3D printing tab (2 parts), then a stencil of HELLO saved for laser (1 red, 5 blue); mcpLibraryLaser (words through
  insert_library_design, a stencil and a stamp exported).
  The smoke test also finds a bolt set with the search box (thread off, 3 parts). New print designs' tests:
  tests/libraryPrint (pure: sizes, thread maths, fully defined, groups/search), engineLibraryPrint2 (piano hinge turned round its
  pin with no clash, volumes), engineLibraryThreads (heavy: bolt and nut free at a 0.2 mm fit somewhere in each turn with room
  both ways, just touching at 0 — found by a golden-section search — overlapping at −0.1; the jar's lid screws on; groove depth).
  `cutThread` retries a piece OpenCascade returns no shape for (as for a poor cut), and accepts up to half a turn's extra
  removed near an end (a deeper groove's sides spill past it).
  Third batch (`printDesigns.ts` `PRINT_DESIGNS_3`): Gridfinity (`designs/gridfinity.ts`; sizes from gridfinity.xyz, the Printables
  spec and gridfinity-rebuilt-openscad, cited there): 42 mm grid, 7 mm units, bins 42n − 2 × gap (0.25) with r = 4 − gap; foot
  `FOOT_STEPS` 0.8/1.8/2.15 (35.6 → 41.5), pocket `POCKET_STEPS` 0.35 straight + 0.7/1.8/2.15 to 42 r4 (plate 5 high, cut on past the
  top), lip = cavity steps 0.7/1.8/1.9 to 4.4 above 7 × units over a 1.2 straight + 45° support; magnets 6.5 × 2.4 at ±13. Stepped
  outlines are ruled Lofts (`Feature.loftRuled`, "Straight between shapes" in the Loft dialog, `loftSketches(…, { ruled })`; parsed)
  through rounded rectangles on fixed level planes (`printKit.levelPlane`: a face plane with no face/planeRef — only for heights no
  variable drives; so the Gridfinity designs have no variables) — exact 45° (offsets of a rounded rectangle). One foot + grid
  pattern; `binPlan`/`stepsVolume` (Simpson, exact). A bin rests with its bottom level with the plate's (`RESTS` 0: the slopes just touch); held at `CENTRED`
  (0.35) it clears a cell by the gap on the straight parts and (gap + 0.1)/√2 on the slopes; stacked at 7 × units it clears the lip the same. Dividers/ledge stop below the support (generic
  heights, so booleans never meet edges exactly); the ledge reaches 0.02 into the walls (wall ≥ 1.2 keeps it inside the corners).
  Name plate (`sign.ts`): words + border ring on the plate's top face (`topFacePlane`), Added up or Removed down; holes or a foot
  with a slot (New). Pot + saucer: revolves, saucer rim = pot radius there + gap (`potSizes`, a ratio of variables), ribs between
  the drain holes (holes half a step round). Bag clip: rod + C channel on Right, made along X; both cut flat at 45° (`FLAT_AT`);
  `clipSizes.strain` = spread × wall / (3π R²) (Roark split ring) ≤ 2%. Sign foot slot = plate + relief only for a raised border. Thumb knob: pocket = table flats + 2 × fit, as deep as nut/head. Hose adapter: 45° cone between ends
  sized "into" (outside) or "over" (inside + fit). Tests: tests/libraryPrint3 (pure), engineLibraryPrint3 (bin in a baseplate cell at
  ±0.2 but not 0.3, a bigger bin refused, bins stack, pot in saucer, clip on rod held by its lips, nut in the knob's pocket),
  mcpLibraryPrint3; the smoke test searches "gridfinity" and inserts a bin (1 part, 83.5 mm).
  Fourth print batch (`printDesigns4.ts` `PRINT_DESIGNS_4`, appended after the third): electronics enclosure (`enclosure.ts`, Electronics:
  box on the bed + lid upside down in front of it, `lidAt` −(outer depth + 10); boards `BOARDS` (Pi 4/5 holes 58 × 49, 3.5 in from the
  corner, M2.5; Uno R3, M3; custom = 4 holes in a centred rectangle), standoffs rings from z 0 (the floor fills under the holes),
  `SCREW_HOLES` self-tap 2.2/2.6, heat-set (Ruthex / CNC Kitchen, 4.6 mm across) a 4.0 mm hole for both, 5.7 long; screwed lid: square corner posts `post`
  = max(7, hole + 4) reaching half into the walls, a 3 mm locating lip notched round them, four M3 countersunk holes drilled up
  from the bed (`hole.flip`); snap lid: an 8 mm lip 1.2 thick with a 45° ridge (0.5) on the long sides, the box's grooves = the
  ridge offset by c square to 45° (`groove` = 0.5 + (√2 − 1)c), both Right-plane triangles extruded symmetric; `snapStrain`;
  vent slots + a pattern in the lid; two cut-outs on a side via `printKit.facePlane` (a face plane of any direction with a
  `face` pick, so it follows the wall when a variable moves it), Remove flipped by wall + 0.5). French cleat (`frenchCleat.ts`,
  Workshop): strip on Right printed front face down (`stripPrinted`; its slope faces up, nothing overhangs; `stripOutline` is
  the hung shape) + countersunk holes drilled up from the bed (`hole.flip`); holder drawn on
  Top (x out from the wall, y up, its top at −`CLEAT_GAP`) and made `width` up, so it prints on its side; its slope c square to
  the strip's, back c off the wall, plate c in front; `hangLift` lifts it to hang (tests turn it −90° about y). Hinged box
  (`hingedBox.ts`, Storage, uses `hingeSizes`): box y < −g, lid y > g, pin along x at a = (box + lid)/2 so a 180° turn lands rim
  on rim; each side's block stays below the pin with a 45° underside tangent to its knuckle (`boxBlock`/`lidBlock`; the lid's
  stays out of its wall's line above the lid's rim, which would land in the box's wall); box knuckles solid + the pin Added
  after its gaps; lid bore pin + 2c; heights aren't variables. Desk organiser (Desk): a row of sizes typed as text (`cupSizes`) or
  a patterned grid, cut through then floored. Cable chain (`cableChain.ts`, Workshop, no variables): middle full width with the
  channel cut, outer layer behind (slanted back edge = the bend stop, `backTop` from (a − gt)cos θ + R sin θ = a; bottom
  corner c behind → `sagAngle` a couple of degrees), inner layer in front (half circle round the joint), 45°-tipped pins
  revolved on a `fixedPlane` through the joint, and a lead-in ramp cut into each outer layer's inside face (`ramp`: pin hole
  wide, `reach` deep at the back edge, nothing at the hole, so pushed together the layers bend apart gradually); a = R + 4 so
  nothing else meets while turning; `snapStrain` (both layers bend, half the reach each);
  copies by Move/copy along −y. Wall pocket (Household): back plate behind the Front plane, holes drilled from it flipped.
  Shelf pins (Household): block + pin standing up, copies. Test prints (`testPrints.ts`, Test prints): fit test (holes peg +
  2c for `steps(from, to, step)`, raised numbers via `labelsSketch` on the plate's top before the holes — `fitLabels` shrinks
  numbers whose widest would come within `LABEL_GAP` of a neighbour, `labelsProblem` refuses below `MIN_LABEL` 2.5 — a peg with a base),
  overhang test (Front-plane fins, underside at the angle from upright, 1 mm into a Top base, numbers on the base's front
  strip made before the fins so its face is whole), bridge test (one pillars-and-deck outline). Tests: tests/libraryPrint4
  (pure), engineLibraryPrint4 (volumes; the lid ±0.9c free, past c not, a snap lid caught when lifted; screws line up; the
  cleat's 45° faces 0.9c free square to them, catching when pulled; the hinged lid turned 0–180° untouched; links bent 0…bend
  free, stopped past it and past the sag, held by their pins; half of link 2 slid onto link 1's pin: the bend needed grows
  gradually from ~0 at the back edge to the reach at the hole's lip, 0 seated; fit-test holes, overhang face normals, bridge gaps by probe boxes;
  a user's part untouched), mcpLibraryPrint4 (a cleat and shelf); the smoke test searches "raspberry" and inserts the
  enclosure (2 parts, 108 mm).
  Fifth print batch (`printDesigns5.ts` `PRINT_DESIGNS_5`, appended after the fourth; existing headings only). Shared pure
  helpers `designs/printShapes.ts` (`clipToBox` Sutherland–Hodgman, `areaOf`, outline/rect/circle shapes, `cantileverStrain` =
  1.5·t·δ/L², `SNAP_STRAIN` 2%). Honeycomb Storage Wall (`honeycomb.ts`, Storage, no variables; numbers from bigtaed-sys/
  hsw-generator's constants.ts/lattice.ts and PStover's standard insert, measured from its mesh in that repo, cited there):
  holes 20 across flats, FLAT TOP AND BOTTOM (`flatHex`, corners along x), 23.6 apart up a column, columns 23.6·√3/2 = 20.44
  apart, odd columns half a hole up (half holes at their ends); `HOLE_PROFILE` from the front face: 20.8 at the face, 20 from
  0.5 to 5.1, taper to 22 at 6.0, 22 to the back (8) — `holeAt`; the tile prints face down, each column parity's hole a ruled
  Loft of `flatHex` sections + grid pattern; screw cells refilled with a clipped 22.4 hex, drilled up from the bed; `tileVolume`
  integrates the clipped areas (Simpson). Inserts print standing on the plug's end (z up; wall face at `FACE_Z` 7.5, lip 22.5 ×
  3 above, overhanging 1.4): plug = 19.7 flat hex, two Π slots (from a level plane below the bed up to 0.3 behind the face)
  free 1 mm fingers on the top and bottom flats, `BUMP` (PStover's: 9.85 at 5.0 → 10.37 at 5.75 → 9.85 at 6.3 behind the face,
  slopes < 45°, inside the taper when seated) on Right extruded `BUMP_WIDTH` 7; `plugStrain` 1.87%. Hook: Right-plane arm up
  from the lip along the plug's bottom, 45° brace and a 45° tip. Bin: two parts — the insert + a dovetail `RAIL` (45° sides,
  Front, symmetric 18 long) whose top end is cut at 45° (`railEndOutline`), and a bin printed upright whose back groove
  (rail + fit square to every face, `grooveOutline`) is open at the bottom and closed by a 45° roof (a ruled Loft to 0 depth at
  the back face, `roofFoot`…`roofTop`); hung, the roof sits fit × √2 above the rail's end (`hangsBelow`). Gridfinity
  (`gridfinityMore.ts`, reusing gridfinity.ts's now-exported `steppedLoft`/`roundedSketch`/`firstCell`/`area`): magnet
  baseplate = the open pocket raised onto a floor (`FLOOR_TOP` = 2.4 + 1) with 4 × 6.5 × 2.4 pockets at ±13 cut down from it
  (bins rest at FLOOR_TOP; magnets glued, the pockets are loose); bit/screwdriver holder = bin body + feet, hex or round holes
  down from the top; lite bin = walls 0.8–1.2, feet hollowed by `liteFootSteps` (offset square to each face, top step + 0.05).
  Pipe clip (`pipeClip.ts`, Fixings, Edit design sizes): Top profile `width` up, base y = −base…0, ring centre half a wall
  above the plate, mouth = pipe × (1 − grip %), holes from the Front plane flipped; `arcStrain` (curved cantilever, Castigliano;
  = Roark's s·h/(3πR²) for a free ring) from `fixed` = acos(centre/outer) (where the ring's outside meets the plate) ≤ 2%:
  default grip 18% (1.3% at 22 mm, 1.8% at 15 mm; small pipes are refused with "use less grip"). Charging stand (`chargingStand.ts`, Desk; fixed angle, chosen over a
  hinge): standProfile's shape with the phone's floor on a plinth `plugLength` + `BEND_ROOM` (8) high; the plug slot is a
  slanted band along the phone's lean (`band`, Right plane: from the socket — middle of the phone's bottom face, the phone
  `PHONE_ROOM` thinner than the slot, standing on its back corner (0, floor) — `plugLength` + `PLUG_END` down along
  (cos, −sin), `PLUG_THICKNESS`/2 + `PLUG_CLEAR` each side), the lip/plinth front moved forward to keep `FRONT_WALL` in front
  of it (`lipFront` = max(slot front + bar, plugFront + wall)); a pocket from inside the plinth (`POCKET_WALL` behind the
  rest's foot) to the band's lower end for the cable to turn, and a channel out of the back; printed upright (angle ≥ 45°); `phoneMiddle` (a `BIG_PHONE` 165 mm phone) must stay 5 mm inside the
  base's back edge; width is the only variable. Spool holder on a 608 (`bearingSpool.ts`, Workshop): base + 11 shoulder +
  pin 8 − fit, hub with a 22 + fit pocket (0.5 mm 45° chamfer at its mouth, a ruled Loft of circles) under a 19.5 ledge;
  `fit` = the design's own variable starting at `DEFAULT_FITS.press`. Funnel (Household, brim advice): 45° revolve, inside
  offset square to the cone. Door wedge (Household, width a variable) and cable tie anchor (Desk; ≥ `TIE_ROOF` 4 of roof each
  side of the screw's access hole; M3/M4 from the fastener table). Box divider set (Storage): egg-crate dividers flat on the bed
  in a grid ≤ `LAYOUT_WIDTH` 240, slots t + fit, each half + 0.25. Tests: tests/libraryPrint5 (pure), engineLibraryPrint5
  (volumes; inserts in a tile's hole free ±0.1 across / ±0.05 up, held pulled 0.3, stopped pushed 0.1; a stand-in with PStover's
  measured profile fits the same way (his real mesh — CC BY-NC, so not committed — was checked by hand: 0 overlap seated);
  the bin on its rail slides up, stops fit·√2 down, held off the wall; a 6.5 × 12 plug box tilted with the phone from its
  socket clear of the stand at the defaults, plug 40 and angle 75; magnet probes; bins in the magnet plate; pipe free ±0.18
  and held; the bearing ± fit/2; dividers crossing; a user's part untouched), mcpLibraryPrint5; the smoke test searches
  "honeycomb" and inserts the tile (1 part, 122.63 mm).
  Sixth print batch (`printDesigns6.ts` `PRINT_DESIGNS_6`, after the puzzles; heading "Moulds and casting", after Household):
  casting moulds for wax, concrete and Jesmonite, no variables. Shared pure outsides `designs/mouldSurface.ts`: a cast is a
  stack of level `Section`s (a circle, or a polygon whose corners sit at the same angles on every level) joined by a ruled
  Loft, so `stackVolume` (Simpson per slab) is exact; z from the CLOSED end (0) to the open end (H), width W at the open
  end. `OUTSIDE_SHAPES` (round/square/hexagon/octagon/faceted `sides`/fluted `ribs`/twisted `twist`/tapered `narrow`/barrel
  `bulge`/stepped `tiers` with 45° steps/dome = a ball cut `draft` below its middle, `domeMostHeight`) × `SURFACE_PATTERNS`
  (`patternAt` 0…1 × `patternDepth`, added to the radius so it stands proud on the cast; repeats `patternCount`, cells as
  tall as wide; honeycomb/dots use an even column count; lowpoly = seeded `facetHeights`); `outsideInputs()` is the same
  input list on every mould. Sampling caps `MOST_CORNERS` 96 / `MOST_LEVELS` 36 / `MOST_POINTS` 1200 (corners drop to ≥ 5 per
  repeat first; else "too much detail"). Release rules in `outsideProblems(o, size, release, material)` (problems, not hidden
  choices): "rigid" (one-piece shells) refuses `LOCKING_SHAPES` and patterns that change up the height (only none, ribs, waves)
  with the owner's wording, then `lockedAt` (every corner ≥ draft further out on the level above, no turning); "split"
  (pillar halves along y = 0, pulled apart in ±y) fades relief within `SPLIT_FADE` 35° of the split and `splitCatch` checks
  every edge's normal on each level and half-way, an edge crossing y = 0 counting in BOTH halves (twisted always catches,
  so it's refused for split moulds — master only); "master" anything; all check `steepestOverhang` ≤ 45° (corner moves square
  to their faces). `wallAround` = the mould wall (plain base shape ≥ wall clear of every point, leaning ≤ 45°); `sideOnX` turns
  rigid moulds' polygons a side to +x (`CastSize.turn`). `mouldKit.ts`: stacks → level sketches + lofts, densities (wax 0.9,
  concrete/Jesmonite 2.1, silicone 1.1), `waxLine`/`concreteLine`, and the advice sentences every description ends with.
  Pillar candle mould (`candleMould.ts`): poured upside down (candle top = closed end on the bed, wick hole on the axis);
  two halves standing, half B `HALF_GAP` along −y; flange `FLANGE` × `FLANGE_THICK` with diamond pegs (`PEG`) on one side and
  holes `fit`·√2 bigger on the other (B the other way round), V band notches. Round with no pattern: outer loft + flange −
  cavity − other half (fast). Polygon casts (`byHalves`): each half is ONE ruled Loft of `halfSections` (flange, wall over
  the top, back along the split, round the inside; the closed end's inside is the wick hole at the same angles, opening to the
  candle over `TOP_DIP` 0.5) — replicad's booleans run SimplifyResult, ~1.5 s each on ruled faces, so detailed cavities are
  never cut; patterned pillars still take ~3–10 s. "Make a master instead" = the cast standing on its base (`masterStack`).
  Wick centring bar; wax melt tray (`meltTray.ts`: cavities shrunk towards `shrinkCentre` so the nearest side tilts by the
  draft; heart = two lobes + tangents). Shell + inner piece (`castMoulds.ts` `cupPlan`): shell New loft − cast; the inner
  piece hangs from a flange on the rim, a `LIP` round the shell's outside with `fit`, pour holes over the concrete; core =
  `insideAt` (wall square to drafted sides; a dome's concentric ball), hollow with a 45° pointed roof (pot) or solid; drain
  pin; dish raised-centre cone (recess); holder plug with its own `POCKET_DRAFT` 1° sized from the bottom
  (tealight 39.6 × 18, taper 21.8 × 25; "cube" = square, H = W); dish ring post ≤ `RING_POST`; `floatWeight` (summary: what the
  inner piece pushes aside × `WET_CONCRETE` 2.3 − sand in its hollow × `SAND` 1.6 − plastic × `PRINTED`, +25%, to the next 50 g —
  a sand-filled core still floats, so the wording says weigh it down or tape/clamp it); `bedProblem` (shell + inner piece ≤ `BED`
  250 across) on all three; a 3 mm wall note above 150 mm; turned over
  beside the shell (`beside`, `lowest`). Volumes `pillarVolumes`/`cupVolumes`/`meltTrayVolume`/`wickBarVolume`. Pegs `PEG_LENGTH` 2.5 into
  `HOLE_DEPTH` 3 (1 mm of flange left behind). Search maps "mold"→"mould", "centering"→"centring" (`britishSpelling` in browse.ts). Tests: tests/libraryMoulds (pure), engineLibraryMoulds (volumes to 2e-5,
  halves meet with pegs free by 0.9·fit·√2 and hitting at 1.3, core probes, discs fit high and hit low, a user's part
  untouched), mcpLibraryMoulds; the smoke test searches "candle" and inserts the pillar mould (2 parts, 96 mm).
  Third laser batch (`designs/boxes3.ts`, `laserHome3.ts`, `jigsaw.ts` + pure `puzzle.ts`, `ornament.ts`; list in `laserSet3.ts`).
  Sliding-lid box: a laser can't cut a groove part-way, so each groove is a *rail* — a second panel inside each long wall with a
  through slot (a C open at the right-hand end, `slidingOutlines().rail`); grooves z = g0…g1 (g0 = H − 3t − 2c, g1 = g0 + t + 2c), a 2t
  strip above, the slot stopping 2t short of the left wall (`bridge`); the right end wall is g0 tall and the front/back fingers on that
  end stop there (`SideSpec` "full" `upTo`, fingers.ts); lid x = 3t + c…W, y = t + c…D − t − c, moved up to g0 + c. Tray with dividers:
  the open finger box's panels + dividers along x (slots down from the top) and y (slots up from the bottom) to half height (H + t)/2,
  each `DIVIDER_ROOM` (0.5) shorter than the inside, equal compartments (`dividerTray` centres); all outlines grown by kerf/2 (`grow`).
  Bookend: base (Top, 3 slots), upright (Right, 2 tabs + a slot), brace (Front, 2 tabs); holes are drawn kerf/2 smaller (`shrink` =
  grow on the reversed loop). Clock face: one engraved-plate sketch (`engravedPlate`, now exported from engraved.ts) — outline, centre
  hole (default 8 mm), numbers as Text, marks as Text "I" turned radially (engraved; fully defined) or dimensioned lines (`open: "score"`).
  Cord winders: H outlines side by side (`pieceOf` by y). Tealight: base + rings (hole = candle + 2 × `TEALIGHT_ROOM`) stacked by Moves.
  Jigsaw (`puzzle.ts`): each edge between pieces = line, shoulder arc, head arc, shoulder arc, line (`tabEdge`: head R at HEAD_RISE·R,
  shoulders SHOULDER·R touching it, neck 2·NECK·R = 0.618 of the head, so it locks); side/position/size from `seeded` (mulberry32) by
  the pattern number; `narrowestGap` (box-filtered; `puzzleProblems` asks only up to MIN_GAP) checks no cuts come within 1.5 mm, so
  pieces never overlap; ≤ `MAX_PIECES` 400. The board is its own rectangle sketch (picking hundreds of areas is slow); the "Puzzle
  sketch" (border split at the piece corners + the cuts, points left free — LOOSE_LINES) is what Export for laser uses: border red,
  each cut between pieces one blue open run (sketchPiece's `joinThroughBends` joins a junction group's lines end to end where
  just two of its curves meet), necks at least `MIN_NECK` 2 mm or the sheet thickness; a crowded pattern names another number
  only if it works. Ornament: star (outlineSketch), circle, heart (lines tangent to two arcs) and snowflake (hex middle,
  six arms with 60° branches, an eye round the hole; the top arm drops its branches when the eye would reach them) — the curved
  ones as free arcs/lines; `outlineGap` refuses outlines that cross themselves or come within `EDGE_ROOM` 1.5 mm of themselves;
  words must keep `WORDS_ROOM` from the edge and hole. Bookend "Base depth" is the base's whole length. Tests: tests/libraryLaser3 (pure: tabs lock, pieces tile, same seed same puzzle, grooves/slots, fully defined) and
  engineLibraryLaser3 (volumes add up, no overlaps at kerf 0, the lid slides out with clearance and clashes any other way, laser
  layers, a user's part left alone); mcpLibraryLaser inserts a jigsaw and exports it; the smoke test inserts a 12-piece jigsaw and saves
  its sketch for laser (1 red, 17 blue).
  Fourth laser batch (list in `designs/laserSet4.ts`; no variables but the deck box's sizes and the name puzzle's thickness — the
  outlines are worked out from the sizes, so "Edit design sizes" changes them). Shared pure helpers: `outlines.ts` (polygons in
  numbers: `offsetPolygon` — square to each side, a sharp corner cut off square |d| out from it so the outline keeps ≥ |d| from
  every point of the old one (a hole's room is never short); `outlineGap`, `insideGap`, `crossesItself`, `convexHull`, `fitsBed`
  = the R1's 600 × 300 bed less 10), `sidePanels.ts` (two sides + pieces between them: each piece a cross-section — centre,
  angle from +x towards +z, length, `tabs` stretches — width `width` across with tabs t further through slots in both sides;
  slots kerf/2 smaller, pieces kerf/2 bigger; `assemblyProblems` checks slots ≥ `WEB` (2) from each other and the edge,
  sections not overlapping (SAT), the bed; features: the side on Front flipped, moved to y = width/2, copied to the other side;
  each piece drawn flat on Top centred (bbox centre = its middle), New, then a Move with `ry` = −angle about its own middle and
  dx/dz — `moveFeature` now takes ry/rz), `patterns.ts` (lantern holes on lattices that guarantee ≥ bridge between shapes:
  circles/stars on a triangular grid size + bridge apart, honeycomb flats facing exactly bridge apart, diamonds on a 45° square
  grid size + bridge·√2 apart; `patternIslands` runs the stencil's `planBridges`/`depths`, `patternGap` the narrowest bridge).
  Designs: living-hinge box (`hingeBox.ts`: bottom = the inside outline W − 2t × D − 2t (corners R − t, `filletCorner` on the
  4 sharp corners of `bottomOutline` only) with fingers out to the outside on the straight parts (odd counts, the strip owns the
  ends); the wall in 3D is the ring (outside/inside rounded rectangles) H − t tall minus the bottom's own sketch (a plain Remove,
  depth t); the strip laid flat is the sketch "Wall strip" (not extruded; laser setting `open: "cut"`), length = straight parts +
  4 × π/2 (R − t/2), starting mid-back, notched where the bottom's fingers go, `hingeColumns` staggered in the 4 corner zones;
  lift-off lid = top plate + under-plate `LID_ROOM` clear; the back's second half's notches are `s + min(Lx/2, from…to)`
  (libraryLaser4 walks the strip round the mid-sheet path against `bottomOutline`: no mismatch at several sizes); corners need
  an inside radius ≥ `BEND_RATIO` (3) × t and ≥ `MIN_ROWS` (12) rows of cuts; the strip's ends meet mid-back (glue note);
  the bent wall is `LibraryDesign.notCut` (roles; `notCutParts(doc)` in insert.ts), left out of Export for laser's "all"
  (`laserSources`' last argument) and export_for_laser with no source; LOOSE_LINES), card deck box (`deckBox.ts`: open finger box W/D/H from card + 2c + 2t,
  thumb notch = a plain Remove circle on the front's top edge before the back is copied, lid as above), business card holder
  (`cardStand.ts`: base, lip, back leaning `LEAN` 15° with its lowest corner on the base; sides = hull of the sections moved out
  m), spice rack (`spiceRack.ts`: width n·d + (n + 1)·`JAR_ROOM`, rails front and back of each shelf; shelf pitch = jar + max(`HEADROOM`, rail + `RAIL_LIFT`) + t, so a jar lifts over the front rail), dice tower (`diceTower.ts`:
  back/front `m` in, ramp at `RAMP_ANGLE` from the back to the front edge, baffles alternating front/back, each reaching all but
  `DIE_ROOM` × die, its upper end's lower corner on its wall; the drop room under each baffle's end is checked before the
  assembly's own problems), tealight lantern (`lantern.ts`: open finger box, the same pattern on all four walls inside a window
  clear of the fingers by the margin), name puzzle (`namePuzzle.ts`: one blockContours per character, laid out by boxes `gap`
  apart and centred on y = 0; outer outlines (even depth) are holes and pieces, odd ones the pieces' middles; hole = outline
  offset `play` − kerf/2, piece + kerf/2, middles − kerf/2; every loop an `outlineSketch` (fully defined); one New extrude per
  letter (an i is two parts, `<id>~2`), board and backing (moved −t) New; holes ≥ `MIN_BRIDGE` apart), key rack (`keyRack.ts`:
  board on Top flipped with slots, screw holes and Text, `pickAreas` body/letters, words engraved by a plain Remove before the
  hooks are made; L hooks drawn on Right (y, z) with a tab down into the slot, moved/copied along x; `edgeRoom` keeps screw
  holes, slots and hooks ≥ `EDGE_ROOM` (3) inside the rounded board, `insideRounded`). Tests: tests/libraryLaser4
  (pure), engineLibraryLaser4 (tabs fill slots with no overlap at kerf 0 and hold when pushed; hinge box bottom + wall tile the
  outline, the strip with its cuts as 0.2 mm slots is one piece; lantern walls' Export for laser loops have no islands
  (`depths`) and each wall is one mesh piece; every puzzle letter free when nudged 0.8 × play and hitting the board past it;
  key rack hooks in their slots; a user's block untouched), mcpLibraryLaser (a name puzzle inserted and exported); the smoke test
  inserts a dice tower and saves every part for laser (7 red, 20 blue).
  Fifth laser batch (list in `designs/laserSet5.ts`; no variables — the outlines are worked out from the sizes). Shared pure
  helper `boxPanels.ts`: a finger box (fingers.ts) as separate panels, each its own sketch (`plateSketch`: outline + circles,
  polygons or slots `PlateHole`, all dimensioned) + New extrude + Move, standing `upright`, `upsideDown` (z → H − z) or
  `onBack` (finger-box (x, y, z) → (x, H − z, y): bottom = back, front/back = floor/top, open top = the front) — `panelPlace`;
  holes in panel coordinates (`holes`) or the sketch's (`sketchHoles`), drawn kerf smaller (`drawnHole`); `panelAreas`,
  `panelsFit`; `lines` = open lines per panel (dimensioned, scored). Designs: bird box (`birdBox.ts`, Garden; RSPB Wildlife
  Explorers / BTO, cited there: holes 25/28/32 mm `BIRD_HOLES`, the hole's bottom ≥ `MIN_HOLE_HEIGHT` 125 above the floor's
  top (z = t) and floor ≥ `MIN_FLOOR` 100 as input limits, default 150 (BTO "15 cm across"), drainage holes, lid not nailed,
  the inside of the front rough: `climbLines` score lines `CLIMB` 8 mm apart in the Front sketch (laser setting
  `open: "score"` for "front-sketch" — a part's Export for laser has only its outline, so the description says to save the
  Front sketch; scored side inward). Walls: both advise 15 mm timber, so sheet ≥ `MIN_SHEET` 6 mm and the wording says it's a
  compromise — out of full sun, facing north to east; don't call it "sized as the RSPB advises". Open finger box + entrance
  in the front, 2 screw holes in the back, 4 drains in the floor; lift-off roof overhanging the front + under-plate
  `LID_ROOM` inside the walls, glued to it), earring stand (`earringStand.ts`: two plates
  halving-slotted from the top / bottom, t wide to h/2, crossing at the origin; hole grid both sides of the slot, holes the
  chamfered top corners come near dropped), box with drawers (`drawerBox.ts`: case = finger box `onBack` W × (D = case
  height) × (H = case depth); N drawers of s − c in spaces s = (H − 2t − (N − 1)t)/N, shelves between with tabs through slots in
  the sides (`sideSlots` via `sketchHoles`); drawers open finger boxes c clear each side, above and behind, fronts flush, a
  `PULL` slot), honeycomb desk pot (`penHolder.ts`, Desk, id `pen-holder`: open finger box with patterns.ts holes on 4 walls +
  loose halving-joint cross dividers `DIVIDER_ROOM` short; named so "pen" still finds the printed desk organiser first),
  sunburst mirror (`sunburstMirror.ts`: rays polygon (long/short `SHORT_RAY`, tip ≥ `MIN_TIP` 15°) + window, ceil(mirror
  thickness / t) rings (hole mirror + 2 × `MIRROR_ROOM`), back disc; true circles; a keyhole in the back (`keyholeOutline`,
  `HANG`: head, shank slot, travel) over a pocket slot through every ring (`pocketSlot`), centred in the ring band; band ≥ ~25),
  tablet/book stand (`bookStand.ts`, Desk: card stand maths with a lean input and the base run back under the rest's top),
  coaster holder (`coasterHolder.ts`: sidePanels with the end plates as the "sides" (notched), base + two walls `WALL_SHARE`
  0.4 of the coaster's height, `HEX_WALL_SHARE` 0.5 for six-sided ones (widest halfway up); defaults = the Coasters design's),
  tissue box cover (`tissueBox.ts`: finger box `upsideDown`, slot in the top along the longer side).
  Tests: tests/libraryLaser5 (pure), engineLibraryLaser5 (volumes = panels less holes at kerf 0, no overlaps; with a kerf
  allowance every pair of pieces that meets overlaps; the bird hole's size/height by probe boxes; the roof comes off only
  once lifted past its under-plate; the Front sketch's score lines; laser layers; a user's part untouched) and
  engineLibraryLaser5b (its own file for OCCT memory: drawers slide out and hit past c every other way, shelves held, tissue
  box/mirror/square coasters fit their holders with room, tabs hold), mcpLibraryLaser (a bird box inserted and exported);
  the smoke test inserts a bird box and saves it for laser (7 red, 7 blue). JuraCUT has twins of all eight (its v0.10,
  `src/library/laserSet5.ts`).
- Island puzzle (`LIBRARY_TOOLS` "island" → `mountainState.kind` "island" → `src/app/IslandPuzzleDialog.tsx`, which reuses
  `Mountain3D`): pure `src/terrain/islandPuzzle.ts` — land (> `sea` m) on a fine grid (`cell` 0.25–0.6 mm), kept by
  `land` ("islands" drops land touching the area's edge, "biggest", "all"); cells owned by the areas between boundary lines
  (`IslandCuts`: lines rasterised as walls, 4-connected fill, specks < 4 mm² spread from neighbours; used only if they
  make more areas than there are bits of land, names from label points) or by seeded jittered Voronoi points `piece` mm
  apart; pieces = 4-connected stretches, ones under `smallestPiece` join the neighbour they share most border with;
  a dovetail painted across each border ≥ 1.6 × head long (checked to lie in the other piece with a margin, which must
  stay one piece); each piece meshed from its signed distance (`distanceTransform`, inside less ½√2 cell) by marching
  squares: squares `S` cells across (~0.7 mm) where wholly inside, single cells where the outline passes (interpolating
  across coarser squares cut past it at tab corners and neighbours touched) — the gap is then ≥ 2·fit + ~0.06 mm, measured
  segment to segment on the meshes' undersides; a coarse square beside fine ones fans from its middle round their side
  points. Ground on top (base + h × relief/high), flat at 0, walls. Pieces are `PuzzlePiece`s (layer 0, bbox outline) so
  `platesFor`/`plate3mf` work. `src/terrain/islands.ts`:
  `ISLANDS` (boxes by lat/lon middle; Great Britain = sw (0, 0), 665 × 1230 km — Ireland and France touch its edges),
  From a map file and trimmed (pure `src/terrain/islandArea.ts`): source "An OpenStreetMap file" → `osmIslandArea` (osmArea's box,
  `osmArea(data, puzzle)` names the puzzle when outside GB; ≤ `ISLAND_MOST`) — the loaded `Area.osm` keeps the file, which is then
  the marks map (no Overpass fetch; `fileMap` beats `marksMap`) and the boundaries map if it has any; land still from heights.
  The Mountain's `TrimSliders` (exported) on every source → `trimmedIsland(area, grid, trim)` (cropGrid; NO_TRIM = the same grid
  and corner, byte-identical) is what the worker builds, so landBox/in-place see only what's left — but WHICH land ("every
  island", a list island's `only`) is decided on the whole area first (`LandRule`; keepLand on the height samples, land left out
  lowered to 0, `decided` → built with land "all" and no `only`, keepLand's words in `notes`), so a trim through the island never
  drops it as "mainland" nor cuts it free of its own cut edge; a new area resets the trims; `AreaView` draws the
  whole area with the trims dimmed. Boundary/marks fetches ask for the trimmed area and keep `covers`; a later bigger area
  (`areaInside` fails) asks to fetch again. tests/islandArea.
  One island only: `IslandPlace.only` (`IslandOnly`: `keep` / `apart` OS grid points, from lat/lon in `around`) → the dialog's
  `spec.only` (the Land choice is hidden then) → `keepOnly` (from keepLand, in landBox and buildIsland; `onlyCells` puts the
  points on each grid): land holding a keep point (nearest within `KEEP_REACH`) is kept, everything else dropped, whatever
  `land` says; a keep mass also holding an apart point or land on the area's edge is first parted at its narrowest neck — land
  shaved 1, 2… cells (distance transform) until the two sides' cores separate (≤ `WIDEST_NECK`), then both grow back, the other
  side's share made sea (thick land of neither side's core handed over — past `MOST_HANDED` 2 km² or `MOST_HANDED_SHARE` 3% — gets its own
  warning; no keep point found = the hidden Land choice, said). Skye: the tiles (zoom 10, ~80 m) join it to the mainland at Kyle Akin / Kylerhea, so with "every
  island" both went (touching the edge) and "biggest" gave both. Ailsa Craig (3 × 3 km box), Islay (no Jura), Jura (no Islay,
  Scarba, Knapdale), Skye (no mainland, Raasay or Small Isles). Arran (no Holy Isle or Pladda: the tiles can join
  Holy Isle across the Lamlash sounds, closing Lamlash Bay, whose shallows read just above 0 m, so it was filled as land).
  Apart points on sea look only `APART_REACH` 600 m (never snapping onto the island). Parting by shape failing, `keepOnly`
  (given heights) tries again counting ground ≤ each of `LOW_JOINS` 2/5/10/20 m as shore (a bay read as low land; said in a
  warning, as part of the bay may stay land); a parting that would give away a keep point's land is never used. Put
  together, land met only on the sides cut inside the area that can't be parted is kept quietly (`OnlyCells.edges`/`Sides`). tests/islandPlaces.
  `boundaryQuery` (Overpass: one admin_level's relations in the box, recursed; fetched by POST from the dialog — CORS),
  `BOUNDARY_LEVELS`. osm.ts reads `boundaries`/`regionNames` (`boundaryLevels`, `boundariesOnGrid`, `levelName`).
  elevation.ts: `zoomFor` (finest zoom with ≤ MAX_TILES), `areaProblem(…, most, z)`, `readHeights(…, spacing, z)`.
  Joins (`joinPieces`): each dovetail is a `tabShape` — a short stem, then an elliptical knob ≥ `LEAST_UNDERCUT` 1.2 mm
  wider than the neck each side, its shoulders facing back (the old 16° flare let small tabs slide out, and gave 0.7–0.9 mm
  of pull-out play); one per border, the biggest that fits from neck 0.26 × piece down to `LEAST_NECK` 3.5 mm (×0.8 steps),
  kept only if it `locks` (its cells pulled back by 2·fit + 2 cells + 0.3, wiggled ± the gap, hit the other piece); a second
  on the only border of a piece with one neighbour. Every piece with a neighbour needs `MIN_JOINTS` 2: one with fewer joins
  the neighbour it shares most border with and the joins are made again (≤ 8 passes); pieces with no neighbour are `loose`
  (said in the summary). `IslandPiece.joints`/`neighbours`, `IslandPuzzle.tabs` (`IslandTab`: piece indexes, where, which
  way, neck, reach — tests pull each out). Default fit 0.1. Small-piece merging skips a pair that would join each other (it
  used to recurse for ever). Map marks: `makeIslandPuzzle(…, cuts, features)` → `featuresForIsland` (drops lines
  < 3 mm, lochs < 4 mm², buildings < ½ `BUILDING_LEAST` on the puzzle) → the Mountain's `groundMarks` (unchanged) over the
  plain top; lowering fades to nothing over the dovetails' necks (`neckFade`: the stem + `NECK_ROOM` 0.5, then
  `MARK_FADE` 1 mm — a fixed size; one field for all pieces so marks line up across joins) and never below `LEAST_BASE` 1.5;
  only land is meshed, so rivers stop at the coast. `pieceMesh(…, plain)`: wholly-inside squares where the top differs
  from the plain ground get their top cell by cell (their underside stays one square). `IslandPuzzle.marks` (lines clipped
  to the land, for the top view, drawn source-atop) and `groundAt`. With no features everything is byte for byte the plain
  puzzle. Fetched with `marksQuery` (Overpass, one POST on a click: paths/tracks, rivers/streams, lochs; main roads for
  "all"; no buildings — map file only; areas ≤ `MARKS_MOST` 130 km, else a map file); the dialog's `overpassMap` turns a
  200 with a <remark> (timeout, out of memory) and 400s into plain words, and answers for an area no longer loaded are
  ignored. The dialog builds in `src/app/islandPuzzle.worker.ts` (`IslandBuilder`: a new build terminates one still
  running, as do settings becoming invalid; a worker that never answers is stopped after `BUILD_LIMIT_MS` 2 min; `IslandBuilt` = the
  puzzle without `groundAt`). The plates' .zip and .3mf are stored, not compressed (`zipStored` has no deflate).
  Printed put together (`IslandSpec.inPlace`, "Print it put together (in place)"; missing = laid out, byte for byte as before):
  `makeIslandPuzzle` crops the area to the kept land (`landBox`: `keepLand` on a ~1500-a-side grid; + 1% and a cell of sea
  only where the land doesn't reach the area's edge — never past the area) and sizes it for the biggest rectangle CENTRED on
  the bed clear of `IslandSpec.keepOut` (`centredRooms`/`bestRoom`/`roomScale` in puzzle3mf.ts, less `BED_MARGIN`; scale ≤
  100%, `islandChecks`) — centred because Bambu Studio re-centres a non-project 3MF on opening (Plater load_files
  `center_instances_around_point(bed_center)`; we write no project_settings.config). `IslandPuzzle.origin` = the grid point
  at (0, 0) (the map is placed from it), `.room` the room used. `platesInPlace(pieces, bed, room)`: one plate, the puzzle
  centred on the bed, `fits` within the room. Keep-outs (the dialog): `Printer.bedExclude` (Bambu's `bed_exclude_area`:
  X1/P1 0×0–18×28; A1, H2D, X2D, H3C none) and, on the H2D, `oneNozzleOnly` strips of its `slicerBed` (Bambu's 350 × 320
  printable_area, nozzles 0–325 / 25–350; in-place is sized and placed on `slicerBed`, as Bambu centres there; PRINTERS'
  325 size is left alone). The X2D (256 = Bambu's) needs nothing: the owner prints colour through the AMS on one nozzle.
  In colour, `IslandSpec.tower`: after centring, `towerSpot` (1 mm raster of the pieces' undersides + keep-outs, summed
  table) finds a `TOWER_SIDE` 35 + `TOWER_CLEAR` 5 square nearest Bambu's back-left default (x 15, y bed − 36) →
  `IslandPuzzle.tower.at` (the window says where to drag the tower); none = rebuilt for rooms clear of `towerCorner` too
  (`TOWER_ROOM` 55, `tower.shrunk`); the window then offers "I'll turn the prime tower off" (state `towerOff` → `tower`
  false, full size). Tower x/y can't be typed in Bambu Studio, so the window says where in words (`towerWhere`: "at the back
  left" = its usual place). `IN_PLACE_FIT` 0.1 (the usual): the narrowest mesh gap is then ~0.3 mm (0.4 at 0.15).
  3MF objects get `IN_PLACE_SETTINGS` (BambuStudio PrintObjectConfig keys, read per object from model_settings.config even
  for a non-Bambu 3MF: `brim_type` no_brim, `elefant_foot_compensation` 0.15 = BBL's 0.20 mm profiles) via the optional
  `settings` of plateFiles/plate3mf/allPlatesZip/bandPlateFiles/bandPlateFile (none = unchanged bytes); no negative parts —
  the mesh's gap is already "don't print here". Full-colour files carry no settings (said in the window). Laid-out plates
  still ignore `bedExclude`. tests/islandInPlace.
  Holes (the owner's Arran print): after `keepLand`, `fillEnclosed` finds every non-land patch the land closes round (only
  non-land reachable from the area's edge, diagonal steps too, is open sea) and fills those that can't be the sea: lowest
  height > 0 (the tiles code the sea as ≤ 0: low land, a gap held above 0), ≤ `SMALL_HOLE` 100 mm² on the puzzle, or under a
  loch of the map (`inRing` samples); bigger sea-level ones stay sea (a sea loch with a narrow mouth). Notes say how many were
  filled and kept. `smoothFill` gives filled ones ground: SOR "soap film" from the land round them, over the patch and land
  within the data's spacing of it (the tiles' interpolation slopes into a gap), never lowered, ≥ the lowest shore; `groundAt`
  reads it bilinearly (`filledGround`) — no patches = the old function. Map water there is pressed and painted as any loch.
  `giveAwayCrumbs` (after the dovetails; `touching` counted again if it moved anything): per piece, pieceMesh's own samples
  (`meshParts`: side by side, or across a saddle with mean > 0 — exactly the mesh's outlines) — a separate inside part of at
  most `CRUMB_MOST` 3 mm² and the cells nearer it than the body goes whole to the neighbour thickest beside it; a hole in the
  outline (`outsideFromEdge`) holding only thin cells of other pieces (`thinAt`) is given to the piece. A tab's own knob and
  stem are never touched; every tab must still catch (`tabHolds` = joinPieces' `locks`), else it's undone with the room round
  the broken tabs left alone and tried again. A bigger part joined only by a strip too thin to print (a low, narrow neck of
  coast) is first widened: sea cells within `narrowest` of both it and the body become the piece's land (at base height).
  Dovetails: `joinPieces` refuses a tab that adds a separate outline to either piece (`meshPartCount` before/after
  painting): a knob joined through a strip too thin to print fell out of the owner's Arran print, leaving keyholes. Islands with no holes or crumbs are byte-identical (18 settings checked against
  the old code: 14 the same; the 4 that changed each had a crumb or a slot through a piece in the old mesh). tests/islandHoles (meshes pinned to the old code's hashes;
  15 mm pieces, pattern 1: every tab catches; a low ragged coast over sizes/patterns: every piece one shell, every tab catches).
  Coastline (the owner's Jura report; v0.106.1's Arran was the same): the tiles read narrow sea passages and loch mouths as
  low land, so sea lochs were closed off and filled. Pure `src/terrain/coastline.ts`: OSM `natural=coastline` ways (land on
  the LEFT; osm.ts keeps them as `OsmData.coastline`) → `joinCoast` (end to start) → `coastRings` (closed chains inside the
  box as they are; the rest cut to the box, `clipChain`, each carried on ANTICLOCKWISE round the box's edge from where it
  leaves to the next one coming in; a point exactly on the edge ends a stretch, stretches lying wholly on the edge are
  dropped, one back in where it left closes there only when anticlockwise; a chain ending inside the box = a gap → null) → `coastMask` (scanline winding > 0;
  null when no coastline lies in the box) → `coastAgrees` (≤ 10% of cells > 20 m called sea, not counting cells within `SHORE_BLUR` 150 m of the coastline — tiles blur sheer cliffs out to sea, and a small steep island like Ailsa Craig failed on its shore alone; all high cells that near: ≤ half). `landByCoast` (islandPuzzle.ts)
  = the mask less land a trim left out (heights < `LEFT_OUT_BELOW`; trimmedIsland lowers it to `LEFT_OUT` when `rule.coast`).
  makeIslandPuzzle/buildIsland/landBox take `coast?: Coast` (OS grid m): isLand = landByCoast, ground ≥ `spec.sea`,
  fillEnclosed fills only specks ≤ `COAST_SPECK` 4 mm² (pinholes; else enclosed = real sea or land left out); unusable = `COAST_UNUSED` warning + the height rule;
  none given = byte for byte as before. `IslandPuzzle.coastline` when used. Dialog: `coastQuery` (Overpass, area + 2 km,
  ≤ `COAST_MOST` 130 km) fetched automatically once heights load (module `coastCache` by area; a map-file area uses the
  file's coastline), the build waits for it (≤ `COAST_WAIT_MS` 60 s, then the heights); a line under the area view says "Coastline from OpenStreetMap…" / failed /
  none. Judged ONCE on the whole area loaded: `coastFits(grid, sw, w, h, coast)` (~1000 cells a side; landByCoast's `trusted`
  skips coastAgrees after that) → makeIslandPuzzle's `coastOk` (missing = judged on its own area), trimmedIsland's
  `rule.coastOk`, the worker's `coastOk` — put together (cut down to the island) re-judged on its own box used to fail
  (the island's blurred shore alone > 10%) and went back to the heights' shape. Fetches go through pure
  `src/terrain/overpass.ts` `askOverpass` (OVERPASS_SERVERS overpass-api.de then overpass.kumi.systems, OVERPASS_TRIES
  de → kumi after 1 s → de after 3 s, `tryLimit` per try but the last, the caller's signal for the whole; busy/unreachable/timed-out
  answers tried again, 400 and out of memory not) — coast (35 s a try, 60 s in all), boundaries and marks (40/90 s);
  failures are never cached and the note offers "Try again" (`coastTry`); the note says COAST_UNUSED when the puzzle
  didn't use it. Tests: tests/overpass. Lochs inland aren't coastline (land, at their heights). Tests: tests/coastline (pure + a Jura-like loch, a pool filled, a height gap), coastlineReal (wiggly coasts crossing
  the box's sides/corners exactly, ways shuffled, doubled points, islands touching the edge, every cell vs the true land).
  Plugs and pinholes (v0.75): a hole in a piece's outline is given to it whole — thin cells of others, a bit of another
  piece cut off from its body (`mainBody`), sea that isn't kept (`FilledHoles.keptCells`), a pinhole — unless it's kept
  sea, holds another piece's body (an islet piece) or a live tab's knob. A dovetail whose knob is no longer in its piece's
  main body (`knobCutOff`: a loose plug in the socket) is dropped first (note "… too thin at the neck to hold"; joints/joins
  recounted) so its knob goes to the piece round it. A move that would leave any piece in more bits than before is undone
  and those cells left alone (`changedPieces`, `meshPartCount`). tests/islandOneSolid (heavy, own file): the reviewer's very
  flat coast (25 mm, pattern 1: the plug) and low ragged one (25 mm, pattern 2: pinholes), and lumpy/ragged/low × 15/25/35/60
  mm × patterns 1–3, every piece one outer loop and no hole, every tab catching; those 36 builds are byte-identical to v0.74.
  Tests: tests/islandPuzzle (pure; over seeds/sizes on a ragged coast: ≥ 2 joints per piece, outlines from the meshes never
  cross or come within 2·fit, every tab catches when pulled, median play ≤ 0.5 mm — `tests/support/outlineGeom.ts`), tests/islandMarks.
- Map puzzles tab (the owner's wish): the Mountain, Photo relief and Island puzzle cards (`LIBRARY_TOOLS`, `section: "maps"`) are a
  third library tab after Laser cutting and 3D printing (`src/library/sections.ts` `LIBRARY_SECTIONS`/`LibrarySection`, `sectionFrom`,
  `sectionLocked`; designs keep `DesignCategory`), behind a LIGHT lock (the code is public — it only stops casual visitors):
  `src/library/puzzleLock.ts` compares SHA-256 hex of `PUZZLE_SALT` + what's typed (trimmed too) with `PUZZLE_HASH` — never write the
  password anywhere; tests use their own via `passwordHash(typed, expected)`. The hash is kept in localStorage
  `juracad.puzzlesUnlocked` and counts only while it equals `PUZZLE_HASH` (a new password relocks everyone). App side
  `src/app/puzzleLockState.ts` (`usePuzzleLock`, re-read each time the library opens, `syncPuzzleLock`; unlocked for the tab even
  without storage); locked, the tab shows `UnlockBox` and the search hides them (`shownTools(unlocked)`); `openMountain` opens nothing
  while locked. The maze box and burr stay under 3D printing › Puzzles. The smoke test unlocks by setting the kept hash.
- Mountain puzzle printed put together (`src/terrain/mountainInPlace.ts`, pure; tests/mountainInPlace): the window's
  "How it's printed" (`PrintWay` apart | layers | together; session only). "layers" = `layerPlates` (a plate per layer, the
  whole puzzle centred so every layer sits in the same place, each piece standing on the bed); "together" = `stackWithBreakaway`
  — each layer lifted (`liftsFor`) so its underside is on a print layer boundary (`FIRST_LAYER` 0.2 + k × the chosen layer
  height, `boundaryAtOrAbove`) one to two print layers above the layer below; one "Breakaway layer L" piece per joint (Body part
  "breakaway": each piece's outline less its pocket's mouth across the gap, plus a cap from the key's top to the pocket's ceiling,
  `capLoop` = the smaller of the two less `CAP_CLEAR`) — then `togetherPlate` (heights kept). plateFiles/plate3mf/allPlatesZip take
  `filaments` (`Filaments`; FILAMENT.breakaway 3 unless chosen; the object's extruder is its first part's). Put together the layout
  is fitted to a centred room of the slicer's bed (keepOut: no-print corner, one-nozzle strips, and the prime tower's corner when
  several filaments unless "I'll turn the prime tower off") and gets IN_PLACE_SETTINGS; scale ≤ 100%. Colour modes can't use
  "together" (they print layers).
- Mountain puzzle (a card in the Design library's Map puzzles tab — `src/library/tools.ts` `LIBRARY_TOOLS`:
  cards that open their own window instead of inserting features, found by the search via `searchTools`/`searchWords`;
  LibraryDialog's `ToolCards` — then `src/app/MountainPuzzleDialog.tsx`; `mountainState.kind` "photo" = the Photo relief
  puzzle, the same window and puzzle with a picture for heights: `src/terrain/photoRelief.ts` (pure: `greyFromRgba`,
  `blurred`, `photoGrid` — one unit per pixel, top row north, heights scaled so the relief is `reliefMm` at the spec's `k`
  from `layoutFor`, stretch 1; ≤ `PHOTO_MAX_SIDE` 400 px; no snow; tests/photoRelief); open state in `mountainState.ts`, session only,
  never in the document): a real mountain as a 3D printed puzzle of interlocking cubes. Pure in `src/terrain/`: `osGrid.ts`
  (OS grid refs ↔ E/N, `gridToLatLon` = OS transverse Mercator inverse on Airy 1830 + Helmert to WGS84, ~5 m), `elevation.ts`
  (AWS open "Terrain Tiles", terrarium PNGs — `terrariumHeight`, Web Mercator `worldPixel`, zoom `TILE_ZOOM` 12 ≈ 20 m/px,
  ≤ `MAX_TILES`; `readHeights(loader, sw, w, h)` → `HeightGrid` square to the OS grid, sea clamped to 0; the browser loader is
  `src/app/mountainTiles.ts` — `createImageBitmap` with colorSpaceConversion/premultiplyAlpha "none", as the colours ARE the
  heights), `peaks.ts` (well-known summits), `triangulate.ts` (outline + holes → triangles using exactly the given corners,
  holes joined earcut-style with a "cut leaves into the face" check on doubled corners — the second peg hole once joined
  through the wrong copy), `mountainPuzzle.ts`, `puzzle3mf.ts`. Puzzle: `layoutFor` — 100% scale = the finished puzzle fills the bed
  less 10 mm, whole cubes, area trimmed and centred; heights z = `baseFor` (≥ one cube + the thinnest top, so every column
  stands on a jigsaw cube) + (h − low)·k·exaggeration. `base` (default 10) is the plain side under the lowest ground (the
  owner wanted ≤ 10 mm of it): layer 0 is a thin jigsaw plate `plateFor` = base − thinnest top − 1.5 mm headroom (≥ `PLATE_MIN`
  3), layers above are whole cubes (`bottomOf(L)`); `baseFor` raises base to fit them. Per column, `full` = the plate plus
  the whole cubes under the top piece (always ≥ 1; top ≥ socket depth + 2 mm thick everywhere). Each join is a chunky rounded dovetail (`dovetail`, `DoveShape`): one of `DOVE_SHAPES` — sign × head
  `DOVE_HEADS` (0.38/0.46 of the side) × depth `DOVE_DEPTHS` (0.15/0.21) × offset `DOVE_OFFSETS` (±0.04, only for the
  narrow head) = 16; neck = head − 2·`DOVE_LOCK`; every head starts ≥ `DOVE_CLEAR` (0.27) from a corner, deeper than any tab
  reaches, so neighbouring sides' tabs never meet. `layerJoins` picks them (seeded); `uniqueBlocks` re-picks until no two
  tabbed pieces of the same height have the same four `sideCode`s in any turn (the owner wants each piece to fit only its
  own place) — only pieces with < 2 tabs can stay alike (16 shapes), counted in a warning; their keys differ. They replaced
  library/puzzle.ts's round tabs (necks 3.4 mm on 30 mm cubes, snapping on the plate); `MIN_NECK` 3, `GOOD_NECK` 5) with tabs between two whole cubes, and between two top pieces that start at the same level (`besideTop`; the top layer's joins `topLayerJoins` have their own seed so lower layers are unchanged), else straight; a top piece with none is a square as before (`topBodies`), one with tabs is meshed by `outlineTopBodies` (walls and underside on the exact shrunk outline — its corners plus every crossing with a line of the sampling grid, set off from round numbers — as `blockBody`'s footprint is exact, so the gap is exactly 2·fit; on top, squares wholly inside as squares, and each square the outline passes through clipped against it — the outline's runs in that square joined round the square's edge past its corners — and triangulated on its own, so no top triangle is bigger than a square; an ear-clipped band once left 28 mm slivers up to 17 mm off the ground; every triangle cut at the snow line); outlines shrunk by `fit`. `PuzzlePiece.joints`/`neighbours` = dovetails to pieces beside it at its level (every such side has one); pieces above the plate with fewer than two (a peak, a hollow, a steep face: no more are possible — a dovetail can't go only part way up a taller cube) are counted in a warning. Tabbed top outlines leave keys a little less room, so `codeKeys`' one key size can come out a step smaller than before. One locating key
  per join (it replaced two thin pegs, which were fiddly and could snap): a rounded-square pad on each cube's top
  (`keySizes`: h 2–3.5 mm, sides sloping in 0.8·h, `keyLoop`), a matching pocket under the piece above (fit bigger all round,
  h + 0.4 deep, the same slope); `keyPlace` sizes it straight from the "square" (L∞) room to both outlines less `WALL`
  (+ fit for the pocket), up to `most` (0.22·cube ≤ 9), in the middle or nudged towards a corner with more room; it's the same
  `Key` object on the piece below (`key`) and above (`pocket`). Then `codeKeys` gives every key a code (`KEY_CODES`: moved
  −1/0/+1 × `CODE_STEP` (1 mm) each way × which corner is cut off, `CUT` of the half-width — 36) and ONE size for the
  whole puzzle (the 5th-percentile room less a step; a smaller key would drop into a bigger pocket), checking with
  `keyGoesIn` (the key moved into the other cube, `insideGap` > 0 with the other's pocket) both ways against every coded
  key in the 3 × 3 × 3 round it, so a piece fits only its own place; unavoidable pairs are counted in a warning (only
  below the sturdy cube size). Pocket ceilings use `pd − z0`, the walls' own sum, or float rounding split the weld. Snow: blocks are cut by the plane (moved to a whole piece near sockets/the top), top
  pieces' ground triangles are clipped at the snow line with crossings shared by key (`topBodies`), so rock and snow are
  each closed; snow is a zero-thickness edge along the contour. Limits: `mountainChecks` refuses necks < `MIN_NECK` 2 mm
  (`smallestCube`), warns < `GOOD_NECK` 3 mm, ≤ `MAX_COLUMNS` per layer, ≤ 40 layers. Plates: `platesFor`
  (rows on the bed, layer by layer), `plate3mf` = core 3MF, each piece an object of component parts (rock, snow) + Bambu's
  `Metadata/model_settings.config` with `extruder` 1/2 per part (untested in Bambu Studio itself; other slicers see parts to
  assign by hand). Tests: tests/mountainPuzzle (pure: grid refs vs known summits, a fake tile loader, triangulation, every
  part watertight with positive volume, gaps, keys ↔ pockets, snow above the line, limits, plates; every piece's dovetails
  found on its outline for several patterns, top pieces' printed footprints never cross and stay ≥ 2·fit apart, segment to segment, at fit 0.1 and 0.15 on rugged ground — `tests/support/outlineGeom.ts`; the warning's count; every upward triangle of a dovetailed top within 0.2 mm of the ground). A laser version (layered contour
  sheets) was tried in JuraCUT and taken out at the owner's request (JuraCUT v0.12): the mountain puzzle is 3D printing only.
  Trim and border: pure `src/terrain/mountainCrop.ts` — `Trim` {n,e,s,w} shares (≤ `MOST_TRIM` 0.45, ≥ `LEAST_LEFT` 0.1 left
  each way), `cropGrid` (whole grid steps, the same heights, e0/n0 moved; NO_TRIM = the same grid object, so files are
  unchanged), `cropPixels` for the photo puzzle (cropped before `photoGrid`, then e0/n0 = pixels off west/south); the dialog's
  "Trim from the north/east/south/west" sliders feed `used` (grid + size) to layoutFor/makeMountainPuzzle; the top view keeps the
  whole area. `src/terrain/mountainBorder.ts` `makeBorder(puzzle, words, bed)`: a frame drawn from the puzzle's edge (t 0) out
  `BORDER_WALL` 10, every piece shrunk by fit (2·fit from the puzzle and at joins); the top follows the land (the owner's wish,
  no steps): `topRing` = one ring of heights every ~`TOP_STEP` 1 mm round the edge from the SW corner (the puzzle's corners
  within fit + 0.5 of each face, binned, + `RISE` 2 — 1 could print flush after layer rounding; the words' span on the front floored to their height), covered ±`ENVELOPE`
  0.75 cube, averaged ±`SMOOTH` 0.5 cube (never below the land), lifted to ≤ `MAX_SLOPE` 0.5; `topAt(x, y)` reads it (corner
  squares = the corner's value), so every piece, lug and corner shares one function and joins match exactly; pieces are
  `columns` meshes (rectilinear outline gridded by its corners + every step, a column per square — watertight); `heights`/`lows`
  per side for the summary; words centred half way up the lowest top over them. L corners (`CORNER_ARM` 20) and straight pieces ≤ the
  bed (`most`), joined by full-height lugs (neck `LUG_NECK` 3.6 × 2 long, head `LUG_HEAD` 5.6 to `LUG_DEPTH` 5, shoulders
  square to the pull — a shallow dovetail slid 1.5 mm); `BorderJoint` lower/upper/dir. Words (`borderWords`: name, m, 6-figure
  ref, 1:scale; the dialog uses the famous summit only while it's on the trimmed puzzle, else its highest point) raised `RELIEF`
  0.8 off the front's outside face, centred on one name-plate piece (the whole front middle if that fits the bed, else what's
  left beside it is shared both sides or put on one, never under `MIN_PIECE`; any straight span < lug + 2·fit + `PIECE_MARGIN`
  is a plain problem) (caps `NAME_CAPS` 7 / `INFO_CAPS` 4.5 shrunk to fit, refused under `MIN_CAPS` 3; the front raised to hold them),
  `BorderPiece.words` (a Body) → filament 2 via `bandPlate3mf` (`borderParts` in the dialog), plates by `platesFor`.
  Tests: tests/mountainBorder.
  OpenStreetMap files: source "An OpenStreetMap file" + "From the map" (`OsmDetail`: area / water — paths, tracks, rivers,
  streams, lochs / all — roads, buildings, names too). `src/terrain/osm.ts` (pure): a small
  regex reader for .osm XML (`readOsm`: bounds, ways by tag — `lineKind`/`shapeKind`, multipolygon water joined from
  member ways, `joinRings`, islands; named peaks (with `ele`), huts, places; `OsmError` = plain message), `osmArea` (the
  grid-aligned box inside the export box; refuses outside GB), `featuresOnGrid` (via osGrid's `latLonToGrid`: Helmert
  the other way + TM forwards, round trip < 1 cm), `featureSummary`. 3D: `src/terrain/groundMarks.ts` — grooves
  (`GROOVES`, cosine profile), water capped at its lowest shore − `WATER_DROP`, buildings + `BUILDING_HEIGHT`
  (≥ `BUILDING_LEAST` across), on a ≥ 0.25 mm grid; `makeMountainPuzzle(…, features)` wraps the ground height with it
  (so `full`, snow and every mesh see it) and samples top pieces finer (≤ 64 a side). Names aren't printed. Tests:
  tests/osm.test.ts (sample file in tests/support/osmSample.ts).
  Tidy marks (both puzzles, the owner's wish; pure `src/terrain/mapMarks.ts`): `MarkChoice` {water standing|all, paths
  hills|all, roads trunk|main|all}, `TIDY_MARKS` (standing, hills, main) the windows' default (`MarkChoices` in
  MountainPuzzleDialog.tsx, shared with the island window, says the rule — `HILL_RULE`), `ALL_MARKS` = the old behaviour and
  `featuresOnGrid`'s default (old callers/tests unchanged). osm.ts keeps per line `highway` (footway=sidewalk/crossing →
  "sidewalk") and `hike` (member of a route=hiking/foot/walking relation, or sac_scale), per water shape `flowing`
  (riverbank, water=river/canal…), `builtUp` = towns (residential/commercial/retail/industrial) and `parks` (parks, gardens,
  golf…) outer rings. `featuresOnGrid(data, detail, choice, grid)`: standing water drops waterway lines and flowing areas and
  gives lochs `least` = `LEAST_LOCH` 16 mm²; roads trunk = motorway/trunk, main = + primary (`MAIN_ROADS`), no links; hills =
  `hillRoutes`: path/footway/steps/bridleway/track (`NOT_HILL` pavements, cycleways…), pieces ≥ half in a town dropped (towns
  beat everything), joined through shared points straightest pair first, ≤ 90° turn (`joinRoutes`, steps join routes);
  a route is kept if `hike`, else (needs `grid`): mostly in parks → climb ≥ `HILL_CLIMB` 150 m; tracks only → ≥ `TRACK_CLIMB`
  300 m and not mostly in woods; else ≥ 150 m or ≥ `HIGH_CLIMB` 50 m into the top `HIGH_GROUND` 30% of the grid's range;
  `least` = `LEAST_ROUTE` 10 mm. Tidy lines carry `thin` (MapFeatures, PuzzleMap, IslandMarks): `THIN_GROOVE` 0.6 wide ×
  0.4 deep; "all" lines keep the old `GROOVES` widths and top-view look (`markStroke(kind, thin)`); `grooveOf` gives either.
  Smooth, even paths and roads (the owner: "solid, continuous, the same width and height"): pure `src/terrain/smoothLines.ts`
  `smoothedFeatures(f, k)` (cached per features + scale; nothing to smooth = same object), applied once inside
  `featuresAtScale`/`featuresForIsland`, so grooves, paint, previews, top views, swaps and path picking all use one line —
  path/track/road lines only (rivers, streams, shapes untouched), in puzzle mm: Douglas–Peucker at `NOISE` 0.1 (¼ nozzle),
  `unfold` (a point coming back within `FOLD` 2 × groove width of an earlier one ≥ 2 × that further along, ≤ `MOST_FOLD` 12 ×
  width: cut straight across — zigzags, switchbacks; the ridge left between passes is then ≥ a groove width), `roundBends`
  (points bending tighter than `LEAST_RADIUS` 1 × width eased towards their neighbours' middle until none are), `KEEP` 0.01
  thinning; ends exact, ids/name/thin/least kept. Channels: every path/track/road groove (thin or not) is a flat bottom to
  `THIN_FLAT` ⅔ of the half-width + straight walls (`grooveDepth`, `thinDepth`), cut EXACTLY into the pieces
  (`src/terrain/grooveCut.ts`): groundMarks returns `channels` (a `GrooveIndex`: 1 mm buckets of segments and of cut pieces
  — each line's outline at the flat edge and at its edge, sides mitred inside bends, chords `ARC_STEP` 15° round outsides
  and ends) and `base` (the marks without them); meshes are made on `base` (island `meshTop`, mountain `meshZ`; the island's
  cell and the mountain's samples are as with no lines — THIN_CELL, THIN_SAMPLE and thinColumns are gone) and then
  `cutGrooves(body, channels, base, height)`: ground triangles (all corners on `base`, facing up) split into convex cells by
  every cut piece that reaches into a cell (`cutTriangle`, Sutherland–Hodgman halves, crossings worked out the same way from
  either side), new points on triangle edges shared with the neighbours and the walls (`edgeIds`), corners made on a cut
  that stopped at one cell put into the next cell's side, convex fans (from a corner whose sides have no extra points, else
  a middle point); every ground corner in a channel takes `height` (the full ground: water/building marks, channels, island
  fade/LEAST_BASE). Bodies must share corners (the mountain's are welded first). `mapRaster` draws no path/road lines on its
  grid: `kindAt` asks a GrooveIndex of the map's lines (strictly inside the edge; roads over paths over tracks; water on the
  grid still wins), `areaAt` = the grid alone; bandParts paints a line's colour on any face of its channel that isn't
  upright (nz > 1e-6; sliver cells where edges meet can be steep), full colour colours a triangle by its middle when that's
  on a line (all three corners; else corner by corner with `areaAt`). Measured by tests/pathQuality (harness
  `tests/support/lineQuality.ts`: stations every 0.1 mm along the line used, depth, width half-way down, painted width,
  breaks, blobs — island and mountain, bands and full colour), smoothLines (pure + cutGrooves on a block), thinGrooves.
  Review fixes: corners tighter than the radius get a true arc first where it fits (`filletCorners`; a U-turn barely wider
  than two radii kept its legs only this way — easing shrank them), `roundBends` then runs only round what's still tight
  (`roundAll`/`roundTight`, ± `ROUND_REACH` points); a line closing on itself is unfolded only up to half way round (small
  loops stay loops); a smoothed copy cache keeps `MOST_SCALES` 4 per map. cutGrooves: walls (not ground) whose top edge took
  a channel's points are triangulated in their plane together with their coplanar partner (`walls`, triangulate.ts — a fan
  of the triangle alone reached past its diagonal and folded over the partner); ground fans test corners seen from above,
  by distance > `EPS` (`fanConvex(…, plan)` — else xy-collinear points made upright fins, and EPS-merged points flipped
  triangles); cut corners lying within EPS of another cell's side are put into it; bodies/triangles no line's box meets are
  skipped (`GrooveIndex.touches`). Mountain snow parts: a channel stops `SNOW_CLEAR` above the part's floor (`zs`), so the
  snow never folds through it. tests/grooveCutMesh: every edge shared by exactly two triangles and none folded back on
  another, with crossings, a T, a path on a road and over the coast, and on a mountain with a snow line; untouched pieces
  as without the map; switchbacks wider than the fold keep their legs; small loops stay.
  `featuresAtScale(f, k)` (mountain build/preview/colour) and `featuresForIsland` honour `least`. `marksQuery(…, choice)`
  fetches path|footway|bridleway|steps|track, towns/parks (+ woods for hills), natural=water/landuse=reservoir (+ multipolygons),
  waterways only for "all", roads by `ROAD_RANK`, walking route relations bare (`->.hr`); `fetchCovers` says when to fetch
  again. Filament changes go by layers painted lines cross, not their number, so tidy marks cut paint a lot and changes
  less (tests/mapMarksSwaps). Paths and roads may be "none"; `WATER_ONLY` (standing water, no paths, no roads; `waterOnly`) also
  drops buildings, and `marksQuery` then asks only for water (no ways of paths/towns/parks/woods, no walking-route relations);
  `fetchCovers` knows a water-only fetch holds no paths. `MarkChoices` has a "Lochs, lakes and reservoirs only" box (hides the
  three rows). Tests: tests/mapMarks (pure, `hillOsm` in osmSample.ts), thinGrooves, mapMarksSwaps.
  Picking paths off by hand (both windows): osm.ts keeps each line's way `id` and `ref`; MapFeatures lines carry `ids` (a hill
  route's sorted way ids — hillRoutes gathers them from joinRoutes' `pieces`) and `name` (its longest named piece's name, else ref).
  Pure `src/terrain/pickMarks.ts`: a session-only `dropped` set of WAY ids (so a re-fetch of the area, or hills ↔ all paths, keeps
  the choice); a path/track/road line is off when ≥ half its ways are (`isDropped`), `withoutDropped` (none = the same object, so
  output is byte for byte as before), `toggleDropped`, `dropAll`, `keptCount`, `nearestLine`, `lineLabel`. The dialogs keep the
  rules' result as `mapFeatures` and `features = withoutDropped(mapFeatures, dropped)` feeds everything (build/island worker,
  paint, swaps, previews, files); `dropped` resets when the loaded area changes. `src/app/PathPicker.tsx` `PickableView` (the
  canvas + an SVG laid over it, `.path-pick-wrap`, placed with pickMarks' `onView`/`fromView` and `islandViewBox`/`mountainViewBox`
  — the canvases' own mapping, tested against them; dropped lines dashed white on a dark halo, the hovered one yellow, its name and
  length in a line under the view (never over the map); nearest within `REACH_PX` screen px — 20 for a finger; tap/click toggles;
  focusable: arrows step, Enter/Space toggles; then the count bar, "updating the puzzle…" while it's remade). Offered lines =
  `pickableLines`: the island's only those on the land (`landIdsAfter`: way ids its marks show — `IslandMarks.lines[].ids` — kept
  for lines left off when it was made, so one put back stays offered), the mountain's only those within the puzzle's layout, plus
  any left off. The island's canvas skips marks left off since it was made, so it never shows a dropped line while rebuilding.
  No two lines of one rule share a way, so a click flips only what was clicked. Tests: tests/pickMarks.
- Puzzle colours (Island and Mountain puzzle windows' "Colour" choice; `src/app/PuzzleColour.tsx`: `ColourPanel`, `useColoured`,
  `ColourDownloads`; the photo puzzle stays plain): pure `src/terrain/colour.ts` + `colourFiles.ts`. Colouring runs in
  `src/app/puzzleColour.worker.ts` (`ColourRunner`: a new job while one runs restarts the worker; pieces sent only when new) over
  the pure `src/terrain/colourJob.ts` `ColourCache` (keeps the pieces, the map's raster by `mapId`, and the last cut into bands
  keyed by `bandLevels` + layers + water filament — a change of colour or name only repaints the preview; `replyTransfers`). `ColourSpec` = mode "plain" |
  "bands" | "full", 2–8 `ColourBand`s (name, colour, `from` m — the first's ignored; `snow` marks the mountain's top band), `base`
  (the side under the ground in its own colour), `water`, `layer` (0.2). Plain = exactly the old files (`plate3mf` untouched; its
  hash is pinned in tests/puzzleColour). In bands/full the mountain is built with `snowline: null` (the snow band replaces it).
  `HeightScale` (z = z0 + (h − h0)·mmPerM: island base / 0 / relief÷high; mountain `baseFor` / low / k·exaggeration). Defaults (the owner's choice, all PLA Matte): base
  `GROUND_BROWN` Dark Brown, bands Lowland `LOWLAND_GREEN` Dark Green, Upland `UPLAND_GREY` Nardo Gray, Snow `SNOW_IVORY` Ivory
  White (`USUAL_SPOOLS` names its spool, as Jade White shares #ffffff) — `islandBands(high)` (Upland 0.45, Snow 0.75 of the
  highest) and `mountainBands(low, high, snowline)` (Upland 0.3 of the range, Snow from the snow line, `snow: true`). Both
  windows START in colour bands: `usualColour(bands, water)` (+ water — island SEA_BLUE, mountain WATER_BLUE —, red paths,
  black roads: 7 filaments) via `useUsualColour`; `useBandsFollow` keeps the bands following the ground as it loads until
  they're changed by hand (pure `followedBands`: still equal to the last usual set — so "Usual colours and heights", which puts the
  bands and base back, starts the following again; the island's from its last built `high`, the mountain's from `layout`). Bands: `bandLevels` (with a base colour, levels clamped to ≥ z0;
  sorted lowest first, stably) → per piece `snappedCuts` (sorted again; each edge on a layer boundary of the piece AS PRINTED, from its
  own z0: `firstLayer` then every `layer`; edges on the bed dropped; same layer → the later band wins) → `sliceMesh`
  (weld, planes moved ≥ `PLANE_CLEAR` 1e-4 off every corner to the nearest free height, each triangle clipped to each slab with
  crossings keyed by mesh edge + plane so neighbours share them, caps from the reversed plane edges chained into loops, nested by
  area sign, `triangulateFast` — triangulate.ts's algorithm with a grid for the ear test, kept apart so plain meshes never
  change) → `BandPart`s (filament, low/high as printed, `paint`: on a column's `top` piece only (`bandParts(…, top)`; lower pieces' tops are
  hidden — `ColourPiece.top`), triangles not near-vertical (`takesMapPaint`, nz > 0.05: groove walls and steep flanks, never the
  vertical piece/dovetail walls) and not the cap where a part was cut from the band above, whose middle the map raster calls water, a
  footpath/track or a road — the grooves' floors and walls, as `mapRaster` draws lines exactly `GROOVES` wide — get that
  filament with Bambu's `paint_color`, and `paintRanges` (merged height ranges per painted filament) —
  `paintCode`, from BambuStudio's TriangleSelector::serialize / get_triangle_as_string: 1 "4", 2 "8", n ≥ 3 "<n−3 hex>C", 18
  "0FC"). `filaments(spec, has)` numbers distinct colours (base, bands, then water, paths and roads — each only if
  the map has it: `MapHas`, a `MapRaster`'s `water`/`paths`/`roads` or a boolean for all), ≤ `MOST_FILAMENTS` 8. `ColourSpec.paths`
  (`PATH_RED`) and `.roads` (`ROAD_BLACK`) — the owner's wish: red paths, black roads; set when a colour mode is first chosen,
  rows "Footpaths and tracks…" / "Roads…" in the panel, null = off.
  `bandPlate3mf` (puzzle3mf.ts, async: deflated with `src/geometry/zipDeflate.ts`, as Bambu's own 3MFs are) writes a part per band
  with `extruder` in model_settings.config, as rock/snow. Banded plates come from `platesByLevel` (one set of plates per piece
  underside height — mixing the mountain's layers on a plate cost hundreds of filament changes; plain keeps `platesFor`).
  `colourWarnings`: more than `AMS_SLOTS` (4) filaments; no band starting within the ground's range (re-offers "Usual colours and
  heights"). `filamentSwaps`:
  per layer, the filaments in use, starting with the last one used (paint counted on the layers its `paintRanges` span and
  `PAINT_PENETRATION` 3 below — Bambu's "Top paint penetration layers" default 4, PrintConfig.cpp; a path up a hill adds changes on many layers, so the estimate can be large and says so honestly) — a rough
  count shown per plate; `plateSwaps(…, without)` gives it with the paths' and roads' filaments left out, and the window says how far
  switching them off brings it down; over `MANY_SWAPS` (200) on a plate it warns. Labels say "in red" etc. only while the usual
  colour is chosen. (Filament colours aren't written into a project_settings.config: Bambu Studio reads that file as the whole
  project's settings, so a partial one isn't known to be safe.) Full colour: `fullColours` divides triangles at the tint's stops (sliceMesh without caps) and gives every
  corner a colour — `tintAt` (band colours blended between their heights, snow left out), sides × `SIDE_SHADE`, the base colour
  below z0, on upward faces hill shading from the NW (`SHADE`, smooth normals of upward faces), map kinds (`mapRaster` of
  `mapOnPuzzle`: water flat blue unshaded; paths/tracks solid in `spec.paths` (red), roads in `spec.roads` (black), both shaded and never
  snowed on — or, switched off, the old browns/grey mixed in; buildings a dark brick brown, woods dark green mixed in; upward ground
  pressed just below the base's top — by up to `DEEPEST_MARK`, the deepest groove or `WATER_DROP` — stays ground-coloured, not the
  base's; map colours on top pieces only, `fullColours(…, top)`) and snow where above the line and the
  slope's normal z ≥ `SNOW_SLOPE` (min of corner and face normals). Files (`colourFiles.ts`): 3MF with one `m:colorgroup`
  (`palette`, colours rounded to 4) and `pid`/`p1 p2 p3` per triangle (Bambu Studio reads these from non-Bambu 3MFs — bbs_3mf.cpp);
  OBJ + MTL + a palette PNG (each triangle one colour — its corners' mean — on a `SWATCH` square, ≤ `MOST_SWATCHES`; `pngStored`);
  VRML 2.0 with `colorPerVertex` + `colorIndex`; per plate 3MFs or every piece in one file (`allItems`: plates side by side);
  compressed with `zipDeflated` (src/geometry/zipDeflate.ts: CompressionStream "deflate-raw", stored where there's none). `Mountain3D`'s `paint` draws the
  preview (`previewOfBands`/`previewOfFull`, sRGB → linear). osm.ts reads woods (`natural=wood`, `landuse=forest`) into the
  optional `OsmData.woods`/`MapFeatures.woods` — coloured only, never pressed into the ground (missing when there are none, so
  plain features are unchanged). Tests: tests/puzzleColour (pure: layers, parts closed and adding up with shared corners at every
  edge, paint codes, swaps, woods, full colour's sides/snow, 3MF/OBJ/MTL/PNG/WRL counts, the plain writer's hash; levels kept in
  order with a base and a band below the ground; first-layer snapping; plates by level ≤ bands − 1 changes each; warnings; the
  cache not re-cutting for a colour change).
  Bambu colours and 8 slots: `src/terrain/bambuColours.ts` (pure; Bambu Studio's filaments_color_codes.json, PLA Basic, Matte,
  Silk+ single colours: code/line/name/hex; `bambu(line, name)`, `spoolFor(hex, code?)`, `spoolLabel`). Every usual colour is a
  Bambu PLA (SEA_BLUE Matte Marine Blue, WATER_BLUE Basic Cyan, PATH_RED Basic Red, ROAD_BLACK Basic Black, ISLAND_/MOUNTAIN_COLOURS,
  SPARE_COLOURS). `ColourSpec.spools` (hex → code, where two spools share a colour) → `Filament.spool` ("Charcoal (PLA Matte)"),
  shown in the Load list. `src/app/SpoolPick.tsx` (PlacedPopup of named swatches + your own colour) for every band, base, water,
  paths, roads. Filament slots 4/8: `PrinterSetting.amsSlots` (`amsSlotsOf`: missing = 8 on every printer; panel row "Filament
  slots"), `colourWarnings(…, slots)`; the usual bands are always the three above (the old 5/6-band sets and
  `usualBandCount` are gone). Modal ignores Esc while a
  `[data-keeps-escape]` element is up (the spool popup, the enlarged 3D view). `Mountain3D` is taller (clamp 380 px–62vh) with
  "⤢ Enlarge" (fixed, inset 12 px; Esc or the button back); puzzle windows 1280 wide. `fullColours` pushes corners one by one
  (a spread overflowed the stack on big pieces). Tests: tests/puzzleColour8 (8 filaments in the 3MF, paint codes 4C/5C, spools).
- Puzzle designs (`src/library/puzzleDesigns.ts` `PUZZLE_DESIGNS`, group "Puzzles", first in the print tab's GROUP_ORDER;
  LibraryDialog's `GroupedCards` shows the tools first under the same heading). Cylinder maze box (`designs/mazeBox.ts`,
  no variables): `makeMaze` — a perfect maze (seeded backtracker) on `cols` × `rows` cells round HALF the box (repeated, two
  nubs 180° apart), wrapping round; home on the bottom row, exit the furthest top-row cell (`path`); every groove is a
  symmetric partial Revolve of a rectangle on a `fixedPlane` turned to its angle (`turnedPlane`; runs along a row merged,
  a column's ways up merged), the ups `NUDGE` deeper and longer so no two cuts share a face (shared faces made the box
  invalid). Lid printed upside down beside the box; nubs chamfered 45° towards the bed, their footprint at the core
  centred on the groove (`groove` = nub + depth − 2·fit + 0.6). Tests: tests/libraryPuzzles (pure), engineLibraryPuzzles
  (the lid turned over: no overlap along the whole way out, blocked by walls — engine.clashes sometimes returns nothing at
  an exact placement, so walls are probed at ±1.5° too).
  Six-piece burr (`designs/sixPieceBurr.ts` over pure `src/library/burr.ts`, no variables): pieces are unit cubes of 2 × 2 × 8
  sticks crossing in the middle 4³ (`AXIS`, `CROSS`, `fullStick`); the 32 `contested` cubes (8 covered by three sticks) each
  go to one stick or none (`piecesFrom`). `disassembly` = BurrTools-style BFS: any group not holding piece 0 slides ±x/y/z
  as far as it goes; a group free for good splits the set, each part must come apart too; returns the moves before the
  first split (level) or null. It answers exactly as the first version did (`tests/support/burrSlow.ts`, compared in
  libraryBurrSearch), only ~100× faster: how far a group slides depends only on each pair's relative place, so `pairHits`
  works that out once per pair of piece shapes and relative position (cached across searches, `shapeIds`/`pairCache`, k < j
  only; both emptied together at the start of a search past `MOST_HITS` results / `MOST_PAIRS` pairs, so a long-lived tab
  stays bounded — `burrCacheSize`, tested over 300 hard seeds); memo
  keys are short strings (`groupKey`). `makeBurr(seed, difficulty)`: orders the pieces, mostly gives each cube to the first to leave
  (always comes apart), some at random and some empty (`gap` 0.35 / `mixed` 0.3 beyond Easy), `repaired` (gives a split
  piece back cubes that join it), then hill-climbs to the level range (Easy 1, Medium 2–3, Hard ≥ 4); cached. Its work is
  bounded by positions looked at, never a clock (`searchWithin`): one search gives up after `SEARCH_MOST` (30,000; treated
  as "doesn't come apart"), the hunt stops at `WORK_MOST` (80,000) with the best so far; `burrWork` reports it. Seeds 1–100
  never needed more than 17,000 / 33,000 (only hard 39 and 42 give up a search — once each, with the same puzzle as
  before), so every saved seed is unchanged; libraryBurrSearch pins seeds 1–30 by fingerprint. Saved inserts keep only
  the seed: never change what a seed makes. Laid flat
  (`laidFlat`: the turn with fewest bridges); notches = `cellOutlines` of columns cut through / top only / bottom only,
  `offsetPolygon` by fit, Removes from `levelPlane`s; the piece itself drawn fit smaller and f lower (`assembledToBed`
  maps the puzzle to each laid piece). Tests: libraryPuzzles (pure), engineLibraryPuzzles (pieces put back by
  `assembledToBed` don't overlap; nudged, they do). Surface patterns (`src/library/burrSurface.ts`, pure; inputs `surface`/`surfaceDepth`/
  `surfaceRepeats`/`surfaceSeed`/`ends` — the burr's own "pattern" is its puzzle number): the moulds' `SURFACE_PATTERNS` list,
  but as flat constant-depth ENGRAVED shapes (`patternMarks`: convex shapes clipped to the face, wavy/zigzag bands cut square
  at their ends, whole circles; never overlapping) — never raised on a long face, as the sticks slide. Only cube faces whose
  next cube is in no full stick show from outside (`outsideCells`, via `cubeOnBed` = laidFlat's turn) — 32 along each stick +
  8 on its ends, whatever the notches; runs of them → `outsideRects`, inset `marginFor` (1 + depth + fit); shapes thinner
  than `LEAST_WIDTH` 0.8 (`thickness`) are dropped. The face on the bed
  is never decorated (first layers fill a shallow groove; its roof would be mid-air); upright sides' grooves are ≤ 1.5 deep.
  Depth ≤ `MOST_DEPTH` and ≤ `DEPTH_SHARE` × cube. Ends: plain / pattern / number (Text "1"–"6") / badge (a raised diamond,
  45° lower sides, `BADGE_EDGE` from the end's edges, + the number (`BADGE_CAP` × R) cut through it `BADGE_NUMBER_EXTRA`
  into the end); numbers under `MIN_LABEL` (2.5, testPrints.ts) are refused. Badges only if `badgesFree` (cached: with a
  whole cube added beyond every end, `withEndCubes`, the solver still comes apart at the same level AND the plain sticks'
  shortest way apart — `pathApart` in burr.ts, the same BFS as `disassembly` but keeping the moves — replays clear one cube
  at a time, `replay`; hard 12 has another 4-move way but its own solution's 4th move hits an end, so it's refused). So a
  badge never blocks the solution, though on some hard burrs it blocks a few side moves plain sticks allow. Per decorated face, `fixedPlane`
  sketches + extrudes of `MARKS_PER_CUT` (12) marks each (`CUT_START` outside the face, cut flipped in; the engine fuses a
  sketch's regions one by one, so big sketches get slow), appended after that piece's notches (not apart, so they cut the
  latest part = that piece); ≤ `MOST_SHAPES` (120) per piece — the default lattice burr builds in ~8 s. "none" + "plain" (and old inserts without the values)
  make exactly the old features. Tests: libraryBurrPatterns (pure; badges vs the solution for seeds 1–12 of each difficulty), engineBurrPatterns (heavy, own file: volumes lost =
  engraving, no overlaps, the first few free moves of the plain cubes still free half a cube at a time; pieces reach past the plain ones only beyond
  their ends), mcpBurrPatterns.
- Toolbars: the Part Studio's is laid out by the pure `src/app/toolbarLayout.ts` (`STUDIO_TOOLBAR`: slots of tool keys,
  `STUDIO_TOOLS` = every key, each exactly once — tests/toolbarLayout; Toolbar.tsx's `tools` record must define each), grouped
  as in Onshape so it fits 1280 px with ~80 px to spare in CI's font (`.tool-button` 42 px, 10 px text under 1400 px; the smoke test checks,
  reports the room left — warns under 40 — and shots toolbar1280/toolbarmenu/toolbaripad): a slot of several
  tools is a `ToolGroupButton` (the last one used shows, `partsmith.toolGroup.<id>`; `GroupItem.short` = a shorter face label,
  `divider` = a line above it in the list; `compact` = icon only; a right-click / long press on it opens the list too; the
  list scrolls when taller than the window, `max-height` from its top; the ▾ is 26 px wide (22 on a narrow tablet) under
  `(pointer: coarse)`). Undo/Redo, Section, Fit, Views and Pick are icon-only
  (`.tool-button.icon-only`) on every toolbar. Sketch families, the relations under "More relations ▾" (`MORE_RELATIONS`) and
  the Text / Insert DXF / Insert image group are listed there too. The sketch toolbar fits 1280 px with ~60 px to spare
  (`SKETCH_TOOLBAR_TOOLS` each in one place: `SKETCH_SINGLE_TOOLS`, families — Point under Spline, Round + Chamfer their own
  "round" family —, 5 main relations; Construction icon-only; Extrude/Revolve one ▾, Copy/Paste/Delete one compact ▾; long
  tool names get a `short` button label so the width doesn't change with the tool shown). Smoke: click tools with `tool(name)` (opens the ▾ when needed).
  Top bar: its buttons never shrink (`.topbar > *`); the name and save state give way (ellipsis), labels go in steps
  (`early-label` Install/New/Open/Save ≤ 1260 px, the rest ≤ 1120 bar Claude's, all ≤ 1000); each button has an aria-label so
  it keeps its name (the smoke test checks nothing is cut off at 1024–1366). Fonts differ, so the bar also
  measures itself (`src/app/topBarFit.ts` `watchTopBar`: ResizeObserver + MutationObserver; classes `tight-1..3`, the first step
  at which nothing overflows and the name box isn't squeezed to its minimum). Bottom-right corner: Measure/Mass
  (`.readout-stack`) moves left of a right-hand panel (`:has(> .laser-panel)`…); panels end above the status line; the touch bar
  sets `--touch-bar-room` on its parent (ResizeObserver) so the status line, readouts and panels sit above it. The 3D print /
  Laser panels scroll (children `flex-shrink: 0`), Laser's Save buttons are a sticky footer; the assembly panel scrolls as a whole.
- Light/dark: `src/app/theme.ts` sets `data-theme` on <html> (CSS variables in styles.css; use variables, not
  fixed colours, for anything outside the drawing paper) and `store.theme` (the viewport recolours sketches).
- Offline/installable: `public/manifest.webmanifest` + `public/sw.js` (registered in main.tsx, production only);
  bump `CACHE` in sw.js if its caching rules change.
- Versions: bump `version` in package.json and add a CHANGELOG.md entry (with the merge commit) at the end of each
  phase. This session type can't create GitHub releases or push tags, so CHANGELOG.md is the record.
- No `package-lock.json` is committed yet (it couldn't be generated in the first session); add one when
  a session can run `npm install`.
