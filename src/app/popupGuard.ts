/**
 * Whether a key press belongs to a popup rather than the 3D view, so the
 * global shortcuts (P, F, Delete, Shift+S…) leave it alone.
 *
 * - While any centred dialog box (`Modal`: Help, Export, Live with Claude,
 *   Install as an app…) is open, wherever the key was pressed. Some of these
 *   aren't tracked by the store's `dialog`, so the page itself is asked.
 * - When the key was pressed inside a smaller popup (the Settings menu, a part
 *   colour picker): anything with role="dialog" except the feature-dialog
 *   panels (such as Insert parts), whose keys (Escape) the shortcuts handle.
 */

interface ClosestLike {
  closest?: (selector: string) => unknown;
}

interface PageLike {
  querySelector: (selector: string) => unknown;
}

/** An open dialog box (Modal). */
export const MODAL_SELECTOR = '[aria-modal="true"]';
/** A popup a key was pressed in (feature-dialog panels excepted). */
export const POPUP_SELECTOR = '[role="dialog"]:not(.feature-dialog), [aria-modal="true"]';

export function inPopup(target: EventTarget | ClosestLike | null, page: PageLike | undefined): boolean {
  if (page?.querySelector(MODAL_SELECTOR)) return true;
  const el = target as ClosestLike | null;
  return typeof el?.closest === "function" && !!el.closest(POPUP_SELECTOR);
}
