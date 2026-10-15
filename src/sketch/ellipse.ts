/**
 * Ellipses: a centre, a point at the end of the long (major) axis and a point
 * at the end of the short (minor) axis. The solver keeps the two axes square to
 * each other, so dragging either point stretches or turns the ellipse.
 */
type Pt = [number, number];

export interface EllipseGeom {
  centre: Pt;
  /** Half-length along the axis through the "major" point. */
  rx: number;
  /** Half-length along the other axis. */
  ry: number;
  /** Direction of the "major" axis (radians). */
  angle: number;
}

export function ellipseFrom(centre: Pt, major: Pt, minor: Pt): EllipseGeom {
  const dx = major[0] - centre[0];
  const dy = major[1] - centre[1];
  return { centre, rx: Math.hypot(dx, dy), ry: Math.hypot(minor[0] - centre[0], minor[1] - centre[1]), angle: Math.atan2(dy, dx) };
}

/** A point on the ellipse at parameter t (0…2π). */
export function ellipseAt(g: EllipseGeom, t: number): Pt {
  const c = Math.cos(g.angle);
  const s = Math.sin(g.angle);
  const x = g.rx * Math.cos(t);
  const y = g.ry * Math.sin(t);
  return [g.centre[0] + x * c - y * s, g.centre[1] + x * s + y * c];
}

/** The ellipse as short straight pieces, anticlockwise; the last point repeats the first. */
export function ellipsePolyline(g: EllipseGeom, steps = 64): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= steps; i++) out.push(ellipseAt(g, (2 * Math.PI * i) / steps));
  return out;
}

/** Where the minor-axis point goes for a third click at `p`: square to the major axis, as far out as p is from that axis. */
export function minorPointFor(centre: Pt, major: Pt, p: Pt): Pt {
  const dx = major[0] - centre[0];
  const dy = major[1] - centre[1];
  const l = Math.hypot(dx, dy) || 1;
  const nx = -dy / l;
  const ny = dx / l;
  const d = (p[0] - centre[0]) * nx + (p[1] - centre[1]) * ny;
  return [centre[0] + nx * d, centre[1] + ny * d];
}
