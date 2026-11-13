/**
 * Drawing templates kept in this browser (localStorage `juracad.drawingTemplates`),
 * and which one new drawings start from (`juracad.drawingTemplate.default`).
 * Every read and write is guarded: private windows and tests just get none.
 */
import { parseTemplates, serializeTemplates, type DrawingTemplate } from "./templates";

const LIST_KEY = "juracad.drawingTemplates";
const DEFAULT_KEY = "juracad.drawingTemplate.default";

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export function loadTemplates(): DrawingTemplate[] {
  try {
    const raw = storage()?.getItem(LIST_KEY);
    return raw ? parseTemplates(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function saveTemplates(list: DrawingTemplate[]): boolean {
  try {
    const st = storage();
    if (!st) return false;
    st.setItem(LIST_KEY, serializeTemplates(list));
    return true;
  } catch {
    return false;
  }
}

/** The id of the template new drawings start from (null = none). */
export function defaultTemplateId(): string | null {
  try {
    return storage()?.getItem(DEFAULT_KEY) ?? null;
  } catch {
    return null;
  }
}

export function setDefaultTemplateId(id: string | null): void {
  try {
    const st = storage();
    if (id) st?.setItem(DEFAULT_KEY, id);
    else st?.removeItem(DEFAULT_KEY);
  } catch {
    /* not kept: fine */
  }
}

/** The template new drawings start from, if one is chosen and still there. */
export function defaultTemplate(): DrawingTemplate | null {
  const id = defaultTemplateId();
  return id ? (loadTemplates().find((t) => t.id === id) ?? null) : null;
}
