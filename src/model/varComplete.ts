import { FUNCTION_NAMES } from "./expr";

/**
 * Variable names (and functions, as "sin(") offered while typing a size (Onshape's autocomplete in a dimension box): the word being typed at
 * the cursor, the variables that match it, and the text with the chosen one put in. Pure.
 */

export interface TypedWord {
  /** Where the word starts and ends in the text. */
  start: number;
  end: number;
  word: string;
}

/** The name-like word the cursor is in or just after (letters, digits, _; not starting with a digit), or null. */
export function wordAt(text: string, caret: number): TypedWord | null {
  const at = Math.max(0, Math.min(caret, text.length));
  let start = at;
  while (start > 0 && /[A-Za-z0-9_]/.test(text[start - 1])) start--;
  let end = at;
  while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) end++;
  const word = text.slice(start, end);
  if (!word || !/^[A-Za-z_]/.test(word)) return null;
  return { start, end, word };
}

/**
 * Variable names that fit what's being typed: those starting with it first, then those containing it, each in
 * the order given; nothing when the word is already exactly one name and nothing longer starts with it.
 */
export function variableMatches(word: string, names: readonly string[], most = 6): string[] {
  const w = word.toLowerCase();
  if (!w) return [];
  const starts = names.filter((n) => n.toLowerCase().startsWith(w));
  const contains = names.filter((n) => !n.toLowerCase().startsWith(w) && n.toLowerCase().includes(w));
  const all = [...starts, ...contains];
  if (all.length === 1 && all[0] === word) return [];
  return all.slice(0, most);
}

/**
 * Functions that fit what's being typed, as "sin(" (just "sin" when a bracket follows already): only those starting
 * with it, and none where the word follows a number or a closing bracket (it's a unit there: "5 m", "1 in").
 */
export function functionMatches(text: string, word: TypedWord, most = 6): string[] {
  const w = word.word.toLowerCase();
  if (/[0-9.)"]\s*$/.test(text.slice(0, word.start))) return [];
  const bracket = text[word.end] === "(";
  return FUNCTION_NAMES.filter((f) => f.startsWith(w) && !(bracket && f === w))
    .map((f) => (bracket ? f : `${f}(`))
    .slice(0, most);
}

/** What to offer at the cursor (empty when nothing fits): matching variables first, then functions. */
export function suggestionsAt(text: string, caret: number, names: readonly string[], most = 6): { word: TypedWord | null; names: string[] } {
  const word = wordAt(text, caret);
  if (!word) return { word, names: [] };
  const vars = variableMatches(word.word, names, most);
  const fns = functionMatches(text, word, most).filter((f) => !vars.includes(f));
  return { word, names: [...vars, ...fns].slice(0, most) };
}

/** The text with the word at the cursor replaced by `name`, and where the cursor goes (just after it). */
export function completeWith(text: string, word: TypedWord, name: string): { text: string; caret: number } {
  const next = text.slice(0, word.start) + name + text.slice(word.end);
  return { text: next, caret: word.start + name.length };
}
