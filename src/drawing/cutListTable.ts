/**
 * Cut list table on a drawing sheet (Onshape's Cut list table): a note with `cutList` is drawn as a table of the frame
 * members' lengths — item, how many, profile, cut length and end cuts — worked out afresh from the parts each time the
 * sheet is laid out, with a total line per profile. Which members: the Part Studio of the sheet's part (or the one the
 * note names), or every copy of a frame member in the sheet's assembly. Pure; drawn by sheet.ts's tablePrims.
 */
import type { PartMesh } from "../kernel/protocol";
import { cutList, type CutListPart } from "../model/frame";
import type { Drawing, DrawingNote } from "../model/types";
import { findMesh } from "../assembly/configured";

/** The heading row. */
export const CUT_LIST_HEADING = ["Item", "Qty", "Profile", "Length (mm)", "End cuts"];

/** What the table says when there's nothing to list. */
export const NO_MEMBERS = "No frame members";

/** The cut list's rows for a list of parts (a part listed twice = two pieces), heading first, then totals per profile. */
export function cutListRows(parts: CutListPart[]): string[][] {
  const list = cutList(parts);
  if (!list.rows.length) return [CUT_LIST_HEADING, ["", "", NO_MEMBERS, "", ""]];
  return [
    CUT_LIST_HEADING,
    ...list.rows.map((r, i) => [String(i + 1), String(r.quantity), r.profile, `${r.length.toFixed(1)}${r.curved ? " (along the curve)" : ""}`, r.ends]),
    ...list.totals.map((t) => ["", String(t.quantity), `${t.profile} in all`, t.length.toFixed(1), ""]),
  ];
}

/** Which Part Studio a sheet's cut list shows: the note's own choice, else the studio of the sheet's part. */
export function cutListStudio(note: Pick<DrawingNote, "cutList">, page: Pick<Drawing, "source">, parts: PartMesh[]): string | undefined {
  if (note.cutList?.studio) return note.cutList.studio;
  const src = page.source;
  if (src?.kind === "part") return parts.find((p) => p.id === src.id)?.studioId;
  return undefined;
}

/**
 * The rows of a sheet's cut list table: the Part Studio's frame members (see cutListStudio), or — for an assembly
 * sheet with no studio named — one piece per copy of a frame member in it (`instancePartIds`, the copies drawn).
 */
export function sheetCutList(page: Pick<Drawing, "source" | "notes">, parts: PartMesh[], instancePartIds?: string[]): string[][] | undefined {
  const note = (page.notes ?? []).find((n) => n.cutList);
  if (!note) return undefined;
  const studio = cutListStudio(note, page, parts);
  const of = (p: PartMesh): CutListPart => ({ id: p.id, name: p.name, ...(p.frame ? { frame: p.frame } : {}) });
  if (studio) return cutListRows(parts.filter((p) => p.studioId === studio && p.frame && !p.configuration).map(of));
  if (page.source?.kind === "assembly" && instancePartIds) {
    return cutListRows(
      instancePartIds.flatMap((id) => {
        const p = findMesh(parts, id);
        return p?.frame ? [of(p)] : [];
      }),
    );
  }
  return cutListRows([]);
}

/** A new cut list table note at `at` (sheet mm, its top-left corner). */
export function cutListNote(id: string, at: [number, number], studio?: string): DrawingNote {
  return { id, at, text: "Cut list", cutList: studio ? { studio } : {} };
}
