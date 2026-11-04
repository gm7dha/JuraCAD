/**
 * Searching the Design library: every design's name, description, group and section. Pure, so the library window and
 * its tests share it. (Headings within a section are `designGroups` in insert.ts.)
 */
import { categoryLabel, LIBRARY } from "./insert";
import type { LibraryDesign } from "./types";

const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
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
