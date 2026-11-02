/** Pure sums for "Save picture" (SceneManager.savePicture), kept apart from three.js so they can be tested. */

/** The most pixels a picture may have (about 40 megapixels: big enough to print, small enough for any browser). */
export const MAX_PICTURE_PIXELS = 40_000_000;

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
