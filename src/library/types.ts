/**
 * The Design library: ready-made designs (a finger-jointed box, a tray, a
 * bracket…) that are inserted as ordinary JuraCAD features driven by
 * variables, so they stay fully editable afterwards — like Onshape's
 * configurable library parts.
 */
import type { Feature } from "../model/types";
import type { Ex } from "./ex";

export type InputKind = "length" | "count" | "choice" | "toggle" | "text";

/** One of a design's plain-named sizes or choices. */
export interface DesignInput {
  key: string;
  label: string;
  /** A short hint shown under the box. */
  help?: string;
  kind: InputKind;
  default: number | string | boolean;
  /** Lengths and counts: limits (inclusive). */
  min?: number;
  max?: number;
  /** Choices. */
  choices?: { value: string; label: string }[];
  /** Text: the most letters it may have (default 60), and whether it may have several lines (one per line in the box). */
  maxLength?: number;
  multiline?: boolean;
  /** Text: may be left empty. */
  optional?: boolean;
  /**
   * Kept as a document variable (`<prefix>_<key>`), so it can be changed later
   * in Variables and the design follows. Inputs that change what's made (how
   * many fingers, a lid or not) aren't: change them with "Edit design sizes".
   */
  variable?: boolean;
}

export type DesignValues = Record<string, number | string | boolean>;

export interface MakeContext {
  values: DesignValues;
  /** The variable-backed inputs, by key: their variable's name and value now. */
  vars: Record<string, Ex>;
  /** A feature id for a part of the design ("bottom", "bottom-sketch"…): the same each time it's made again. */
  id: (role: string) => string;
  /** This insert's name, e.g. "Finger box" or "Finger box 2". */
  name: string;
  /** Every variable's value now (the new ones included), for sketches that need to be solved. */
  scope: Record<string, number>;
}

export interface MadeDesign {
  features: Feature[];
  /** Names for the parts it makes, by part id. */
  partNames: Record<string, string>;
}

/** Simple line drawing for the preview (mm). */
export type PreviewShape =
  | { kind: "poly"; points: [number, number][]; closed?: boolean; faint?: boolean }
  | { kind: "circle"; c: [number, number]; r: number; faint?: boolean }
  | { kind: "text"; at: [number, number]; text: string };

/** The library's two sections: designs cut from flat sheet on a laser, and designs made on a 3D printer. */
export type DesignCategory = "laser" | "print";

export interface LibraryDesign {
  id: string;
  name: string;
  description: string;
  /** Which section of the library it's in: "laser" (Laser cutting) or "print" (3D printing). */
  category: DesignCategory;
  /** A heading it's listed under within its section ("Signs and stamps", "Boxes"…). Missing = listed first, without one. */
  group?: string;
  /**
   * Export for laser's settings for a sketch this design makes, by the sketch's role (the `ctx.id(role)` it was made
   * with): e.g. a stamp's sketch engraves the background. Set when that sketch is picked in the laser panel.
   */
  laser?: Record<string, { background?: boolean; text?: "cut" | "engrave"; shapes?: "cut" | "engrave"; open?: "cut" | "score" }>;
  /** Start of its variables' names: box → box_width. */
  prefix: string;
  /** A small drawing for its card: the inside of an <svg viewBox="0 0 48 48">, in currentColor. */
  icon: string;
  inputs: DesignInput[];
  /** What's wrong with these values (plain English), beyond each input's own limits. */
  problems: (values: DesignValues) => string[];
  /** The features it adds. */
  make: (ctx: MakeContext) => MadeDesign;
  /** A flat drawing of it with these values (for the live preview). */
  preview: (values: DesignValues) => PreviewShape[];
  /** A line about what these values make (e.g. how many fingers), or null. */
  summary?: (values: DesignValues) => string | null;
}

/** A design inserted into the document: enough to open its sizes again ("Edit design sizes"). Saved in the file. */
export interface LibraryInsert {
  id: string;
  /** Which design (LibraryDesign.id). */
  design: string;
  /** Its name in this document ("Finger box 2"); also its folder in the feature list. */
  name: string;
  /** Start of its variables' names ("box2"). */
  prefix: string;
  /** The values it was made with (the variable-backed ones are read back from the variables). */
  values: DesignValues;
  /** The features it made. */
  features: string[];
  /** The variables it made, by input key (their ids, so a renamed one is still found). Missing in early files. */
  variables?: Record<string, string>;
}
