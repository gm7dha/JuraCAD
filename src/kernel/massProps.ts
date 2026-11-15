/**
 * Mass properties and closest points, exactly from the solid model (OpenCascade's GProp and
 * BRepExtrema), never from the display mesh.
 */
import { getOC, measureShapeSurfaceProperties, measureShapeVolumeProperties, type AnyShape, type Shape3D } from "replicad";

import type { PartMassProps } from "../model/massProps";

type Vec3 = [number, number, number];

/** One part's volume, surface area, centre of mass (of the solid; of the skin for a surface) and box. */
export function massPropsOf(id: string, name: string, shape: Shape3D, surface: boolean): PartMassProps {
  const area = measureShapeSurfaceProperties(shape);
  let areaValue = 0;
  let centre: Vec3 = [0, 0, 0];
  try {
    areaValue = area.area;
    centre = area.centerOfMass;
  } finally {
    area.delete();
  }
  let volume = 0;
  if (!surface) {
    const vol = measureShapeVolumeProperties(shape);
    try {
      volume = vol.volume;
      // A solid's centre of mass is its volume's; only an empty one falls back to its skin's.
      if (Math.abs(volume) > 1e-12) centre = vol.centerOfMass;
    } finally {
      vol.delete();
    }
  }
  const box = shape.boundingBox;
  const b = box.bounds as [Vec3, Vec3];
  box.delete();
  return { partId: id, name, volume: Math.abs(volume), area: areaValue, centre, box: [[...b[0]], [...b[1]]], ...(surface ? { surface: true } : {}) };
}

/** The shortest distance between two shapes and the two points it runs between (null if it can't be found). */
export function closestPoints(a: AnyShape, b: AnyShape): { distance: number; a: Vec3; b: Vec3 } | null {
  const oc = getOC();
  const tool = new oc.BRepExtrema_DistShapeShape();
  try {
    tool.LoadS1(a.wrapped);
    tool.LoadS2(b.wrapped);
    tool.Perform();
    if (!tool.IsDone() || tool.NbSolution() < 1) return null;
    const p = tool.PointOnShape1(1);
    const q = tool.PointOnShape2(1);
    const out = { distance: tool.Value(), a: [p.X(), p.Y(), p.Z()] as Vec3, b: [q.X(), q.Y(), q.Z()] as Vec3 };
    p.delete();
    q.delete();
    return out;
  } catch {
    return null;
  } finally {
    tool.delete();
  }
}
