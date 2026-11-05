/**
 * The newer 3D-printing designs, in the order they're shown after the first ones (kept here so the list in insert.ts
 * stays short).
 */
import { bitHolder } from "./designs/bitHolder";
import { boltSet } from "./designs/boltSet";
import { cornerGuard } from "./designs/cornerGuard";
import { drawerPull } from "./designs/drawerPull";
import { grommet } from "./designs/grommet";
import { jar } from "./designs/jar";
import { pegboardHook } from "./designs/pegboardHook";
import { pianoHinge } from "./designs/pianoHinge";
import { standoff } from "./designs/standoff";
import { gridfinityBaseplate, gridfinityBin } from "./designs/gridfinity";
import { sign } from "./designs/sign";
import { batteryHolder } from "./designs/batteryHolder";
import { spoolHolder } from "./designs/spoolHolder";
import { headphoneHook } from "./designs/headphoneHook";
import { plantPot } from "./designs/plantPot";
import { bagClip } from "./designs/bagClip";
import { thumbKnob } from "./designs/thumbKnob";
import { hoseAdapter } from "./designs/hoseAdapter";
import { cardHolder } from "./designs/cardHolder";
import { PRINT_DESIGNS_4 } from "./printDesigns4";
import { PRINT_DESIGNS_5 } from "./printDesigns5";
import type { LibraryDesign } from "./types";

/** The third batch (Gridfinity and more), shown after the others. */
const PRINT_DESIGNS_3: readonly LibraryDesign[] = [
  gridfinityBaseplate,
  gridfinityBin,
  sign,
  batteryHolder,
  spoolHolder,
  headphoneHook,
  plantPot,
  bagClip,
  thumbKnob,
  hoseAdapter,
  cardHolder,
];

export const PRINT_DESIGNS: readonly LibraryDesign[] = [boltSet, standoff, pianoHinge, jar, bitHolder, pegboardHook, drawerPull, grommet, cornerGuard, ...PRINT_DESIGNS_3, ...PRINT_DESIGNS_4, ...PRINT_DESIGNS_5];

