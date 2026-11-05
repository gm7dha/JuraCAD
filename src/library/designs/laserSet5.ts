/** The fifth batch of laser designs (bird box, earring stand, box with drawers…), in the library's order. */
import { birdBoxDesign } from "./birdBox";
import { bookStandDesign } from "./bookStand";
import { coasterHolderDesign } from "./coasterHolder";
import { drawerBoxDesign } from "./drawerBox";
import { earringStandDesign } from "./earringStand";
import { penHolderDesign } from "./penHolder";
import { sunburstMirrorDesign } from "./sunburstMirror";
import { tissueBoxDesign } from "./tissueBox";
import type { LibraryDesign } from "../types";

export const LASER_DESIGNS_5: readonly LibraryDesign[] = [birdBoxDesign, earringStandDesign, drawerBoxDesign, penHolderDesign, sunburstMirrorDesign, bookStandDesign, coasterHolderDesign, tissueBoxDesign];
