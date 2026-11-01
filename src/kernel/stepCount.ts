import type { StepTree } from "./protocol";

/** How many parts a STEP structure places in all (each copy of a sub-assembly counts its parts again). */
export function stepPartCount(tree: StepTree): number {
  const count = (key: string, seen: string[]): number =>
    seen.includes(key) ? 0 : (tree.assemblies[key]?.components ?? []).reduce((n, c) => n + (c.part ? 1 : c.assembly ? count(c.assembly, [...seen, key]) : 0), 0);
  return count(tree.root, []);
}
