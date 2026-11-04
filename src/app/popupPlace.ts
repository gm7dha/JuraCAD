/**
 * Where to put a small popup (a colour chooser, a tab's menu) so all of it is
 * inside the window (pure). Below what opened it if it fits, else above, else
 * beside it; only when it's taller than the window itself does it get a
 * height to scroll within.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface PopupPlace {
  left: number;
  top: number;
  /** Set only when the popup is taller than the room there is: it scrolls inside. */
  maxHeight?: number;
  side: "below" | "above" | "right" | "left" | "fit";
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * @param anchor what opened it (a point is a box with no size), in window pixels
 * @param size the popup's size
 * @param view the window's size
 * @param gap room between the anchor and the popup
 * @param margin room kept clear at the window's edges
 */
export function placePopup(anchor: Box, size: { width: number; height: number }, view: { width: number; height: number }, gap = 4, margin = 8): PopupPlace {
  const { width: w, height: h } = size;
  const maxLeft = Math.max(margin, view.width - margin - w);
  const maxTop = Math.max(margin, view.height - margin - h);
  const across = clamp(anchor.left, margin, maxLeft);
  // (Kept inside even when what opened it is partly off the window.)
  if (anchor.bottom + gap + h <= view.height - margin) return { left: across, top: clamp(anchor.bottom + gap, margin, maxTop), side: "below" };
  if (anchor.top - gap - h >= margin) return { left: across, top: clamp(anchor.top - gap - h, margin, maxTop), side: "above" };
  // Not enough room above or below: beside it, as high as fits.
  const tall = h > view.height - 2 * margin;
  const down = tall ? margin : clamp(anchor.top, margin, maxTop);
  const extra = tall ? { maxHeight: view.height - 2 * margin } : {};
  if (anchor.right + gap + w <= view.width - margin) return { left: anchor.right + gap, top: down, side: "right", ...extra };
  if (anchor.left - gap - w >= margin) return { left: anchor.left - gap - w, top: down, side: "left", ...extra };
  // Nowhere clear of it: over it, inside the window.
  return { left: across, top: down, side: "fit", ...extra };
}
