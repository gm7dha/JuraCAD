/**
 * Sending a design to a slicer. A web page can't start another program with a
 * file: the slicers' own "open" links (bambustudio://open?file=…,
 * prusaslicer://open?file=…, orcaslicer://open?file=…) only take a web
 * address (https) that the slicer then downloads itself — Bambu Studio asks
 * before opening one from a site it doesn't know, and PrusaSlicer only
 * downloads from sites Prusa has approved (Printables). A design made in the
 * browser has no such address, so the 3MF is saved to Downloads and these
 * steps say how to open it.
 */

export type SlicerId = "bambu" | "prusa" | "orca" | "other";

export interface Slicer {
  id: SlicerId;
  name: string;
  /** How to open the saved file in it. */
  steps: string[];
}

export const SLICERS: Slicer[] = [
  {
    id: "bambu",
    name: "Bambu Studio",
    steps: [
      "Open Bambu Studio.",
      "Drag the file from your Downloads folder into its window — or use File › Import (Ctrl+I, ⌘I on a Mac).",
      "Pick your printer and filament, then press Slice plate.",
    ],
  },
  {
    id: "prusa",
    name: "PrusaSlicer",
    steps: [
      "Open PrusaSlicer.",
      "Drag the file from your Downloads folder into its window — or use File › Import (Ctrl+I, ⌘I on a Mac).",
      "Pick your printer and filament on the right, then press Slice now.",
    ],
  },
  {
    id: "orca",
    name: "OrcaSlicer",
    steps: [
      "Open OrcaSlicer.",
      "Drag the file from your Downloads folder into its window — or use File › Import (Ctrl+I, ⌘I on a Mac).",
      "Pick your printer and filament, then press Slice plate.",
    ],
  },
  {
    id: "other",
    name: "Another slicer",
    steps: [
      "Open your slicer (Cura, Creality Print, ElegooSlicer…).",
      "Drag the file from your Downloads folder into its window, or use its File › Open or Import.",
    ],
  },
];

export function slicerById(id: string | undefined): Slicer {
  return SLICERS.find((s) => s.id === id) ?? SLICERS[0];
}

/** What to tell the user once the file is saved. */
export function sentMessage(slicer: Slicer, fileName: string, onBed: number, offBed: number): string[] {
  const lines = [
    `Saved ${fileName} to your Downloads folder. Browsers can't open other programs with a file, so open it in ${slicer.id === "other" ? "your slicer" : slicer.name} yourself:`,
    ...slicer.steps.map((s, i) => `${i + 1}. ${s}`),
    onBed === 1 ? "The part is already the right way up and on the plate." : `The ${onBed} parts are already the right way up and laid out on the plate, each as its own object with its name.`,
  ];
  if (offBed) lines.push(`${offBed === 1 ? "One part doesn't" : `${offBed} parts don't`} fit on the plate and ${offBed === 1 ? "sits" : "sit"} beside it — print ${offBed === 1 ? "it" : "them"} separately.`);
  lines.push("Tip: double-clicking a .3mf file also opens it, in whichever slicer your computer uses for 3MF files.");
  return lines;
}
