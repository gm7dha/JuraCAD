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
- Simplify (tidy triangles into real faces): an Import's `Feature.simplify` (`SimplifyLevel` fine/normal/coarse; missing = as
  before) or a "simplify" feature (`simplifyParts` + `simplify`; Toolbar next to Delete part, Parts list right-click, Claude's
  `simplify_part`). Levels/tolerances and the summary text (`simplifyReport`: "4,812 faces → 38 faces: 22 flat, 12 round
  (holes Ø5, Ø8, fillets R2), 4 left as mesh.") are pure in `src/model/simplify.ts`; the summary reaches the app as
  `RebuildResult.featureNotes` → `store.featureNotes` (blue `.dialog-note` in the dialog, the row's tooltip; MCP `Build.notes`).
  Stage 1 always: `unifyShape` (ShapeUpgrade_UnifySameDomain, faces + edges + B-splines, the level's tolerances) — mends STEP
  files with split faces. Stage 2 for faceted input (an STL; a shape whose faces are ≥ 90% flat with straight edges,
  `isFaceted`): `planMesh` (`src/geometry/meshSimplify.ts`, pure) — triangles grouped flat (angle + distance), round faces grown
  from the biggest group over gently-turning neighbours (most shared edge first, much bigger neighbours skipped, until not flat
  within 2 × distance), fitted by `src/geometry/shapeFit.ts` (cylinder: axis from facet normals then tilted; cone: linear in
  x²+y²; sphere; torus: tube radius searched so normals step onto one spine circle) and accepted only if every corner is within
  the distance and every facet faces like the surface (`faces`, max(2 × angle, 1.5°) — what tells a fillet from the flat beside
  it); one-facet-tall rings with gentle turns beyond both ends are refused (`thinBand`); then triangles along smooth joins go to
  the face they lie on (`triRegion`); surfaces tidied to X/Y/Z and round sizes within ≤ 0.01 mm (`tidySurface`, `snapNice`:
  2R 4.9998 → 5); edges are chains of mesh edges between corners, each an exact line or arc (from the surfaces where possible —
  `meetCircle`: plane ⟂ axis, sphere/plane, coaxial cylinder/cone/torus; else fitted and snapped onto the axis), corners placed
  on all their surfaces (`meetPoint`) and exactly on their arcs; whole circles start at `canonicalX` (where round faces'
  seams are). A round face with an edge that's neither is given back as flat facets ("left as mesh"), and that repeats. The
  engine (`src/kernel/simplify.ts`) builds faces with ShapeFix_Face on each surface (round bands bounded by whole circles —
  holes, bosses, torus rings, ball caps — from parameter ranges, `bandOf`, as ShapeFix can't add their seam), sews, makes the
  solid and keeps it only if BRepCheck passes and the volume is within 2% of the mesh's; else retries flat faces only, else
  stage 1's result with "only flat areas were joined". An STL with Simplify goes mesh → solid directly (`readStlSimplified`:
  skips making a face per triangle, the slow part); open bodies fall back to the ordinary import. A STEP file whose triangles
  come as a skin (no solid; brought in as a surface without Simplify) becomes a solid when they close up (`solidFromFacets`). Results are cached
  (importer: by file + level, `importCacheKey`; Simplify part: `GeometryEngine.simplified`, by the features up to it).
  Not done: ellipses (a slanted hole's rim, so slanted holes stay mesh), cylinder–cylinder crossings, partial tori, free-form
  (B-spline) surfaces. Tests: tests/shapeFit, meshSimplify (pure; meshes from tests/support/meshShapes.ts), engineSimplify
  (heavy: a machined block's STL from the app's exporter → 10 faces, Ø5/Ø8/R2 within 0.01, volume within 0.5%, fillet on a
  recovered edge; a STEP with split faces → 6 faces, same volume; a mesh-like STEP skin → a solid; a lumpy ball stays sound), mcpSimplify.
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
  hole → colour it blue → glossy finish → save a 2× see-through picture → section view → check → export STL, STEP and 3MF → Laser: click the top face, save SVG (40 × 30 mm, blue hole, red outline) and DXF → edit → undo → sketch (rectangle, dimension, circle) → extrude → P hides/shows all planes, undo → fillet a face → revolve around a construction line → linear pattern → Mirror: click a face for the plane, Top, clear → Circular: Z axis → hole dialog (M4 sizes) → move a copy of a part → add a variable → save to .juracad → New → open it again → import the STEP and STL it exported → the STL again with Simplify on (the summary shows, fewer faces), undo → assembly: insert copies, parts list, type a position → Fasten mate by clicking two top faces → drag a part → rename a part → check the assembly (clashes) and export it as STEP → explode it → pattern a part → group two parts → sub-assembly: insert Assembly 1 twice into Assembly 2, fasten a fixed part to a part inside one (it moves), flattened and structured parts lists, make a copy flexible (nothing jumps), undo, double-click opens it → add a second Part Studio with a box → Help: download the Claude extension → Extend a spline up to a line → make a drawing (4 views, title block), add a dimension by clicking two corners, save DXF and PDF → drag a dimension's number, then a slanted angle's (arc follows; across an arm it measures the supplementary angle; Shift into the opposite angle, the outside angle), undo → add a section view, a detail view and an auxiliary view → second sheet → a third sheet of Assembly 1 with its own part number → a view of another part with a projected top view (lined up), auto-dimensioned, then removed → draw the assembly exploded (parts list) → sheet metal from a part (a shelled box in a new Part Studio: its walls clicked one at a time from views that see them, a rip clicked, three more added, Accept: 4 bends); Design library: a finger-joint box inserted (6 panels, 140 mm) and widened to 170 mm in Variables, then a box with lid from the 3D printing tab (2 parts), then a bolt, nut and washer set found by searching, then a stencil of HELLO exported for laser (1 red outline, 5 blue holes); a touch screen (an iPad-sized page with `hasTouch`, fingers sent through CDP `Input.dispatchTouchEvent`: pinch zooms the 3D view and not the page, double-tap fits, a tap selects a face, in a sketch two fingers pan and draw nothing, a one-finger drag draws a line); Live with Claude (two chats, a third later; then through Safari's link window with `?liveRelay`) (the page is opened with `?smoke`, which exposes `window.juracadViewport`, `window.juracadStore` and `window.juracadDrawing` (a view's points on the sheet on show) so the test can find faces on screen). To see the result, set `SMOKE_SCREENSHOTS: "1"` in the CI
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
  list's colour popover (FeaturePanel.tsx `ColourSwatch`); store `setPartFinish`/`setPartsFinish`. Drawings ignore it (line
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
- Design library (Onshape-style configurable library parts): `src/library/` (pure). `insert.ts` has `LIBRARY` (`designs/*.ts`) in two
  sections, `LibraryDesign.category` "laser" (Laser cutting: finger-joint box, flat-pack phone stand, and `designs/laserSet.ts`'s
  stencil, rubber stamp, name/key tag, coasters, picture frame, living-hinge panel, gear, ruler — flat panels for Export for laser)
  and "print" (3D printing: tray, box with lid, shelf bracket, wall hook, cable clip, phone/tablet stand, print-in-place hinge,
  spacer/washer, grip knob, stamp with handle, and — in `printDesigns.ts`, appended to LIBRARY — bolt/nut/washer set, hex
  standoff, piano hinge, screw-top jar, bit holder block, pegboard hook, drawer pull, desk cable grommet, corner protector, then the third
  batch: Gridfinity baseplate and bin, name plate, battery organiser, spool holder, under-desk headphone hook, plant pot + saucer,
  bag clip, knurled thumb knob, hose/vacuum adapter, SD card holder — each
  sits flat on the bed at z ≥ 0); `LIBRARY_CATEGORIES`, `designsIn`, `categoryFrom`;
  optional `LibraryDesign.group` = a heading within the tab (`designGroups` = `groupDesigns(designsIn(c))`: ungrouped first, then
  groups — that section's `GROUP_ORDER` first (print: Fixings, Hinges, Storage, Gridfinity, Household, Desk, Garden, Workshop; laser: none), the rest in order of first use;
  laser: Boxes and stands, Signs and stamps, Home, Workshop). The window also has a search box (`browse.ts` `searchDesigns`: every
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
- Light/dark: `src/app/theme.ts` sets `data-theme` on <html> (CSS variables in styles.css; use variables, not
  fixed colours, for anything outside the drawing paper) and `store.theme` (the viewport recolours sketches).
- Offline/installable: `public/manifest.webmanifest` + `public/sw.js` (registered in main.tsx, production only);
  bump `CACHE` in sw.js if its caching rules change.
- Versions: bump `version` in package.json and add a CHANGELOG.md entry (with the merge commit) at the end of each
  phase. This session type can't create GitHub releases or push tags, so CHANGELOG.md is the record.
- No `package-lock.json` is committed yet (it couldn't be generated in the first session); add one when
  a session can run `npm install`.
