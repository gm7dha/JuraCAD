/** Framing a model in a small 3D preview (the puzzle windows), pure. */

/**
 * How far from the middle a camera looking back along `dir` (unit, from the middle towards the camera; Z up) must stand
 * for every point (relative to the middle) to be in view: `fov` is the upright view angle in degrees, `aspect` width ÷
 * height. Each point's sideways and upward offsets over its depth must stay within the view's half angles.
 */
export function fitDistance(points: readonly [number, number, number][], dir: [number, number, number], fov: number, aspect: number): number {
  const [dx, dy, dz] = dir;
  // Right = forward × up (forward = −dir, up = Z), then the camera's own up = right × forward.
  let [rx, ry, rz] = [-dy, dx, 0];
  const rl = Math.hypot(rx, ry) || 1;
  [rx, ry, rz] = [rx / rl, ry / rl, rz / rl];
  const [ux, uy, uz] = [ry * -dz - rz * -dy, rz * -dx - rx * -dz, rx * -dy - ry * -dx];
  const tanV = Math.tan((fov * Math.PI) / 360);
  const tanH = tanV * aspect;
  let d = 1e-3;
  for (const [x, y, z] of points) {
    const toward = x * dx + y * dy + z * dz;
    d = Math.max(d, toward + Math.abs(x * rx + y * ry + z * rz) / tanH, toward + Math.abs(x * ux + y * uy + z * uz) / tanV);
  }
  return d;
}
