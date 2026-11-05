/** The fifth batch of 3D-printing designs (Honeycomb wall, more Gridfinity, household and workshop prints), shown after the others. */
import { hswBin, hswHook, hswTile } from "./designs/honeycomb";
import { gridfinityBitHolder, gridfinityLiteBin, gridfinityMagnetBaseplate } from "./designs/gridfinityMore";
import { pipeClip } from "./designs/pipeClip";
import { chargingStand } from "./designs/chargingStand";
import { bearingSpoolHolder } from "./designs/bearingSpool";
import { funnel } from "./designs/funnel";
import { doorWedge, tieAnchor } from "./designs/doorWedge";
import { dividerSet } from "./designs/dividerSet";
import type { LibraryDesign } from "./types";

export const PRINT_DESIGNS_5: readonly LibraryDesign[] = [hswTile, hswHook, hswBin, gridfinityMagnetBaseplate, gridfinityBitHolder, gridfinityLiteBin, pipeClip, chargingStand, bearingSpoolHolder, funnel, doorWedge, tieAnchor, dividerSet];
