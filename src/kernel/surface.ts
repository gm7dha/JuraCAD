/**
 * Surfaces: thin skins with no inside, made the same ways as solids
 * (extruding, revolving, sweeping or lofting a sketch) but from its curves —
 * open runs as well as closed shapes — and from edges of parts (Fill). A
 * surface part can be thickened into a solid, or several can be closed up
 * into one (Enclose). All with OpenCascade.
 */
import { basicFaceExtrusion, cast, getOC, loft, makeBSplineApproximation, makeCompound, makePolygon, measureShapeVolumeProperties, measureVolume, makeNonPlanarFace, makeSolid, revolution, Vector, type Edge, type Face, type Shape3D, type Wire, assembleWire, makeFace } from "replicad";

import { planeFrame, toWorld, type SketchPlane } from "../sketch/planes";
import { findChains, type Chain } from "../sketch/regions";
import { axisInSketch, type RevolveAxis } from "../sketch/axis";
import type { SketchData } from "../sketch/types";
import { release, segmentsWire } from "./extrude";
import { loopStart, pathWire, profileAt } from "./sweep";
import { edgesOf, facesOf, solidsOf } from "./topology";

type Vec3 = [number, number, number];

/** The sketch's runs of curves as wires (closed and open), with their plane's frame. */
function sketchWires(plane: SketchPlane, data: SketchData, what: string): { wires: Wire[]; chains: Chain[]; frame: ReturnType<typeof planeFrame> } {
  const { chains, problems } = findChains(data);
  if (chains.length === 0) {
    throw new Error(`The sketch has no lines or curves to ${what}.${problems.length ? ` ${problems.join(" ")}` : " Draw an outline — it needn't be closed for a surface."}`);
  }
  const frame = planeFrame(plane);
  return { wires: chains.map((c) => segmentsWire(c.segments, frame, 0)), chains, frame };
}

/**
 * The shape wrapped as what it really is. replicad's helpers (extrusion,
 * revolution, loft…) label everything a Solid, but a surface is a shell or a
 * face; moving or mirroring a mislabelled shape later fails with
 * "unexpected types mismatch".
 */
export function asIs(shape: Shape3D | Face): Shape3D {
  const out = cast(shape.wrapped) as Shape3D;
  // A new handle to the same geometry; the old wrapper's handle can go.
  shape.delete();
  return out;
}

/** One shape from several (a compound when there's more than one). */
function joined(pieces: (Shape3D | Face)[]): Shape3D {
  if (pieces.length === 1) return asIs(pieces[0]);
  return makeCompound(pieces.map((p) => asIs(p))) as Shape3D;
}

/** OpenCascade can sweep a wire the same way as a face; the result is a shell rather than a solid. */
const asFace = (w: Wire) => w as unknown as Face;

/** Each run of the sketch's curves pushed `depth` along the plane's normal: a skin with no ends. */
export function extrudeSurface(plane: SketchPlane, data: SketchData, opts: { depth: number; end: "blind" | "symmetric"; flip: boolean }): Shape3D {
  const { wires, frame } = sketchWires(plane, data, "extrude");
  const sign = opts.flip ? -1 : 1;
  const n = frame.n;
  const start = opts.end === "symmetric" ? (-opts.depth / 2) * sign : 0;
  const vector = new Vector([n[0] * opts.depth * sign, n[1] * opts.depth * sign, n[2] * opts.depth * sign]);
  try {
    const pieces = wires.map((w) => {
      const moved = start ? w.translate([n[0] * start, n[1] * start, n[2] * start]) : w;
      try {
        return basicFaceExtrusion(asFace(moved), vector);
      } finally {
        if (moved !== w) release(moved);
      }
    });
    return joined(pieces);
  } finally {
    release(vector, ...wires);
  }
}

/** Each run of the sketch's curves spun round the axis: a skin. */
export function revolveSurface(plane: SketchPlane, data: SketchData, opts: { axis: RevolveAxis; angle: number; flip: boolean }): Shape3D {
  if (!(opts.angle > 0) || opts.angle > 360) throw new Error("The angle must be more than 0° and at most 360°.");
  const axis = axisInSketch(data, opts.axis);
  if (!axis) throw new Error("The line to spin around isn't in the sketch any more. Pick another axis.");
  const { wires, chains, frame } = sketchWires(plane, data, "revolve");
  // Everything that's revolved must lie on one side of the axis, or the surface would pass through itself.
  const side = (p: [number, number]) => axis.dir[0] * (p[1] - axis.at[1]) - axis.dir[1] * (p[0] - axis.at[0]);
  const sides = chains.flatMap((c) =>
    c.segments.flatMap((sg) => {
      if ("from" in sg) return [side(sg.from), side(sg.to), ...("mid" in sg ? [side(sg.mid)] : [])];
      const r = sg.kind === "circle" ? sg.radius : Math.max(sg.rx, sg.ry);
      return [side(sg.center) + r, side(sg.center) - r];
    }),
  );
  if (sides.some((v) => v > 1e-6) && sides.some((v) => v < -1e-6)) {
    release(...wires);
    throw new Error("The outline crosses the line it spins around. Keep it all on one side of the axis.");
  }
  const origin = toWorld(frame, axis.at[0], axis.at[1]);
  const tip = toWorld(frame, axis.at[0] + axis.dir[0], axis.at[1] + axis.dir[1]);
  const sign = opts.flip ? -1 : 1;
  const direction: Vec3 = [(tip[0] - origin[0]) * sign, (tip[1] - origin[1]) * sign, (tip[2] - origin[2]) * sign];
  try {
    return joined(wires.map((w) => revolution(asFace(w), origin, direction, opts.angle)));
  } finally {
    release(...wires);
  }
}

/** Each run of the profile's curves carried along the path: a skin. */
export function sweepSurface(profilePlane: SketchPlane, profile: SketchData, pathPlane: SketchPlane, path: SketchData): Shape3D {
  const { wires } = sketchWires(profilePlane, profile, "sweep");
  const spine = pathWire(pathPlane, path, profileAt(profilePlane, profile));
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const why = (e: unknown): string => {
    if (e instanceof Error) return e.message;
    try {
      const [, message] = oc.getExceptionMessage(e);
      return String(message);
    } catch {
      return String(e);
    }
  };
  try {
    return joined(
      wires.map((w) => {
        // OpenCascade's pipe shell carries any outline (open or closed) along the path as a skin.
        const pipe = new oc.BRepOffsetAPI_MakePipeShell(spine.wrapped);
        try {
          pipe.SetTransitionMode(oc.BRepBuilderAPI_TransitionMode.BRepBuilderAPI_RoundCorner);
          // No correction: a single line has no plane to turn square to the path.
          pipe.Add(w.wrapped, false, false);
          pipe.Build();
          if (!pipe.IsDone()) throw new Error("the path and outline don't go together");
          return cast(pipe.Shape()) as Shape3D;
        } catch (e) {
          throw new Error(`Couldn't sweep the outline along that path (${why(e)}). Check it sits at the start of the path and is small enough for its bends.`);
        } finally {
          pipe.delete();
        }
      }),
    );
  } finally {
    release(spine, ...wires);
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** A smooth skin through one run of curves (open or closed) on each sketch, in order. */
export function loftSurface(sections: { plane: SketchPlane; data: SketchData; name: string }[]): Shape3D {
  if (sections.length < 2) throw new Error("Pick at least two sketches to loft between.");
  const wires: Wire[] = [];
  try {
    let closed: boolean | null = null;
    let start: [number, number, number] | undefined;
    for (const s of sections) {
      const { chains } = findChains(s.data);
      if (chains.length !== 1) throw new Error(`${s.name} needs exactly one run of lines or curves to loft through (it has ${chains.length}).`);
      if (closed !== null && chains[0].closed !== closed) throw new Error("The sketches must all be closed shapes, or all open outlines.");
      closed = chains[0].closed;
      const frame = planeFrame(s.plane);
      start ??= loopStart(chains[0].segments, frame);
      wires.push(segmentsWire(chains[0].segments, frame, 0, start));
    }
    try {
      return asIs(loft(wires, { ruled: false }, true));
    } catch {
      throw new Error("Couldn't loft between those outlines. Try sketches on parallel planes, or outlines with the same number of pieces.");
    }
  } finally {
    release(...wires);
  }
}

/**
 * A face spanning a closed ring of edges (picked on parts): flat if they lie
 * in a plane, otherwise a smooth patch (OpenCascade's filling). With
 * `match`, the patch meets the faces beside the edges (`supports`, one per
 * edge, or null where there's none) smoothly — tangent to them — instead of
 * at an angle.
 */
export function fillEdges(edges: Edge[], match?: { supports: (Face | null)[] }): Shape3D {
  if (edges.length === 0) throw new Error("Click the edges round the opening to fill.");
  let wire: Wire;
  try {
    wire = assembleWire(edges);
  } catch {
    throw new Error("The edges don't join up into one ring. Pick every edge round the opening, in any order.");
  }
  if (!(getOC() as unknown as { BRep_Tool: { IsClosed(w: unknown): boolean } }).BRep_Tool.IsClosed(wire.wrapped)) {
    release(wire);
    throw new Error("The edges don't close up into a ring — there's a gap. Pick every edge round the opening.");
  }
  if (match && match.supports.some((f) => !!f)) {
    release(wire);
    return smoothFill(edges, match.supports);
  }
  try {
    try {
      return asIs(makeFace(wire));
    } catch {
      return asIs(makeNonPlanarFace(wire));
    }
  } catch {
    throw new Error("Couldn't fit a surface to those edges. Pick a ring of edges that closes up.");
  } finally {
    release(wire);
  }
}

/**
 * OpenCascade's filling through the edges, tangent to the face beside each
 * one. Where the faces leave the edges steeply (a tube's
 * walls going straight up from its rim), the patch is first pulled out by a
 * point above the middle of the opening, or it can't bend round far enough.
 */
function smoothFill(edges: Edge[], supports: (Face | null)[]): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const order = oc.GeomAbs_Shape.GeomAbs_G1;
  // Where the faces round the opening are heading: on past each edge, averaged; and the opening's middle and size.
  const pts: Vec3[] = [];
  const heading: Vec3 = [0, 0, 0];
  edges.forEach((edge, i) => {
    const face = supports[i];
    if (face) {
      const { at, out } = acrossEdge(edge, face, 8);
      pts.push(...at.slice(0, -1));
      out.forEach((d) => ((heading[0] += d[0]), (heading[1] += d[1]), (heading[2] += d[2])));
    } else for (let k = 0; k < 8; k++) pts.push(take(edge.pointAt(k / 8)));
  });
  const mid: Vec3 = [0, 1, 2].map((k) => pts.reduce((sum, p) => sum + p[k], 0) / pts.length) as Vec3;
  const size = pts.reduce((sum, p) => sum + Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]), 0) / pts.length;
  const along = Math.hypot(...heading);
  const attempt = (guide: Vec3 | null): Shape3D | null => {
    const filling = new oc.BRepOffsetAPI_MakeFilling(3, 15, 2, false, 1e-5, 1e-4, 1e-2, 0.1, 8, 9);
    try {
      edges.forEach((edge, i) => {
        const face = supports[i];
        if (face) filling.Add(edge.wrapped, face.wrapped, order, true);
        else filling.Add(edge.wrapped, oc.GeomAbs_Shape.GeomAbs_C0, true);
      });
      if (guide) {
        const p = new oc.gp_Pnt(guide[0], guide[1], guide[2]);
        filling.Add(p);
        p.delete();
      }
      filling.Build();
      if (!filling.IsDone()) return null;
      // Is it smooth where it meets the faces (within about 3°)?
      if (filling.G1Error() > 0.05) return null;
      const out = cast(filling.Shape()) as Shape3D;
      const faces = facesOf(out);
      const any = faces.length > 0;
      faces.forEach((f) => f.delete());
      if (!any) {
        out.delete();
        return null;
      }
      return out;
    } catch {
      return null;
    } finally {
      filling.delete();
    }
  };
  let out = attempt(null);
  // Pulled out towards where the faces head, by about the opening's size (a little less: a dome, not a cone).
  for (const reach of [0.7, 0.4, 1]) {
    if (out || along < 1e-9) break;
    out = attempt([mid[0] + (heading[0] / along) * size * reach, mid[1] + (heading[1] / along) * size * reach, mid[2] + (heading[2] / along) * size * reach]);
  }
  if (!out)
    throw new Error(
      "Couldn't fit a smooth surface to those edges and the faces beside them. If the opening has sharp corners (like the top of a box), round them first (Fillet) — a smooth patch can't meet two faces at a sharp corner. Or use “Just meet the edges”.",
    );
  return out;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Shells to thicken one by one: each shell of the shape, or a lone face as its own. */
function shellsOf(shape: Shape3D): Shape3D[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const type = shape.wrapped.ShapeType();
  if (type === oc.TopAbs_ShapeEnum.TopAbs_SHELL || type === oc.TopAbs_ShapeEnum.TopAbs_FACE) return [shape];
  const out: Shape3D[] = [];
  const seen: any[] = [];
  const explorer = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_SHELL, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  for (; explorer.More(); explorer.Next()) {
    const item = explorer.Current();
    if (seen.some((x) => x.IsSame(item))) continue;
    seen.push(item);
    out.push(cast(item) as Shape3D);
  }
  explorer.delete();
  // Faces not in any shell.
  const loose = new oc.TopExp_Explorer(shape.wrapped, oc.TopAbs_ShapeEnum.TopAbs_FACE, oc.TopAbs_ShapeEnum.TopAbs_SHELL);
  for (; loose.More(); loose.Next()) out.push(cast(loose.Current()) as Shape3D);
  loose.delete();
  return out;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** The edges of a skin that only one face runs along, once: its open rim (not seams, which a face runs along twice). */
function freeEdges(shell: Shape3D): Edge[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const count = new Map<number, { edge: Edge; n: number }>();
  const explorer = new oc.TopExp_Explorer(shell.wrapped, oc.TopAbs_ShapeEnum.TopAbs_EDGE, oc.TopAbs_ShapeEnum.TopAbs_SHAPE);
  // Every time any face runs along an edge, it's listed again here.
  for (; explorer.More(); explorer.Next()) {
    const edge = cast(explorer.Current()) as Edge;
    const seen = count.get(edge.hashCode);
    if (seen) {
      seen.n++;
      edge.delete();
    } else count.set(edge.hashCode, { edge, n: 1 });
  }
  explorer.delete();
  const out: Edge[] = [];
  for (const { edge, n } of count.values()) {
    // Not the point an edge shrinks to at a pole (the top of a ball), which no wall could be built from.
    if (n === 1 && !oc.BRep_Tool.Degenerated(edge.wrapped)) out.push(edge);
    else edge.delete();
  }
  return out;
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const signedVolume = (shape: Shape3D): number => measureVolume(shape);

/** Faces and shells sewn up and made a solid (its faces turned to point outwards), or an error if they don't close. */
function solidFrom(pieces: Shape3D[]): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const skin = sewn(pieces);
  try {
    let shell = skin.wrapped;
    let made: any = null;
    if (shell.ShapeType() === oc.TopAbs_ShapeEnum.TopAbs_FACE) {
      // One face closed on itself (a ball): put it in a shell of its own.
      made = new oc.TopoDS_Shell();
      const b = new oc.TopoDS_Builder();
      b.MakeShell(made);
      b.Add(made, shell);
      b.delete();
      shell = made;
    }
    if (shell.ShapeType() !== oc.TopAbs_ShapeEnum.TopAbs_SHELL) throw new Error("not closed");
    const fix = new oc.ShapeFix_Solid();
    try {
      const solid = cast(fix.SolidFromShell(oc.TopoDS.Shell(shell))) as Shape3D;
      if (!(signedVolume(solid) > 1e-9)) {
        solid.delete();
        throw new Error("not closed");
      }
      return solid;
    } finally {
      fix.delete();
      made?.delete();
    }
  } finally {
    skin.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * A surface (skin) made into a solid `thickness` thick (on the side its faces
 * point to; minus for the other side; or, `bothSides`, half each way): the
 * skin (or its copy pushed out half way), a copy pushed out by the thickness,
 * and walls between their rims, closed up into a solid.
 */
export function thickenSurface(shape: Shape3D, thickness: number, bothSides = false): Shape3D {
  if (!(Math.abs(thickness) > 1e-9)) throw new Error("Thickness: enter how thick to make it.");
  const pieces: Shape3D[] = [];
  try {
    for (const shell of shellsOf(shape)) pieces.push(thickenShell(shell, thickness, bothSides));
    const out = pieces.length === 1 ? pieces[0] : (makeCompound(pieces) as Shape3D);
    pieces.length = 0;
    return out;
  } finally {
    pieces.forEach((p) => p.delete());
  }
}

/**
 * The shape's faces moved `distance` along their normals (OpenCascade's offset
 * shape), with the builder — its `Generated` says where each edge went. Sharp
 * corners where the moved faces meet are tried first; where that can't be
 * worked out (faces meeting at an awkward angle) the corners are rounded instead.
 */
function offsetShape(shape: Shape3D, distance: number, failed: string): { offset: Shape3D; builder: { Generated(s: unknown): { Size(): number; First(): unknown; delete(): void }; delete(): void } } {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  for (const join of [oc.GeomAbs_JoinType.GeomAbs_Intersection, oc.GeomAbs_JoinType.GeomAbs_Arc]) {
    const builder = new oc.BRepOffsetAPI_MakeOffsetShape();
    try {
      builder.PerformByJoin(shape.wrapped, distance, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, join, false);
      if (!builder.IsDone()) throw new Error(failed);
      const offset = cast(builder.Shape()) as Shape3D;
      const faces = facesOf(offset);
      const any = faces.length > 0;
      faces.forEach((f) => f.delete());
      if (!any) {
        offset.delete();
        throw new Error(failed);
      }
      return { offset, builder };
    } catch {
      builder.delete();
    }
  }
  throw new Error(failed);
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

type OffsetBuilder = ReturnType<typeof offsetShape>["builder"];

function thickenShell(shell: Shape3D, thickness: number, bothSides = false): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const failed = "Couldn't thicken this surface. Try a smaller thickness, or the other side.";
  const rim = freeEdges(shell);
  const walls: Shape3D[] = [];
  // The two faces of the solid: the skin itself and a copy pushed out by the thickness, or copies half way out either side.
  const sides: { shape: Shape3D; builder: OffsetBuilder | null }[] = [];
  const offsets = bothSides ? [thickness / 2, -thickness / 2] : [thickness];
  try {
    if (!bothSides) sides.push({ shape: shell, builder: null });
    for (const d of offsets) {
      const made = offsetShape(shell, d, failed);
      sides.push({ shape: made.offset, builder: made.builder });
    }
    if (rim.length === 0) {
      // A closed skin: the space between the two. Plus is outwards, whichever way its faces point.
      const [a, b] = sides;
      const inner = solidFrom([a.shape]);
      let outer = solidFrom([b.shape]);
      try {
        // Which one is outside depends on which way the faces point; Both sides doesn't mind.
        if (!bothSides && signedVolume(outer) > signedVolume(inner) !== thickness > 0) {
          outer.delete();
          const again = offsetShape(shell, -thickness, failed);
          again.builder.delete();
          b.builder?.delete();
          b.shape.delete();
          b.shape = again.offset;
          b.builder = null;
          outer = solidFrom([b.shape]);
        }
        const [small, big] = signedVolume(inner) < signedVolume(outer) ? [inner, outer] : [outer, inner];
        const between = big.cut(small);
        const solids = solidsOf(between);
        if (solids.length === 1) {
          between.delete();
          return solids[0];
        }
        solids.forEach((x) => x.delete());
        return between;
      } finally {
        inner.delete();
        outer.delete();
      }
    }
    // A wall between where each rim edge went on one side and where it went on the other.
    const imageOf = (side: (typeof sides)[number], edge: Edge): { edge: Edge; own: boolean } => {
      if (!side.builder) return { edge, own: false };
      const images = side.builder.Generated(edge.wrapped);
      try {
        if (images.Size() === 0) throw new Error(failed);
        return { edge: cast(images.First() as never) as Edge, own: true };
      } finally {
        images.delete();
      }
    };
    for (const edge of rim) {
      const one = imageOf(sides[0], edge);
      const two = imageOf(sides[1], edge);
      const ruled = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
      try {
        const w1 = new oc.BRepBuilderAPI_MakeWire(one.edge.wrapped);
        const w2 = new oc.BRepBuilderAPI_MakeWire(two.edge.wrapped);
        ruled.AddWire(w1.Wire());
        ruled.AddWire(w2.Wire());
        w1.delete();
        w2.delete();
        ruled.Build();
        if (!ruled.IsDone()) throw new Error(failed);
        walls.push(cast(ruled.Shape()) as Shape3D);
      } finally {
        ruled.delete();
        if (one.own) one.edge.delete();
        if (two.own) two.edge.delete();
      }
    }
    try {
      // Walls that meet flat along an edge are merged into one face (fewer, cleaner faces to pick).
      return solidFrom([...sides.map((x) => x.shape), ...walls]).simplify();
    } catch {
      throw new Error(failed);
    }
  } finally {
    for (const side of sides) {
      side.builder?.delete();
      if (side.shape !== shell) side.shape.delete();
    }
    rim.forEach((e) => e.delete());
    walls.forEach((w) => w.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Surfaces sewn together and closed into one solid (they must meet at their edges all the way round). */
export function encloseSurfaces(shapes: Shape3D[]): Shape3D {
  if (shapes.length === 0) throw new Error("Pick the surfaces to close up into a solid.");
  try {
    return solidFrom(shapes);
  } catch {
    throw new Error(gapReport(shapes));
  }
}

const roundTo = (x: number) => {
  const r = Math.round(x * 10) / 10;
  return Object.is(r, -0) ? 0 : r;
};

/**
 * Why surfaces don't close up: how many edges are left open once they're
 * sewn together (only one face runs along them), and where the first is.
 */
export function gapReport(shapes: Shape3D[]): string {
  let open: Edge[] = [];
  let skin: Shape3D | null = null;
  try {
    skin = sewn(shapes);
    open = freeEdges(skin);
    if (!open.length) return "These surfaces don't close up into a solid — they cross or overlap somewhere. Split or trim them so they only meet at their edges.";
    const at = take(open[0].pointAt(0.5)).map(roundTo);
    const total = open.reduce((sum, e) => sum + e.length, 0);
    return `These surfaces don't close up into a solid: ${open.length === 1 ? "one edge is" : `${open.length} edges are`} left open (${Math.round(total * 10) / 10} mm in all), for example near (${at.join(", ")}). Fill the gap or extend the surfaces to meet, then try again.`;
  } catch {
    return "These surfaces don't close up into a solid — there's a gap somewhere between them. Fill it first.";
  } finally {
    open.forEach((e) => e.delete());
    skin?.delete();
  }
}

/** A copy of a surface moved `distance` along its normal everywhere (minus for the other side). */
export function offsetSurface(shape: Shape3D, distance: number): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const builder = new oc.BRepOffsetAPI_MakeOffsetShape();
  try {
    builder.PerformByJoin(shape.wrapped, distance, 1e-4, oc.BRepOffset_Mode.BRepOffset_Skin, false, false, oc.GeomAbs_JoinType.GeomAbs_Arc, false);
    if (!builder.IsDone()) throw new Error("Couldn't offset this surface that far. Try a smaller distance.");
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Faces and shells sewn into one shell (or whatever closes up), with OpenCascade's sewing. */
function sewn(shapes: Shape3D[]): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const sewing = new oc.BRepBuilderAPI_Sewing(1e-4, true, true, true, false);
  try {
    for (const s of shapes) sewing.Add(s.wrapped);
    sewing.Perform();
    return cast(sewing.SewedShape()) as Shape3D;
  } finally {
    sewing.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Several surfaces as one: sewn together where they touch, otherwise side by side. */
export function joinSurfaces(shapes: Shape3D[]): Shape3D {
  return sewn(shapes);
}

/** A surface with some of its faces taken away (what's left, sewn back together). */
export function removeFaces(shape: Shape3D, faces: Face[]): Shape3D {
  const keep = facesOf(shape).filter((f) => !faces.some((x) => x.isSame(f)));
  try {
    if (keep.length === 0) throw new Error("That would remove the whole surface. Use Delete part instead.");
    return sewn(keep as unknown as Shape3D[]);
  } finally {
    keep.forEach((f) => f.delete());
  }
}

/** How far a point is from a face (OpenCascade's distance between shapes). */
function distanceToFace(face: Face, p: Vec3): number {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const pnt = new oc.gp_Pnt(p[0], p[1], p[2]);
  const vertex = new oc.BRepBuilderAPI_MakeVertex(pnt);
  const dist = new oc.BRepExtrema_DistShapeShape();
  try {
    dist.LoadS1(vertex.Vertex());
    dist.LoadS2(face.wrapped);
    return dist.Perform() && dist.NbSolution() > 0 ? dist.Value() : Infinity;
  } finally {
    dist.delete();
    vertex.delete();
    pnt.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * Along an edge of a face: points on it, and at each the direction straight
 * on across the edge, in the surface and away from the face.
 */
function acrossEdge(edge: Edge, face: Face, samples: number): { at: Vec3[]; out: Vec3[] } {
  const at: Vec3[] = [];
  const out: Vec3[] = [];
  for (let i = 0; i <= samples; i++) {
    const s = i / samples;
    const m = take(edge.pointAt(s));
    const t = take(edge.tangentAt(s));
    let n: Vec3;
    try {
      n = take(face.normalAt(m));
    } catch {
      throw new Error("Couldn't tell which way the surface goes at that edge.");
    }
    at.push(m);
    out.push(unit(cross(t, n)));
  }
  // Which way is away from the face: a little way one side is on it, the other side isn't. Decided where it's
  // clearest (the middle), then kept the same all along.
  const mid = Math.floor(samples / 2);
  const eps = 1e-2;
  const [m, d] = [at[mid], out[mid]];
  const ahead = distanceToFace(face, [m[0] + d[0] * eps, m[1] + d[1] * eps, m[2] + d[2] * eps]);
  const behind = distanceToFace(face, [m[0] - d[0] * eps, m[1] - d[1] * eps, m[2] - d[2] * eps]);
  let flip = ahead < behind;
  if (Math.abs(ahead - behind) < 1e-6) {
    // Can't tell from the face (a sliver): away from its middle.
    const c = take(face.center);
    flip = d[0] * (m[0] - c[0]) + d[1] * (m[1] - c[1]) + d[2] * (m[2] - c[2]) < 0;
  }
  if (flip) out[mid] = [-d[0], -d[1], -d[2]];
  const follow = (i: number, j: number) => {
    const [a, b] = [out[i], out[j]];
    if (a[0] * b[0] + a[1] * b[1] + a[2] * b[2] < 0) out[i] = [-a[0], -a[1], -a[2]];
  };
  for (let i = mid + 1; i <= samples; i++) follow(i, i - 1);
  for (let i = mid - 1; i >= 0; i--) follow(i, i + 1);
  return { at, out };
}

/** A straight-ruled strip between an edge and a curve through `to` (the same number of points as along the edge). */
function stripTo(edge: Edge, to: Vec3[]): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const far = makeBSplineApproximation(to, { tolerance: 1e-5, degMax: 5, degMin: 3 });
  const ruled = new oc.BRepOffsetAPI_ThruSections(false, true, 1e-6);
  try {
    const w1 = new oc.BRepBuilderAPI_MakeWire(edge.wrapped);
    const w2 = new oc.BRepBuilderAPI_MakeWire(far.wrapped);
    ruled.AddWire(w1.Wire());
    ruled.AddWire(w2.Wire());
    w1.delete();
    w2.delete();
    ruled.Build();
    if (!ruled.IsDone()) throw new Error("Couldn't extend this surface.");
    return cast(ruled.Shape()) as Shape3D;
  } finally {
    ruled.delete();
    far.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/**
 * A surface grown out past its free edges: each picked edge is pushed
 * `distance` further on, straight along the surface's tangent at every point
 * along it (so a cone's rim carries on as a cone), and the new strip is joined
 * on. Where two extended edges of a face meet at a corner, the corner between
 * their strips is filled in too, as Onshape does.
 */
export function extendSurface(shape: Shape3D, edges: Edge[], distance: number, limit?: Shape3D): Shape3D {
  if (!edges.length) throw new Error("Click the edges of the surface to extend.");
  if (!(distance > 0)) throw new Error("Distance: enter how far to extend.");
  const faces = facesOf(shape);
  const strips: Shape3D[] = [];
  /** Each extended edge's ends: where they are, which way the strip goes there, and which way the edge runs on past them. */
  const ends: { face: Face; p: Vec3; d: Vec3; on: Vec3 }[] = [];
  try {
    for (const edge of edges) {
      const hash = edge.hashCode;
      // The face this edge belongs to.
      const face = faces.find((f) => {
        const mine = edgesOf(f);
        const has = mine.some((e) => e.hashCode === hash);
        mine.forEach((e) => e.delete());
        return has;
      });
      if (!face) throw new Error("A picked edge isn't on this surface. Pick its own edges.");
      const sameAll = (out: Vec3[]) => out.every((d) => d[0] * out[0][0] + d[1] * out[0][1] + d[2] * out[0][2] > 1 - 1e-9);
      // A straight edge usually goes the same way all along; check a few points first.
      let { at, out } = acrossEdge(edge, face, edge.geomType === "LINE" ? 2 : 48);
      if (at.length === 3 && !sameAll(out)) ({ at, out } = acrossEdge(edge, face, 48));
      const same = sameAll(out);
      if (same) {
        // The same way all along (a straight edge on a flat face, or a curve whose surface carries straight on from it, like the top of an upright wall): pushed straight out.
        const d = out[0];
        const v = new Vector([d[0] * distance, d[1] * distance, d[2] * distance]);
        try {
          strips.push(asIs(basicFaceExtrusion(edge as unknown as Face, v)));
        } finally {
          v.delete();
        }
      } else {
        strips.push(asIs(stripTo(edge, at.map((p, i) => [p[0] + out[i][0] * distance, p[1] + out[i][1] * distance, p[2] + out[i][2] * distance]))));
      }
      const t0 = unit(take(edge.tangentAt(0)));
      const t1 = unit(take(edge.tangentAt(1)));
      const last = at.length - 1;
      if (Math.hypot(at[0][0] - at[last][0], at[0][1] - at[last][1], at[0][2] - at[last][2]) > 1e-6) {
        ends.push({ face, p: at[0], d: out[0], on: [-t0[0], -t0[1], -t0[2]] });
        ends.push({ face, p: at[last], d: out[last], on: t1 });
      }
    }
    // Corners: two extended edges of one face meeting at a point, their strips going different ways.
    const corners: Shape3D[] = [];
    for (let i = 0; i < ends.length; i++) {
      for (let j = i + 1; j < ends.length; j++) {
        const a = ends[i];
        const b = ends[j];
        if (a.face !== b.face || Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) > 1e-6) continue;
        if (a.d[0] * b.d[0] + a.d[1] * b.d[1] + a.d[2] * b.d[2] > 1 - 1e-6) continue;
        const pa: Vec3 = [a.p[0] + a.d[0] * distance, a.p[1] + a.d[1] * distance, a.p[2] + a.d[2] * distance];
        const pb: Vec3 = [b.p[0] + b.d[0] * distance, b.p[1] + b.d[1] * distance, b.p[2] + b.d[2] * distance];
        // Where the strips' far edges, carried on past the corner, meet (a sharp corner); else just close the gap.
        const x = meetPoint(pa, a.on, pb, b.on, distance);
        const pts = x ? [a.p, pa, x, pb] : [a.p, pa, pb];
        try {
          corners.push(asIs(makePolygon(pts)));
        } catch {
          // Not flat: two triangles.
          if (x) corners.push(asIs(makePolygon([a.p, pa, x])), asIs(makePolygon([a.p, x, pb])));
        }
      }
    }
    const reached = strips.length;
    strips.push(...corners);
    if (!limit) return sewn([shape, ...strips]);
    const kept = trimToLimit(shape, strips, reached, limit, distance);
    try {
      return sewn([shape, ...kept]);
    } finally {
      release(...kept);
    }
  } finally {
    release(...faces, ...strips);
  }
}

/**
 * Extend up to a face or part: the strips (made long, `reach`) cut where they
 * meet `limit` — a solid part (cut away inside it) or a face (split along it;
 * a flat face counts as its whole plane) — keeping only the pieces still
 * joined to the surface. The first `mustReach` strips must each meet it.
 */
function trimToLimit(shape: Shape3D, strips: Shape3D[], mustReach: number, limit: Shape3D, reach: number): Shape3D[] {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const solid = solidsOf(limit);
  const isSolid = solid.length > 0;
  solid.forEach((x) => x.delete());
  let tool: Shape3D = limit;
  let ownTool = false;
  const limitFaces = isSolid ? [] : facesOf(limit);
  try {
    if (!isSolid && limitFaces.length === 1 && limitFaces[0].geomType === "PLANE") {
      // A flat face: its whole plane, big enough to cross every strip.
      const f = limitFaces[0];
      const c = take(f.center);
      const n = unit(take(f.normalAt()));
      const a = unit(Math.abs(n[0]) < 0.9 ? cross(n, [1, 0, 0]) : cross(n, [0, 1, 0]));
      const b = cross(n, a);
      const big = 4 * reach;
      const at = (s: number, t: number): Vec3 => [c[0] + a[0] * s + b[0] * t, c[1] + a[1] * s + b[1] * t, c[2] + a[2] * s + b[2] * t];
      tool = asIs(makePolygon([at(-big, -big), at(big, -big), at(big, big), at(-big, big)]));
      ownTool = true;
    }
  } finally {
    limitFaces.forEach((f) => f.delete());
  }
  const near = (piece: Shape3D) => {
    const dist = new oc.BRepExtrema_DistShapeShape();
    try {
      dist.LoadS1(piece.wrapped);
      dist.LoadS2(shape.wrapped);
      return dist.Perform() && dist.NbSolution() > 0 && dist.Value() < 1e-5;
    } finally {
      dist.delete();
    }
  };
  const kept: Shape3D[] = [];
  try {
    strips.forEach((strip, i) => {
      // Split where it meets the face (or the part's skin); the piece inside a part, or past it, doesn't touch the surface.
      let result: Shape3D;
      const splitter = new oc.BRepAlgoAPI_Splitter();
      const args = new oc.NCollection_List_TopoDS_Shape();
      const tools = new oc.NCollection_List_TopoDS_Shape();
      try {
        args.Append(strip.wrapped);
        tools.Append(tool.wrapped);
        splitter.SetArguments(args);
        splitter.SetTools(tools);
        splitter.Build();
        if (splitter.HasErrors()) throw new Error(`Couldn't cut the extension where it meets that ${isSolid ? "part" : "face"}.`);
        result = cast(splitter.Shape()) as Shape3D;
      } finally {
        splitter.delete();
        args.delete();
        tools.delete();
      }
      const pieces = facesOf(result) as unknown as Shape3D[];
      result.delete();
      const mine = pieces.filter((p) => near(p));
      pieces.filter((p) => !mine.includes(p)).forEach((p) => p.delete());
      // A strip that was never cut — or a piece of it running on past the part's sides — doesn't meet it.
      const size = (p: Shape3D) => {
        const box = p.boundingBox;
        const [a, b] = box.bounds as [Vec3, Vec3];
        box.delete();
        return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
      };
      const runsOn = pieces.length === mine.length || mine.some((p) => size(p) > 0.75 * reach);
      if (runsOn && i >= mustReach) {
        // A corner between strips that don't stop: left out.
        mine.forEach((p) => p.delete());
        return;
      }
      if (runsOn) {
        mine.forEach((p) => p.delete());
        throw new Error(
          isSolid
            ? "An edge's extension never meets that part all along (it runs alongside it, away from it, or past its sides). Pick edges that head straight at the part, choose “Up to a face” (a flat face carries on as its whole plane), or extend by a distance."
            : "An edge's extension never meets that face (it runs alongside it or away from it, or past its edges). Pick edges that head towards it, or extend by a distance.",
        );
      }
      kept.push(...mine);
    });
    return kept;
  } catch (e) {
    release(...kept);
    throw e;
  } finally {
    if (ownTool) tool.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Where the lines p + s·u and q + t·v come closest, if that's ahead along both (and not too far off). */
function meetPoint(p: Vec3, u: Vec3, q: Vec3, v: Vec3, scale: number): Vec3 | null {
  // Least squares for s and t.
  const w: Vec3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const a = u[0] * u[0] + u[1] * u[1] + u[2] * u[2];
  const b = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
  const c = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
  const d = u[0] * w[0] + u[1] * w[1] + u[2] * w[2];
  const e = v[0] * w[0] + v[1] * w[1] + v[2] * w[2];
  const den = a * c - b * b;
  if (Math.abs(den) < 1e-9) return null;
  const s = (b * e - c * d) / den;
  const t = (a * e - b * d) / den;
  if (!(s > 1e-6 && t > 1e-6) || s > 20 * scale || t > 20 * scale) return null;
  const x: Vec3 = [p[0] + u[0] * s, p[1] + u[1] * s, p[2] + u[2] * s];
  const y: Vec3 = [q[0] + v[0] * t, q[1] + v[1] * t, q[2] + v[2] * t];
  if (Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) > 1e-3 * scale) return null;
  return [(x[0] + y[0]) / 2, (x[1] + y[1]) / 2, (x[2] + y[2]) / 2];
}

const take = (v: { x: number; y: number; z: number; delete(): void }): Vec3 => {
  const out: Vec3 = [v.x, v.y, v.z];
  v.delete();
  return out;
};
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/** A solid grown (or, minus, shrunk) by `distance` all over: for hollowing a part closed inside. */
export function offsetSolid(shape: Shape3D, distance: number): Shape3D {
  const { offset: out, builder } = offsetShape(shape, distance, "Couldn't shrink the part for its inside.");
  builder.delete();
  // A closed skin: make it a solid to cut away.
  try {
    const solid = makeSolid([out as never]);
    out.delete();
    return solid;
  } catch {
    return out;
  }
}

/** A point well inside a piece: its centre of mass (a face's centre for a surface piece). */
function insidePoint(piece: Shape3D, surface: boolean): Vec3 {
  if (surface) return take((piece as unknown as Face).center);
  const c = measureShapeVolumeProperties(piece).centerOfMass;
  return [c[0], c[1], c[2]];
}

/**
 * The part (a solid or a surface) cut through by a surface: the pieces on the
 * surface's front side (where its faces point) and on its back. Pieces the
 * surface doesn't reach stay whole, on whichever side they lie.
 */
export function splitBySurface(shape: Shape3D, tool: Shape3D, surface: boolean): { front: Shape3D[]; back: Shape3D[] } {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const splitter = new oc.BRepAlgoAPI_Splitter();
  const args = new oc.NCollection_List_TopoDS_Shape();
  const tools = new oc.NCollection_List_TopoDS_Shape();
  let result: Shape3D;
  try {
    args.Append(shape.wrapped);
    tools.Append(tool.wrapped);
    splitter.SetArguments(args);
    splitter.SetTools(tools);
    splitter.Build();
    if (splitter.HasErrors()) throw new Error("Couldn't split the part with that surface.");
    result = cast(splitter.Shape()) as Shape3D;
  } finally {
    splitter.delete();
    args.delete();
    tools.delete();
  }
  const pieces = surface ? (facesOf(result) as unknown as Shape3D[]) : solidsOf(result);
  result.delete();
  const toolFaces = facesOf(tool);
  const front: Shape3D[] = [];
  const back: Shape3D[] = [];
  try {
    for (const piece of pieces) {
      const p = insidePoint(piece, surface);
      // The nearest point of the surface to the piece, and which way the surface faces there.
      const pnt = new oc.gp_Pnt(p[0], p[1], p[2]);
      const vertex = new oc.BRepBuilderAPI_MakeVertex(pnt);
      let best: { face: Face; at: Vec3; d: number } | null = null;
      try {
        for (const face of toolFaces) {
          const dist = new oc.BRepExtrema_DistShapeShape();
          try {
            dist.LoadS1(vertex.Vertex());
            dist.LoadS2(face.wrapped);
            if (!dist.Perform() || dist.NbSolution() === 0) continue;
            const d = dist.Value();
            if (!best || d < best.d) {
              const q = dist.PointOnShape2(1);
              best = { face, at: [q.X(), q.Y(), q.Z()], d };
              q.delete();
            }
          } finally {
            dist.delete();
          }
        }
      } finally {
        vertex.delete();
        pnt.delete();
      }
      if (!best) {
        back.push(piece);
        continue;
      }
      const n = take(best.face.normalAt(best.at));
      const away: Vec3 = [p[0] - best.at[0], p[1] - best.at[1], p[2] - best.at[2]];
      (away[0] * n[0] + away[1] * n[1] + away[2] * n[2] >= 0 ? front : back).push(piece);
    }
  } finally {
    toolFaces.forEach((f) => f.delete());
  }
  return { front, back };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** Pieces of a split gathered back into one shape: solids as a compound, faces of a surface sewn into a skin. */
export function gathered(pieces: Shape3D[], surface: boolean): Shape3D {
  if (pieces.length === 1) return pieces[0];
  if (surface) {
    const out = sewn(pieces);
    pieces.forEach((p) => p.delete());
    return out;
  }
  return makeCompound(pieces) as Shape3D;
}

/**
 * Ruled surface: a straight strip swept from each edge `distance` along
 * `direction` (a plane's normal), tilted by `angle` degrees across the edge.
 * The strips are sewn together where they share edges.
 */
export function ruledSurface(edges: Edge[], direction: Vec3, distance: number, angle: number): Shape3D {
  if (edges.length === 0) throw new Error("Click the edges to sweep the strips from.");
  if (!(distance > 0)) throw new Error("Distance: enter how far the strips go.");
  const dir = unit(direction);
  const strips: Shape3D[] = [];
  try {
    for (const edge of edges) {
      let v: Vec3 = dir;
      if (Math.abs(angle) > 1e-9) {
        const t = take(edge.tangentAt(0.5));
        const side = unit(cross(t, dir));
        if (Math.hypot(...side) < 1e-6) throw new Error("An edge runs along the direction, so it can't be tilted. Pick a different plane or set the tilt to 0.");
        const rad = (angle * Math.PI) / 180;
        v = [dir[0] * Math.cos(rad) + side[0] * Math.sin(rad), dir[1] * Math.cos(rad) + side[1] * Math.sin(rad), dir[2] * Math.cos(rad) + side[2] * Math.sin(rad)];
      }
      const vec = new Vector([v[0] * distance, v[1] * distance, v[2] * distance]);
      try {
        strips.push(asIs(basicFaceExtrusion(edge as unknown as Face, vec)));
      } catch {
        throw new Error("Couldn't sweep a strip from one of the edges — it may run along the direction. Pick a different plane.");
      } finally {
        vec.delete();
      }
    }
    return strips.length === 1 ? strips.splice(0, 1)[0] : sewn(strips);
  } finally {
    strips.forEach((s) => s.delete());
  }
}

/**
 * Shell built another way, for when OpenCascade's thick solid comes out
 * broken (as it can round fillets): the part hollowed closed inside, then an
 * opening cut through each picked flat face — the inside's matching face
 * pushed straight out through it.
 */
export function shellByCutting(shape: Shape3D, faces: Face[], thickness: number): Shape3D {
  const failed = "Couldn't hollow this part. Try thinner walls — rounded corners and thin areas must be thicker than the walls.";
  if (faces.some((f) => f.geomType !== "PLANE")) throw new Error(failed);
  const inner = offsetSolid(shape, -thickness);
  const tools: Shape3D[] = [inner];
  const innerFaces = facesOf(inner);
  try {
    for (const face of faces) {
      const n = take(face.normalAt());
      const c = take(face.center);
      // The inside's face parallel to this one, a wall's thickness in from it.
      const match = innerFaces.find((f) => {
        if (f.geomType !== "PLANE") return false;
        const m = take(f.normalAt());
        if (m[0] * n[0] + m[1] * n[1] + m[2] * n[2] < 0.9999) return false;
        const q = take(f.center);
        const depth = (c[0] - q[0]) * n[0] + (c[1] - q[1]) * n[1] + (c[2] - q[2]) * n[2];
        return Math.abs(depth - thickness) < 1e-4;
      });
      if (!match) throw new Error(failed);
      const reach = thickness + 1;
      const v = new Vector([n[0] * reach, n[1] * reach, n[2] * reach]);
      try {
        tools.push(asIs(basicFaceExtrusion(match, v)));
      } finally {
        v.delete();
      }
    }
    let cutter = tools[0];
    for (const t of tools.slice(1)) {
      const next = cutter.fuse(t);
      if (cutter !== inner) cutter.delete();
      cutter = next;
    }
    try {
      return shape.cut(cutter);
    } finally {
      if (cutter !== inner) cutter.delete();
    }
  } finally {
    innerFaces.forEach((f) => f.delete());
    tools.forEach((t) => t.delete());
  }
}
