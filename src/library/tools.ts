/**
 * Tools in the Design library (pure): cards that open their own window instead of inserting features — the Mountain,
 * Photo relief and Island puzzles, which make print plates rather than a design in the Part Studio. They sit in a section's
 * tab under their own heading, and the library's search finds them like designs.
 */
import { searchWords } from "./browse";
import type { DesignCategory } from "./types";

export interface LibraryTool {
  id: "mountain" | "photo" | "island";
  name: string;
  description: string;
  category: DesignCategory;
  /** The heading it sits under in its tab (before the designs). */
  group: string;
  /** Extra words the search finds it by. */
  words: string;
  /** 48 × 48 drawing, as designs' icons (fixed markup written here, never user data). */
  icon: string;
}

export const LIBRARY_TOOLS: readonly LibraryTool[] = [
  {
    id: "mountain",
    name: "Mountain puzzle",
    description: "A real mountain or Munro as a 3D printed puzzle of interlocking cubes, with snow caps in a second filament.",
    category: "print",
    group: "Puzzles",
    words: "munro hill peak map terrain landscape jigsaw ben nevis snow openstreetmap os grid",
    icon: '<path d="M4 40 18 14l8 13 5-7 13 20z"/><path d="m13.5 23.5 4.5-9.5 4.6 7.5-2.8-1.6-2 1.8-2-1.7z" opacity=".55"/><path d="M4 40h40"/>',
  },
  {
    id: "photo",
    name: "Photo relief puzzle",
    description: "Any picture — a face, a pet, a logo — as a 3D printed puzzle of interlocking cubes, light parts standing high.",
    category: "print",
    group: "Puzzles",
    words: "picture image lithophane portrait relief jigsaw custom gift",
    icon: '<rect x="5" y="9" width="38" height="30" rx="2"/><circle cx="17" cy="20" r="4"/><path d="m5 35 12-9 8 6 7-8 11 11"/>',
  },
  {
    id: "island",
    name: "Island puzzle",
    description: "An island — or all of Great Britain — as a flat jigsaw: the coast is its edge, the hills stand up, and it can be cut along county or parish boundaries.",
    category: "print",
    group: "Puzzles",
    words: "island country county counties map jigsaw coast great britain uk arran skye wight man orkney shetland boundaries parish relief",
    icon: '<path d="M14 8c6-3 13 1 15 6 3-1 7 1 8 5 3 3 1 8-2 9 2 5-2 10-8 10-3 4-10 3-12-1-6 0-9-6-6-10-4-4-1-11 5-12z"/><path d="M24 12c-2 6 4 8 0 14s3 8 0 12M12 22c6 1 8-3 12 0s9 0 12 2" opacity=".55"/>',
  },
];

/** The tools in a section's tab. */
export const toolsIn = (category: DesignCategory) => LIBRARY_TOOLS.filter((t) => t.category === category);

/** Tools matching what was typed: every word typed must start a word of its name, heading, description or extra words. */
export function searchTools(query: string, tools: readonly LibraryTool[] = LIBRARY_TOOLS): LibraryTool[] {
  const wanted = searchWords(query);
  if (!wanted.length) return [];
  return tools.filter((t) => {
    const all = searchWords(`${t.name} ${t.group} ${t.description} ${t.words}`);
    return wanted.every((w) => all.some((x) => x.startsWith(w)));
  });
}
