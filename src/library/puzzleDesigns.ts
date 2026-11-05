/** 3D printed puzzles for the Design library (under "Puzzles", beside the Mountain and Photo relief puzzle tools). */
import { mazeBox } from "./designs/mazeBox";
import { sixPieceBurr } from "./designs/sixPieceBurr";
import type { LibraryDesign } from "./types";

export const PUZZLE_DESIGNS: readonly LibraryDesign[] = [mazeBox, sixPieceBurr];
