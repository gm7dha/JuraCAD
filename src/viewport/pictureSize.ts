/** Pure sums for "Save picture" (SceneManager.savePicture), kept apart from three.js so they can be tested. */

/** The most pixels a picture may have: 4096 × 4096, the largest 2D canvas iPhones and iPads (Safari) allow — still big enough to print. */
export const MAX_PICTURE_PIXELS = 16_777_216;

/**
 * The picture's size in pixels: the view's size (CSS px) times `scale`, kept
 * the same shape, no side longer than `maxSide` (the graphics card's limit)
 * and no more than MAX_PICTURE_PIXELS in all.
 */
export function pictureSize(width: number, height: number, scale: number, maxSide = 8192): { width: number; height: number } {
  const w = Math.max(1, Math.round(width)) * scale;
  const h = Math.max(1, Math.round(height)) * scale;
  const shrink = Math.min(1, maxSide / w, maxSide / h, Math.sqrt(MAX_PICTURE_PIXELS / (w * h)));
  let out = { width: Math.max(1, Math.round(w * shrink)), height: Math.max(1, Math.round(h * shrink)) };
  // Rounding up may tip it just over the limit: round down then.
  if (out.width * out.height > MAX_PICTURE_PIXELS) out = { width: Math.floor(w * shrink), height: Math.floor(h * shrink) };
  return out;
}

/**
 * Whether to draw the soft shadow's ground under the parts: only when the view
 * looks down on them (`towardsEye` points from the model to the camera, Z up) —
 * from the side or below, a ground would cut across the picture.
 */
export function showGround(towardsEye: [number, number, number]): boolean {
  const [x, y, z] = towardsEye;
  const len = Math.hypot(x, y, z) || 1;
  return z / len > 0.15;
}

/**
 * When the browser gives a smaller drawing area than was asked for (it may, for
 * big pictures, without saying so): the biggest size of the same shape that
 * fits in what it gave, or null if nothing sensible fits (under 16 px a side).
 */
export function fitToBuffer(asked: { width: number; height: number }, got: { width: number; height: number }): { width: number; height: number } | null {
  if (got.width >= asked.width && got.height >= asked.height) return asked;
  const k = Math.min(got.width / asked.width, got.height / asked.height);
  const out = { width: Math.floor(asked.width * k), height: Math.floor(asked.height * k) };
  return out.width >= 16 && out.height >= 16 ? out : null;
}

/** For the smallest pictures, how much bigger to draw them before shrinking to size, to smooth the edges (2× up to 2048 a side, else 1×). */
export function supersample(size: { width: number; height: number }): number {
  return Math.max(size.width, size.height) <= 2048 ? 2 : 1;
}
