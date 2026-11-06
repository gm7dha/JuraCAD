/** The sixth batch of 3D-printing designs: moulds for casting candles, wax melts, concrete and Jesmonite, shown after the others. */
import { pillarCandleMould, wickBar } from "./designs/candleMould";
import { meltTray } from "./designs/meltTray";
import { concreteHolderMould, concretePotMould, trinketDishMould } from "./designs/castMoulds";
import type { LibraryDesign } from "./types";

export const PRINT_DESIGNS_6: readonly LibraryDesign[] = [pillarCandleMould, wickBar, meltTray, concretePotMould, concreteHolderMould, trinketDishMould];
