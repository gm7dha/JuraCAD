/**
 * The Design library's tabs (pure): its two kinds of design (Laser cutting, 3D printing) and, after them, "Map puzzles" —
 * the Mountain, Photo relief and Island puzzle windows, kept behind a light password lock (`puzzleLock.ts`).
 */
import { categoryFrom, LIBRARY_CATEGORIES } from "./insert";
import type { DesignCategory } from "./types";

/** A tab of the library: a kind of design, or the map puzzles. */
export type LibrarySection = DesignCategory | "maps";

export interface SectionInfo {
  id: LibrarySection;
  label: string;
  blurb: string;
  /** Shown only once the password has been typed (in this browser). */
  locked?: boolean;
}

/** The tabs, in the order shown. */
export const LIBRARY_SECTIONS: readonly SectionInfo[] = [
  ...LIBRARY_CATEGORIES,
  {
    id: "maps",
    label: "Map puzzles",
    blurb: "Real mountains and islands — or any picture — made into 3D printed puzzles. Each opens its own window and makes print plates.",
    locked: true,
  },
];

/** A tab's id from text (a remembered tab), or null if it isn't one. */
export function sectionFrom(raw: unknown): LibrarySection | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase();
  return LIBRARY_SECTIONS.find((s) => s.id === t || s.label.toLowerCase() === t)?.id ?? categoryFrom(t);
}

export const sectionLabel = (s: LibrarySection) => LIBRARY_SECTIONS.find((x) => x.id === s)!.label;

/** Whether a tab needs the password. */
export const sectionLocked = (s: LibrarySection) => LIBRARY_SECTIONS.find((x) => x.id === s)?.locked === true;
