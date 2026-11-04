/**
 * Browsing the Design library: designs in smaller groups within a section ("Fixings", "Hinges"…), and a search over
 * every design's name, description and group. Pure, so the library window and its tests share it.
 */
import { categoryLabel, LIBRARY } from "./insert";
import type { LibraryDesign } from "./types";

/** The groups, in the order they're shown; any other group comes after them, and designs without one last. */
export const LIBRARY_GROUPS: readonly string[] = ["Fixings", "Hinges", "Storage", "Household", "Workshop"];
/** The heading for designs without a group, in a section where others have one. */
export const OTHER_GROUP = "More";

export interface DesignGroup {
  /** The group's name, or null when no design in the list has a group (shown without headings). */
  group: string | null;
  designs: LibraryDesign[];
}

/** The designs in groups, in the groups' order (each group's designs in the library's order). */
export function groupDesigns(designs: readonly LibraryDesign[]): DesignGroup[] {
  if (!designs.some((d) => d.group)) return designs.length ? [{ group: null, designs: [...designs] }] : [];
  const rank = (g: string) => (LIBRARY_GROUPS.includes(g) ? LIBRARY_GROUPS.indexOf(g) : g === OTHER_GROUP ? Infinity : LIBRARY_GROUPS.length);
  const names = [...new Set(designs.map((d) => d.group ?? OTHER_GROUP))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names.map((group) => ({ group, designs: designs.filter((d) => (d.group ?? OTHER_GROUP) === group) }));
}

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .split(/[^a-z0-9.]+/)
    .filter(Boolean);

/**
 * The designs matching what was typed: every word typed must start a word of the design's name, group, section or
 * description ("bolt", "hing", "M8"…). Matches in the name come first. Nothing typed = nothing found.
 */
export function searchDesigns(query: string, designs: readonly LibraryDesign[] = LIBRARY): LibraryDesign[] {
  const wanted = words(query);
  if (!wanted.length) return [];
  const scored = designs.flatMap((d) => {
    const name = words(d.name);
    const all = [...name, ...words(d.group ?? ""), ...words(categoryLabel(d.category)), ...words(d.description)];
    if (!wanted.every((w) => all.some((x) => x.startsWith(w)))) return [];
    const inName = wanted.filter((w) => name.some((x) => x.startsWith(w))).length;
    return [{ d, inName }];
  });
  return scored.sort((a, b) => b.inName - a.inName).map((s) => s.d);
}
