/**
 * Frames (Onshape's Frame, Trim frame and Gusset): what's saved in a design. The maths is in frame.ts and
 * frameProfiles.ts (pure); the solids are made in kernel/frame.ts.
 */
import type { SketchPlane } from "../sketch/planes";

/** A sketch's lines and arcs used as the path: all of them (missing `items`) or just these curve ids. Construction lines are never used. */
export interface FramePath {
  sketch: string;
  items?: string[];
}

/** The built-in profile families (see frameProfiles.ts). */
export type FrameProfileKind = "extrusion" | "box" | "angle" | "tube" | "flat" | "timber";

/**
 * The cross-section: a size from the built-in list (`size` is its key, "custom" = the feature's width / height /
 * wall boxes), or the closed shapes of a sketch of the user's own.
 */
export type FrameProfile = { kind: FrameProfileKind; size: string } | { kind: "sketch"; sketch: string };

/** Which point of the profile sits on the path (its middle, a corner or the middle of a side of its outline's box). */
export type FrameAnchor = "centre" | "top" | "bottom" | "left" | "right" | "topLeft" | "topRight" | "bottomLeft" | "bottomRight";

export type FrameCornerType = "mitre" | "butt" | "coped" | "none";

/**
 * A corner set differently from the usual (a mitre where two members meet, a butt joint where three or more meet or
 * one ends against the side of another). `key` names the corner by the curves meeting there (see `cornerKey`), so it
 * survives size changes; `through` is the curve ("sketch/curve") of the member that runs through for a butt or
 * coped joint (missing = the first one).
 */
export interface FrameCornerChoice {
  key: string;
  type: FrameCornerType;
  through?: string;
}

export interface FrameDef {
  paths: FramePath[];
  profile: FrameProfile;
  /** Missing = centre. */
  anchor?: FrameAnchor;
  /** Flip the profile left to right. */
  mirror?: boolean;
  /** Keep curves that carry on smoothly as separate members (Onshape's "Merge tangent segments" turned off). */
  noMerge?: boolean;
  corners?: FrameCornerChoice[];
}

/**
 * Trim frame: frame members (`parts`) cut back to a plane or flat face (`plane`, keeping the side with more of each
 * member, or the other with `flip`) or to another part (`to`: the member is cut where it meets it, keeping the
 * biggest piece). `picking` says what a click in the 3D view chooses (not saved).
 */
export interface TrimFrameDef {
  parts: string[];
  plane?: SketchPlane;
  to?: string;
  flip?: boolean;
  picking?: "members" | "target" | "targetPart";
}

/** Gusset: a triangular plate in the inside corner between two frame members (`parts`). */
export interface GussetDef {
  parts: string[];
  /** Cut its inside corner off (by the "chamfer" box), to clear a weld or the members' rounded edges. */
  chamfer?: boolean;
  /** Where one member ends on the other's side: the plate goes the other way along it. */
  flip?: boolean;
}

/** What a frame member is, for the cut list (on PartMesh.frame). */
export interface FrameMemberInfo {
  /** The Frame feature that made it. */
  frame: string;
  /** Its number in the frame (1, 2, …). */
  member: number;
  /** The profile, e.g. "2020 aluminium extrusion". */
  profile: string;
  /** Cut length (mm): the longest point to the longest point. */
  length: number;
  /** How each end is cut: an angle from square in degrees (0 = square, 45 = a mitre), or "coped". */
  ends: [number | "coped", number | "coped"];
  /** Bent to a curve (its length is along the middle). */
  curved?: boolean;
  /** The material it's usually made of (materials.ts key), for its weight when the part has none set. */
  usual?: string;
}
