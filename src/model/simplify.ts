/**
 * "Simplify": tidying a part that's only triangles (an STL, or a STEP file
 * made from one) — or a real part whose faces are split into pieces — into
 * real flat and round faces you can pick, fillet and measure. The settings
 * and the summary shown afterwards live here (pure); the work is done by
 * src/geometry/meshSimplify.ts (recognising shapes) and src/kernel/simplify.ts
 * (OpenCascade).
 */

export type SimplifyLevel = "fine" | "normal" | "coarse";

export const SIMPLIFY_LEVELS: SimplifyLevel[] = ["fine", "normal", "coarse"];

export interface SimplifyTolerances {
  /** How far (mm) points may be from a recognised face or edge. */
  distance: number;
  /** Triangles at less than this angle (radians) to each other count as one flat face. */
  angle: number;
  /** A round face may turn at most this much (radians) from one facet to the next. */
  bend: number;
}

const deg = (d: number) => (d * Math.PI) / 180;

export const SIMPLIFY_TOLERANCES: Record<SimplifyLevel, SimplifyTolerances> = {
  fine: { distance: 0.01, angle: deg(0.25), bend: deg(20) },
  normal: { distance: 0.05, angle: deg(1), bend: deg(35) },
  coarse: { distance: 0.2, angle: deg(3), bend: deg(45) },
};

export const SIMPLIFY_LABELS: Record<SimplifyLevel, { label: string; hint: string }> = {
  fine: { label: "Fine", hint: "Only joins what matches very closely (0.01 mm) — for accurate files." },
  normal: { label: "Normal", hint: "Joins what matches within 0.05 mm — right for most files." },
  coarse: { label: "Coarse", hint: "Joins what matches within 0.2 mm — for rough or low-detail files." },
};

export const isSimplifyLevel = (v: unknown): v is SimplifyLevel => v === "fine" || v === "normal" || v === "coarse";

/** One face of a simplified part, as the summary counts it. */
export interface SimplifiedFace {
  kind: "plane" | "cylinder" | "cone" | "sphere" | "torus" | "other";
  /** Round faces: the radius (mm). */
  radius?: number;
  /** Goes all the way round (a hole or a round boss), not part of the way (a fillet). */
  full?: boolean;
  /** Curves inwards (a hole, an inside fillet). */
  concave?: boolean;
  /** Left as flat pieces of the original triangles (nothing simpler fitted). */
  mesh?: boolean;
}

export interface SimplifySummary {
  facesBefore: number;
  faces: SimplifiedFace[];
  /** Shapes were recognised from the triangles (not only flat areas joined). */
  recognised: boolean;
  /** Recognising shapes was tried but didn't give a sound part, so only the joining was kept. */
  fellBack?: boolean;
  /** Bodies that weren't closed, so only their flat areas were joined. */
  openBodies?: number;
}

const count = (n: number) => n.toLocaleString("en-GB");

/** A size for the summary: up to 3 decimals, no trailing zeros. */
const size = (v: number) => String(Number(v.toFixed(3)));

function listSizes(prefix: string, values: number[], max = 4): string {
  const unique = [...new Set(values.map((v) => size(v)))].sort((a, b) => Number(a) - Number(b));
  const shown = unique.slice(0, max).map((v) => prefix + v);
  return shown.join(", ") + (unique.length > max ? "…" : "");
}

/**
 * The short summary shown after simplifying, e.g.
 * "4,812 faces → 38 faces: 22 flat, 12 round (holes Ø5, Ø8, fillets R2), 4 left as mesh."
 */
export function simplifyReport(s: SimplifySummary): string {
  const after = s.faces.length;
  const flat = s.faces.filter((f) => f.kind === "plane" && !f.mesh).length;
  const mesh = s.faces.filter((f) => f.mesh).length;
  const round = s.faces.filter((f) => f.kind !== "plane" && f.kind !== "other" && !f.mesh);
  const other = s.faces.filter((f) => f.kind === "other" && !f.mesh).length;
  const cyl = round.filter((f) => f.kind === "cylinder" && f.radius !== undefined);
  const holes = cyl.filter((f) => f.full && f.concave).map((f) => 2 * f.radius!);
  const bosses = cyl.filter((f) => f.full && !f.concave).map((f) => 2 * f.radius!);
  // Part-way round a cylinder, or a ring round a hole or boss (a torus): fillets.
  const fillets = [...cyl.filter((f) => !f.full).map((f) => f.radius!), ...round.filter((f) => f.kind === "torus" && f.radius !== undefined).map((f) => f.radius!)];
  const details: string[] = [];
  if (holes.length) details.push(`hole${holes.length > 1 ? "s" : ""} ${listSizes("Ø", holes)}`);
  if (bosses.length) details.push(`round${bosses.length > 1 ? "s" : ""} ${listSizes("Ø", bosses)}`);
  if (fillets.length) details.push(`fillet${fillets.length > 1 ? "s" : ""} ${listSizes("R", fillets)}`);
  const cones = round.filter((f) => f.kind === "cone").length;
  const balls = round.filter((f) => f.kind === "sphere").map((f) => f.radius ?? 0);
  if (cones) details.push(`${cones} cone${cones > 1 ? "s" : ""}`);
  if (balls.length) details.push(`ball${balls.length > 1 ? "s" : ""} ${listSizes("R", balls)}`);
  const parts = [`${count(flat)} flat`];
  if (round.length) parts.push(`${count(round.length)} round${details.length ? ` (${details.join(", ")})` : ""}`);
  if (other) parts.push(`${count(other)} curved`);
  if (mesh) parts.push(`${count(mesh)} left as mesh`);
  let text = `${count(s.facesBefore)} face${s.facesBefore === 1 ? "" : "s"} → ${count(after)} face${after === 1 ? "" : "s"}: ${parts.join(", ")}.`;
  if (s.fellBack) text += " Round shapes couldn't be rebuilt safely here, so only flat areas were joined.";
  if (s.openBodies) text += ` ${s.openBodies === 1 ? "One piece isn't" : `${s.openBodies} pieces aren't`} closed, so only its flat areas were joined.`;
  return text;
}
