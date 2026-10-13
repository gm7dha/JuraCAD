/** Part colours: a friendly palette, plus checking colours read from files. */

export const DEFAULT_PART_COLOUR = "#a8b4c0";

export const PART_COLOURS: { name: string; hex: string }[] = [
  { name: "Grey (default)", hex: DEFAULT_PART_COLOUR },
  { name: "White", hex: "#f2f2f0" },
  { name: "Black", hex: "#2b2f33" },
  { name: "Red", hex: "#d64545" },
  { name: "Orange", hex: "#ef8a2f" },
  { name: "Yellow", hex: "#f2c94c" },
  { name: "Green", hex: "#4caf6a" },
  { name: "Teal", hex: "#2fa6a0" },
  { name: "Blue", hex: "#3d7fd9" },
  { name: "Purple", hex: "#8a63c9" },
  { name: "Brown", hex: "#9a6b46" },
  { name: "Steel", hex: "#7d8a96" },
];

/** "#abc" / "#aabbcc" (any case) → "#aabbcc", or null if it isn't a colour. */
export function normaliseColour(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  return `#${h.toLowerCase()}`;
}

/** Colours by part from untrusted JSON. */
export function parseAppearance(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const c = normaliseColour(v);
    if (c) out[id] = c;
  }
  return out;
}

/** "#3d7fd9" → [r, g, b] each 0–1 (for 3MF/STEP). */
export function colourToRgb(hex: string): [number, number, number] {
  const c = normaliseColour(hex) ?? DEFAULT_PART_COLOUR;
  return [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255) as [number, number, number];
}
