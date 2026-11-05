/** The fourth batch of 3D-printing designs (electronics, workshop, test prints and more), shown after the others. */
import { enclosure } from "./designs/enclosure";
import { frenchCleat } from "./designs/frenchCleat";
import { hingedBox } from "./designs/hingedBox";
import { deskOrganiser } from "./designs/deskOrganiser";
import { wallPocket } from "./designs/wallPocket";
import { shelfPins } from "./designs/shelfPins";
import { bridgeTest, fitTest, overhangTest } from "./designs/testPrints";
import { cableChain } from "./designs/cableChain";
import type { LibraryDesign } from "./types";

export const PRINT_DESIGNS_4: readonly LibraryDesign[] = [enclosure, frenchCleat, hingedBox, deskOrganiser, cableChain, wallPocket, shelfPins, fitTest, overhangTest, bridgeTest];
