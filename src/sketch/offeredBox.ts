/**
 * What a key does in a dimension's value box (SketchOverlay's DimensionLabel), as in Onshape. Pure, so it's tested
 * without React (tests/offeredBox).
 *
 * A size *offered* just after drawing (SketchSession.provisional) is kept once a value is typed in its box and
 * confirmed with Tab or Enter — even the size it already had; Tab without typing just moves on. Enter closes the
 * offering (the sizes not kept go); Esc drops what's offered and also ends a chain of lines (sketchEscape). While
 * nothing has been typed yet, a letter that can't start what's typed there (a number, a variable's name, pi) goes to
 * the sketch's tool keys instead (L, C, R…).
 */

export type BoxKeyAction =
  /** Keep the value (typed or as it is), then go on to the next size offered. */
  | "keepNext"
  /** Keep the value and close the box (Enter; and Tab on the last size offered). */
  | "keepClose"
  /** On to the next size offered without keeping this one (Tab with nothing typed). */
  | "skipNext"
  /** Nothing (Tab with nothing typed on the only size offered: it stays open). */
  | "stay"
  /** Esc in an offered size's box: drop what's offered and end the drawing (as Esc with no box open). */
  | "escape"
  /** Esc in a dimension's own box: close it, unchanged. */
  | "cancel"
  /** Not for the box: a tool's key, passed on to the sketch's shortcuts. */
  | "shortcut";

export interface BoxKey {
  key: string;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}

export interface BoxState {
  /** The box is for a size offered just after drawing. */
  offered: boolean;
  /** Something has been typed in the box since it opened. */
  typed: boolean;
  /** Another size is offered for Tab to go on to. */
  hasNext: boolean;
}

/** Can a sum typed in a size box start with this letter: a variable's name, or pi? (Case doesn't matter.) */
export function couldStartName(letter: string, names: readonly string[]): boolean {
  const l = letter.toLowerCase();
  return l === "p" || names.some((n) => n.toLowerCase().startsWith(l));
}

/** What the key does (null: the box's own, typing as usual). `names`: the design's variables. */
export function offeredBoxKey(k: BoxKey, box: BoxState, names: readonly string[]): BoxKeyAction | null {
  if (k.key === "Escape") return box.offered ? "escape" : "cancel";
  if (k.key === "Enter") return "keepClose";
  if (k.key === "Tab") {
    if (!box.offered) return null;
    if (box.typed) return box.hasNext ? "keepNext" : "keepClose";
    return box.hasNext ? "skipNext" : "stay";
  }
  if (box.offered && !box.typed && !k.ctrl && !k.alt && !k.meta && /^[a-z]$/i.test(k.key) && !couldStartName(k.key, names)) return "shortcut";
  return null;
}
