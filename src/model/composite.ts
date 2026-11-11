/**
 * Composite part: what's wrong with the parts picked, worked out from the
 * parts on show (no build needed) — so the dialog can say it before Accept.
 * The engine's own checks (applyComposite) say the same things.
 */
export interface CompositePartInfo {
  id: string;
  name: string;
  surface?: boolean;
  /** Sheet metal parts carry their flat pattern. */
  flat?: unknown;
}

/** The first problem with these picked parts, in plain words, or null when they can be grouped. */
export function compositeProblem(ids: readonly string[], parts: readonly CompositePartInfo[]): string | null {
  const unique = [...new Set(ids)];
  for (const id of unique) {
    const p = parts.find((x) => x.id === id);
    if (!p) return "One of its parts no longer exists. Leave it out (✕) and pick another.";
    if (p.surface) return `${p.name} is a surface. A composite part is made of solid parts — thicken it first, or leave it out.`;
    if (p.flat) return `${p.name} is sheet metal, which can't go in a composite part yet (its flat pattern couldn't follow).`;
  }
  if (unique.length < 2) return "Pick two or more parts to group into a composite part — in the 3D view or in the Parts list.";
  return null;
}
