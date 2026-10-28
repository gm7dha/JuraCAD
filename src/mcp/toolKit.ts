/**
 * What every JuraCAD tool is made of (shared by tools.ts, assemblyTools.ts
 * and drawingTools.ts): the shape of a tool and its result, plain-text
 * replies, and writing files into the chosen folder.
 */
import type { Obj } from "./args";
import { InputError } from "./args";
import type { DesignFolder } from "./files";
import type { Session } from "./session";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
export interface ToolResult {
  content: Content[];
  isError?: boolean;
}

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Only looks; changes nothing. */
  readOnly?: boolean;
  /** Can replace a file, or drop the design being worked on. */
  destructive?: boolean;
  run: (s: Session, a: Obj) => ToolResult | Promise<ToolResult>;
}

/** A reply of plain lines (false/null/undefined lines are left out). */
export const say = (...lines: (string | false | null | undefined)[]): ToolResult => ({ content: [{ type: "text", text: lines.filter((l) => l !== false && l !== null && l !== undefined).join("\n") }] });

export const r2 = (v: number) => Math.round(v * 100) / 100 || 0;
export const r1 = (v: number) => Math.round(v * 10) / 10 || 0;

/** A file name made from the design's name, safe on every computer. */
export function fileNameFor(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-").replace(/^[.\s]+|[.\s]+$/g, "").slice(0, 120);
  if (!cleaned || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i.test(cleaned)) return "design";
  return cleaned;
}

export function needFolder(s: Session): DesignFolder {
  if (!s.folder) throw new InputError("No folder for designs is set up. In Claude, open Settings › Extensions › JuraCAD and choose a folder.");
  return s.folder;
}

/**
 * Write a file into the folder — the last thing a tool does. A call cancelled
 * before this writes nothing; once written, the file stays (and the call
 * counts as done, even if a cancellation arrives afterwards).
 */
export function writeOut(s: Session, path: string, data: string | Uint8Array): void {
  s.throwIfCancelled();
  needFolder(s).write(path, data);
  s.wroteFile = true;
}

/** Refuse to replace an existing file unless asked to. */
export function checkFree(s: Session, path: string, overwrite: unknown): void {
  if (needFolder(s).exists(path) && overwrite !== true) throw new InputError(`There's already a file called "${path.split(/[\\/]/).pop()}". Choose another filename, or pass "overwrite": true.`);
}

/** Find something by id or name (any capitals), or say what there is. */
export function byName<T extends { id: string; name: string }>(list: readonly T[], ref: unknown, where: string, what: string, howToMake: string): T {
  if (typeof ref !== "string" || !ref.trim()) {
    throw new InputError(`${where}: give the ${what}'s name${list.length ? `, e.g. "${list[0].name}"` : ""}.${list.length ? "" : ` There are none yet: ${howToMake}`}`);
  }
  const want = ref.trim().toLowerCase();
  const hit = list.find((x) => x.id.toLowerCase() === want) ?? list.find((x) => x.name.toLowerCase() === want);
  if (!hit) throw new InputError(`${where}: there's no ${what} "${ref}". ${list.length ? `The ${what}s are: ${list.map((x) => x.name).join(", ")}.` : `There are none yet: ${howToMake}`}`);
  return hit;
}
