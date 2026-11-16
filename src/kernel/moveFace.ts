/**
 * Move face (Onshape's Offset / Translate / Rotate types) on a solid part.
 *
 * Offset and Translate add (or cut) the room the face sweeps through as it moves: a flat face is pushed along
 * its normal (Offset) or the chosen direction (Translate); a curved face's room is the solid between it and its
 * parallel copy (OpenCascade's simple thick solid), so a hole's wall moved in grows the hole exactly and a boss's
 * wall moved out grows the boss. The faces round it carry on to meet the moved face exactly where they're square to
 * it (or, Translate, lie along the direction) — the usual case — and a warning says so when they aren't.
 *
 * Rotate turns flat faces about an axis with OpenCascade's draft (the same tool Draft uses), which re-trims the faces
 * round each one properly: the turned plane is reached by leaning the face about the line where it meets its turned
 * self (`rotationPivot`).
 */
import { asDir, basicFaceExtrusion, cast, getOC, makeBox, makePln, makeSphere, measureArea, measureVolume, Vector, type Face, type Shape3D } from "replicad";
import { rotationPivot } from "../model/moveFace";
import { facesOf, edgesOf, solidsOf } from "./topology";

type Vec3 = [number, number, number];

const take = (v: Vector): Vec3 => {
  const out: Vec3 = [v.x, v.y, v.z];
  v.delete();
  return out;
};
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** A plain-English reason the move can't be made (shown on the feature as it is). */
export class MoveFaceError extends Error {}

/** Where a face sits: a point on it (its middle in its own parameters) and which way it faces there. */
function faceSpot(face: Face): { p: Vec3; n: Vec3 } {
  const p = take(face.pointOnSurface(0.5, 0.5));
  const n = take(face.normalAt(p));
  return { p, n };
}

/**
 * How far a round face can move before it closes up: a hole's wall (or a ball's inside) by just under its
 * radius out of the material, a boss (or a ball) by just under its radius in. Null for faces with no such limit.
 */
function roundLimit(face: Face): { radius: number; hollow: boolean; centre?: Vec3 } | null {
  const kind = face.geomType;
  if (kind !== "CYLINDRE" && kind !== "SPHERE") return null;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const made: any[] = [];
  try {
    const adaptor = new oc.BRepAdaptor_Surface(face.wrapped, true);
    made.push(adaptor);
    const { p, n } = faceSpot(face);
    if (kind === "CYLINDRE") {
      const cyl = adaptor.Cylinder();
      const ax = cyl.Axis();
      const loc = ax.Location();
      const dir = ax.Direction();
      made.push(cyl, ax, loc, dir);
      const o: Vec3 = [loc.X(), loc.Y(), loc.Z()];
      const a: Vec3 = [dir.X(), dir.Y(), dir.Z()];
      const rel: Vec3 = [p[0] - o[0], p[1] - o[1], p[2] - o[2]];
      const h = dot(rel, a);
      const radial: Vec3 = [rel[0] - a[0] * h, rel[1] - a[1] * h, rel[2] - a[2] * h];
      return { radius: cyl.Radius(), hollow: dot(radial, n) < 0 };
    }
    const sph = adaptor.Sphere();
    const loc = sph.Location();
    made.push(sph, loc);
    const rel: Vec3 = [p[0] - loc.X(), p[1] - loc.Y(), p[2] - loc.Z()];
    return { radius: sph.Radius(), hollow: dot(rel, n) < 0, centre: [loc.X(), loc.Y(), loc.Z()] };
  } catch {
    return null;
  } finally {
    made.forEach((x) => x?.delete?.());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** The solid a face sweeps through moving `d` along its own normal (out of the part for d > 0), with its volume. */
function offsetRoom(face: Face, d: number): Shape3D {
  if (face.geomType === "PLANE") {
    const n = take(face.normalAt());
    return basicFaceExtrusion(face, new Vector([n[0] * d, n[1] * d, n[2] * d])) as Shape3D;
  }
  const limit = roundLimit(face);
  if (limit) {
    const across = round2(2 * limit.radius);
    const closing = limit.hollow ? d : -d;
    if (closing >= limit.radius - 1e-6) {
      throw new MoveFaceError(
        limit.hollow
          ? `That would close the hole up: it's ${across} mm across, so it can move in by less than ${round2(limit.radius)} mm.`
          : `That would shrink the round face to nothing: it's ${across} mm across, so it can move in by less than ${round2(limit.radius)} mm.`,
      );
    }
  }
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  // A whole ball (a sphere or a round cavity): OpenCascade can't thicken a closed sphere face, so its room is the
  // shell between the two balls.
  if (limit?.centre && Math.abs(measureArea(face) - 4 * Math.PI * limit.radius ** 2) < 1e-6 * limit.radius ** 2) {
    const r2 = limit.hollow ? limit.radius - d : limit.radius + d;
    const outer = makeSphere(Math.max(limit.radius, r2)).translate(limit.centre);
    const inner = makeSphere(Math.min(limit.radius, r2)).translate(limit.centre);
    const shell = outer.cut(inner) as Shape3D;
    outer.delete();
    inner.delete();
    return shell;
  }
  const mk = new oc.BRepOffsetAPI_MakeThickSolid();
  try {
    mk.MakeThickSolidBySimple(face.wrapped, d);
    if (!mk.IsDone()) throw new MoveFaceError("That face can't be moved that far — try a smaller distance.");
    const made = cast(mk.Shape()) as Shape3D;
    const solids = solidsOf(made);
    made.delete();
    if (solids.length !== 1) {
      solids.forEach((x) => x.delete());
      throw new MoveFaceError("That face can't be moved that far — try a smaller distance.");
    }
    let solid = solids[0];
    // Moved out of the part the room comes back inside out: turn it the right way round.
    if (measureVolume(solid) < 0) {
      const turned = oc.TopoDS.Solid(solid.wrapped);
      oc.BRepLib.OrientClosedSolid(turned);
      solid.delete();
      solid = cast(turned) as Shape3D;
    }
    if (!(measureVolume(solid) > 1e-12)) {
      solid.delete();
      throw new MoveFaceError("That face can't be moved that far — try a smaller distance.");
    }
    return solid;
  } finally {
    mk.delete();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

/** `shape` with `room` added. OpenCascade's fuse sometimes gives nothing for a room sharing a curved face with the part; then it's done as "everything but (outside − room)". */
function added(shape: Shape3D, room: Shape3D, before: number, roomVolume: number): Shape3D {
  const tol = 1e-6 * Math.max(1, before + roomVolume);
  try {
    const r = shape.fuse(room);
    const v = measureVolume(r);
    if (v > before - tol && v < before + roomVolume + tol && v > tol) return r;
    r.delete();
  } catch {
    // try the other way below
  }
  const b = shape.boundingBox.bounds;
  const c = room.boundingBox.bounds;
  const pad = 10;
  const box = makeBox(
    [Math.min(b[0][0], c[0][0]) - pad, Math.min(b[0][1], c[0][1]) - pad, Math.min(b[0][2], c[0][2]) - pad],
    [Math.max(b[1][0], c[1][0]) + pad, Math.max(b[1][1], c[1][1]) + pad, Math.max(b[1][2], c[1][2]) + pad],
  );
  const outside = box.cut(shape);
  const less = outside.cut(room);
  outside.delete();
  const out = box.cut(less);
  less.delete();
  box.delete();
  return out;
}

export interface FaceMoveResult {
  shape: Shape3D;
  /** Something to tell (built, but not quite as Onshape would). */
  warning?: string;
}

/** For each picked face, whether the faces round it are square to the way it moves (else they don't carry on to meet it exactly). */
function neighbourNote(shape: Shape3D, faces: Face[], dirAt: (face: Face, at: Vec3) => Vec3): string | undefined {
  const all = facesOf(shape);
  let sloping = false;
  let meeting = false;
  try {
    for (const face of faces) {
      const edges = edgesOf(face);
      try {
        for (const e of edges) {
          const mid = take(e.pointAt(0.5));
          for (const other of all) {
            if (other.isSame(face)) continue;
            const shared = edgesOf(other);
            const touches = shared.some((x) => x.isSame(e));
            shared.forEach((x) => x.delete());
            if (!touches) continue;
            if (faces.some((f) => f.isSame(other))) {
              meeting = true;
              continue;
            }
            const nb = take(other.normalAt(mid));
            const s = dirAt(face, mid);
            if (Math.abs(dot(nb, s)) > 0.01) sloping = true;
          }
        }
      } finally {
        edges.forEach((e) => e.delete());
      }
    }
  } finally {
    all.forEach((f) => f.delete());
  }
  const notes: string[] = [];
  if (sloping) notes.push("A face beside a moved face isn't square to the way it moves, so it isn't carried on to meet it — a small step is left there.");
  if (meeting) notes.push("Where two moved faces meet, the corner between them isn't filled in.");
  return notes.length ? notes.join(" ") : undefined;
}

/**
 * Offset (along each face's normal by `d`) or Translate (flat faces along `move`, a vector) the faces of `shape`.
 * Refuses, in plain words, moves that would close a round face up, run into the part's other faces or out through it.
 */
export function moveFacesBy(shape: Shape3D, faces: Face[], how: { offset: number } | { move: Vec3 }): FaceMoveResult {
  const grow: { room: Shape3D; v: number }[] = [];
  const shrink: { room: Shape3D; v: number }[] = [];
  const free = () => [...grow, ...shrink].forEach((x) => x.room.delete());
  // Flat faces' rooms are plain prisms, added and cut exactly as the original Move face did (a top pushed down into a
  // pocket below opens it, as before); only rooms of curved faces (thick solids) are checked by volume.
  let curved = false;
  try {
    for (const face of faces) {
      let room: Shape3D;
      let out: boolean;
      if ("offset" in how) {
        if (Math.abs(how.offset) < 1e-9) continue;
        room = offsetRoom(face, how.offset);
        out = how.offset > 0;
        if (face.geomType !== "PLANE") curved = true;
      } else {
        if (face.geomType !== "PLANE") throw new MoveFaceError("Translate moves flat faces. To make a round face (a hole or a boss) bigger or smaller, use Offset.");
        const n = take(face.normalAt());
        const along = dot(how.move, n);
        if (Math.abs(along) < 1e-9) continue;
        room = basicFaceExtrusion(face, new Vector(how.move)) as Shape3D;
        out = along > 0;
      }
      (out ? grow : shrink).push({ room, v: Math.abs(measureVolume(room)) });
    }
    if (!grow.length && !shrink.length) {
      throw new MoveFaceError("offset" in how ? "Enter a distance to move the faces by." : "In that direction the faces only slide along themselves, so nothing would change. Choose a direction that isn't along the faces.");
    }
    const before = measureVolume(shape);
    let expect = before;
    let result: Shape3D = shape;
    for (const g of grow) {
      const next = added(result, g.room, measureVolume(result), g.v);
      if (result !== shape) result.delete();
      result = next;
      expect += g.v;
    }
    for (const s of shrink) {
      const next = result.cut(s.room);
      if (result !== shape) result.delete();
      result = next;
      expect -= s.v;
    }
    const dirAt = (face: Face, at: Vec3): Vec3 => {
      if ("move" in how) {
        const l = Math.hypot(...how.move);
        return [how.move[0] / l, how.move[1] / l, how.move[2] / l];
      }
      return take(face.normalAt(at));
    };
    const warning = neighbourNote(shape, faces, dirAt);
    const after = measureVolume(result);
    const tol = 1e-6 * Math.max(1, before) + 1e-6;
    if (curved && Math.abs(after - expect) > tol && !warning) {
      const less = shrink.length && after > expect;
      result.delete();
      throw new MoveFaceError(
        less
          ? "That would move a face out through the other side of the part. Use a smaller distance."
          : "That would move a face into another part of the shape. Use a smaller distance.",
      );
    }
    return { shape: result, warning };
  } finally {
    free();
  }
}

/** Turn flat faces of `shape` by `degrees` about the axis through `through` along unit `dir` (right-handed). */
export function rotateFaces(shape: Shape3D, faces: Face[], through: Vec3, dir: Vec3, degrees: number): Shape3D {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const oc = getOC() as any;
  const builder = new oc.BRepOffsetAPI_DraftAngle(shape.wrapped);
  const made: any[] = [];
  try {
    let added = 0;
    for (const face of faces) {
      if (face.geomType !== "PLANE") throw new MoveFaceError("Rotate turns flat faces. Remove the curved face (or use Offset for it).");
      const c = take(face.center);
      const n = take(face.normalAt(c));
      const pivot = rotationPivot(c, n, through, dir, degrees);
      if (typeof pivot === "string") throw new MoveFaceError(pivot);
      if (pivot.tilt >= 80) throw new MoveFaceError("That turns the face too far (it can lean by up to 80°). Use a smaller angle.");
      const pull = asDir(pivot.lean) as any;
      const plane = makePln(pivot.point, pivot.lean) as any;
      made.push(pull, plane);
      builder.Add(face.wrapped, pull, (pivot.tilt * Math.PI) / 180, plane, true);
      if (!builder.AddDone()) throw new MoveFaceError("That face can't be turned that far: the faces round it can't be stretched to meet it. Try a smaller angle.");
      added++;
    }
    if (!added) throw new MoveFaceError("Click the faces to turn.");
    builder.Build();
    if (!builder.IsDone()) throw new MoveFaceError("Those faces can't be turned that far: the faces round them can't be stretched to meet them. Try a smaller angle.");
    return cast(builder.Shape()) as Shape3D;
  } finally {
    builder.delete();
    made.forEach((x) => x.delete());
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */
}
