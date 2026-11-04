/** The third batch of laser designs (sliding-lid box, tray with dividers, jigsaw…), in the library's order. */
import { bookendDesign, dividerTrayDesign, slidingLidBox } from "./boxes3";
import { clockFace, cordWinder, tealightHolder } from "./laserHome3";
import { ornament } from "./ornament";
import { jigsaw } from "./jigsaw";
import type { LibraryDesign } from "../types";

export const LASER_DESIGNS_3: readonly LibraryDesign[] = [slidingLidBox, dividerTrayDesign, bookendDesign, clockFace, cordWinder, tealightHolder, jigsaw, ornament];
