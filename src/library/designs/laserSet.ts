/** The laser designs added with text inputs (signs and stamps, home, workshop), in the library's order. */
import { coaster, nameTag, ruler } from "./engraved";
import { rubberStamp, printedStamp } from "./stamp";
import { stencil } from "./stencil";
import { gear, livingHinge, pictureFrame } from "./workshop";
import type { LibraryDesign } from "../types";

export const LASER_DESIGNS: readonly LibraryDesign[] = [stencil, rubberStamp, nameTag, coaster, pictureFrame, livingHinge, gear, ruler];
export { printedStamp };
