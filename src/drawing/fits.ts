/**
 * Limits and fits (ISO 286): a size's tolerance given as a class such as H7
 * (a hole) or g6 (a shaft), or a fit between the two, "H7/g6". The letter
 * says where the tolerance band sits (H: starting at the size, upwards; g:
 * just below it), the number how wide it is (the IT grade).
 *
 * The common classes are covered: holes D, E, F, G, H and JS, shafts d, e, f,
 * g, h, js, k, m, n and p, grades 5 to 11, sizes up to 500 mm. Values are the
 * standard's tables, in micrometres.
 */

/** Upper ends of the size steps (mm): over the one before, up to and including this. */
const STEPS = [3, 6, 10, 18, 30, 50, 80, 120, 180, 250, 315, 400, 500];

/** Tolerance band widths (µm) for each IT grade and size step. */
const IT: Record<number, number[]> = {
  5: [4, 5, 6, 8, 9, 11, 13, 15, 18, 20, 23, 25, 27],
  6: [6, 8, 9, 11, 13, 16, 19, 22, 25, 29, 32, 36, 40],
  7: [10, 12, 15, 18, 21, 25, 30, 35, 40, 46, 52, 57, 63],
  8: [14, 18, 22, 27, 33, 39, 46, 54, 63, 72, 81, 89, 97],
  9: [25, 30, 36, 43, 52, 62, 74, 87, 100, 115, 130, 140, 155],
  10: [40, 48, 58, 70, 84, 100, 120, 140, 160, 185, 210, 230, 250],
  11: [60, 75, 90, 110, 130, 160, 190, 220, 250, 290, 320, 360, 400],
};

/** Shafts above the size (d–g, h): the band's top (es, µm, ≤ 0). */
const UPPER: Record<string, number[]> = {
  d: [-20, -30, -40, -50, -65, -80, -100, -120, -145, -170, -190, -210, -230],
  e: [-14, -20, -25, -32, -40, -50, -60, -72, -85, -100, -110, -125, -135],
  f: [-6, -10, -13, -16, -20, -25, -30, -36, -43, -50, -56, -62, -68],
  g: [-2, -4, -5, -6, -7, -9, -10, -12, -14, -15, -17, -18, -20],
  h: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
};
/** Shafts bigger than the size (k–p): the band's bottom (ei, µm, ≥ 0). k's is for grades 4 to 7 (0 otherwise). */
const LOWER: Record<string, number[]> = {
  k: [0, 1, 1, 1, 2, 2, 2, 3, 3, 4, 4, 4, 5],
  m: [2, 4, 6, 7, 8, 9, 11, 13, 15, 17, 20, 21, 23],
  n: [4, 8, 10, 12, 15, 17, 20, 23, 27, 31, 34, 37, 40],
  p: [6, 12, 15, 18, 22, 26, 32, 37, 43, 50, 56, 62, 68],
};

export const HOLE_LETTERS = ["D", "E", "F", "G", "H", "JS"];
export const SHAFT_LETTERS = ["d", "e", "f", "g", "h", "js", "k", "m", "n", "p"];

/** One tolerance class, e.g. { letter: "H", grade: 7, hole: true }. */
export interface ToleranceClass {
  letter: string;
  grade: number;
  hole: boolean;
}

/** A class or fit as typed: "H7", "g6", "H7/g6" (spaces ignored). */
export interface FitClass {
  hole?: ToleranceClass;
  shaft?: ToleranceClass;
}

/** What a class means for a size: how far above (+) or below (−) the size each end of the band is (mm). */
export interface Deviation {
  upper: number;
  lower: number;
}

const KNOWN = "Use a hole class (capital letter: D, E, F, G, H or JS) or a shaft class (small letter: d to h, js, k, m, n or p) and a grade from 5 to 11, e.g. H7, g6 or H7/g6.";

function readClass(text: string): ToleranceClass | string {
  const m = /^([A-Za-z]{1,2})(\d{1,2})$/.exec(text);
  if (!m) return `"${text}" isn't a tolerance class. ${KNOWN}`;
  const [, letter, g] = m;
  const grade = Number(g);
  const hole = letter === letter.toUpperCase();
  const list = hole ? HOLE_LETTERS : SHAFT_LETTERS;
  if (!list.includes(letter)) return `JuraCAD doesn't know the ${hole ? "hole" : "shaft"} letter "${letter}" yet. ${KNOWN}`;
  if (!IT[grade]) return `Grade ${grade} isn't covered (5 to 11 are). ${KNOWN}`;
  return { letter, grade, hole };
}

/** Read a class or fit ("H7", "g6", "H7/g6"), or say what's wrong with it. */
export function parseFitClass(raw: string): FitClass | { error: string } {
  const text = raw.replace(/\s+/g, "");
  if (!text) return { error: `Type a class. ${KNOWN}` };
  const parts = text.split("/");
  if (parts.length > 2) return { error: `Give at most a hole class and a shaft class, e.g. H7/g6.` };
  const read = parts.map(readClass);
  const bad = read.find((x): x is string => typeof x === "string");
  if (bad) return { error: bad };
  const [a, b] = read as ToleranceClass[];
  if (!b) return a.hole ? { hole: a } : { shaft: a };
  if (!a.hole || b.hole) return { error: `A fit is written hole first (capital letter), then shaft (small letter), e.g. H7/g6.` };
  return { hole: a, shaft: b };
}

/** The class as written: "H7". */
export const classText = (c: ToleranceClass) => `${c.letter}${c.grade}`;

/** How far each end of a class's band is from the size (mm), or why it can't be worked out. */
export function deviation(size: number, c: ToleranceClass): Deviation | { error: string } {
  if (!(size > 0)) return { error: "The size has to be more than 0." };
  if (size > 500) return { error: "Limits and fits tables here go up to 500 mm." };
  const step = STEPS.findIndex((top) => size <= top + 1e-9);
  const it = IT[c.grade][step];
  const letter = c.letter.toLowerCase();
  let upper: number;
  let lower: number;
  if (letter === "js") {
    upper = it / 2;
    lower = -it / 2;
  } else if (UPPER[letter]) {
    const es = UPPER[letter][step];
    // A hole's band is the shaft's turned over: G sits as far above as g sits below.
    if (c.hole) {
      lower = -es;
      upper = lower + it;
    } else {
      upper = es;
      lower = es - it;
    }
  } else {
    const ei = letter === "k" && (c.grade < 4 || c.grade > 7) ? 0 : LOWER[letter][step];
    lower = ei;
    upper = ei + it;
  }
  return { upper: upper / 1000, lower: lower / 1000 };
}

/** The biggest and smallest sizes a class allows (mm), or why it can't be worked out. */
export function limitSizes(size: number, c: ToleranceClass): { max: number; min: number } | { error: string } {
  const d = deviation(size, c);
  return "error" in d ? d : { max: size + d.upper, min: size + d.lower };
}
