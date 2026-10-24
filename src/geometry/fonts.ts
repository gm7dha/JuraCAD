/**
 * The fonts JuraCAD has for text (the Text feature and sketch Text): three.js's
 * Helvetiker, regular and bold, as outline ("typeface") fonts.
 */
import regular from "three/examples/fonts/helvetiker_regular.typeface.json";
import bold from "three/examples/fonts/helvetiker_bold.typeface.json";

import type { TypefaceFont } from "./text";

export type FontName = "regular" | "bold";

/** The fonts by name. A plain object, so tests can stand in a font of their own. */
export const FONTS: Record<FontName, TypefaceFont> = { regular: regular as unknown as TypefaceFont, bold: bold as unknown as TypefaceFont };

/** Names shown in the app. */
export const FONT_LABELS: Record<FontName, string> = { regular: "Regular", bold: "Bold" };
