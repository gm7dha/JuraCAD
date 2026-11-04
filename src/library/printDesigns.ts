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
import type { LibraryDesign } from "./types";

export const PRINT_DESIGNS: readonly LibraryDesign[] = [boltSet, standoff, pianoHinge, jar, bitHolder, pegboardHook, drawerPull, grommet, cornerGuard];
