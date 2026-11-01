/**
 * Which views a drawing sheet shows while its views are being worked out
 * (pure, so it's tested without React). The sheet keeps showing its own last
 * views while new ones are made — but never another sheet's: the component
 * stays mounted when you switch sheets or drawings, and for a moment (or for
 * the whole time the new sheet's views are being made) it would otherwise lay
 * the other sheet's views out on this one, and save or dimension those.
 */
export interface ProjectionState<T> {
  /** The sheet (cache id) `result` belongs to. */
  cacheId: string;
  result: T | null;
}

/**
 * What to show for sheet `cacheId`: its views as they are now (`fresh`, from
 * the cache) if there, else its own last ones; and whether those are up to date.
 */
export function chooseProjections<T>(state: ProjectionState<T>, cacheId: string, fresh: T | null): { base: T | null; upToDate: boolean } {
  const mine = state.cacheId === cacheId ? state.result : null;
  return { base: fresh ?? mine, upToDate: !!fresh && (mine === null || mine === fresh) };
}
