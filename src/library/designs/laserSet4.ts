/** The fourth batch of laser designs (living-hinge box, dice tower, name puzzle…), in the library's order. */
import { cardStandDesign } from "./cardStand";
import { deckBoxDesign } from "./deckBox";
import { diceTowerDesign } from "./diceTower";
import { hingeBoxDesign } from "./hingeBox";
import { keyRackDesign } from "./keyRack";
import { lanternDesign } from "./lantern";
import { namePuzzleDesign } from "./namePuzzle";
import { spiceRackDesign } from "./spiceRack";
import type { LibraryDesign } from "../types";

export const LASER_DESIGNS_4: readonly LibraryDesign[] = [hingeBoxDesign, deckBoxDesign, cardStandDesign, spiceRackDesign, lanternDesign, keyRackDesign, diceTowerDesign, namePuzzleDesign];
