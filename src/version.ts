declare const __APP_VERSION__: string;

/** JuraCAD's version, e.g. "0.4.0" (from package.json; history in CHANGELOG.md). */
export const APP_VERSION: string = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

/** Short form for display, e.g. "v0.4". */
export const SHORT_VERSION = `v${APP_VERSION.replace(/\.0$/, "")}`;
