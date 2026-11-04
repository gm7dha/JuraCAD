/**
 * The side view of a phone / tablet stand, shared by the 3D-printed stand and the laser-cut one.
 *
 * The device leans back at `angle` (degrees from the table) in a slot `slot` wide (square to the device), in front of a
 * back rest `back` long, with a lip `lip` high in front of it; every bar is `bar` thick. x runs forwards (towards you),
 * y up; the origin is on the table straight below the slot's back corner. The angle isn't a variable (sizes can't be
 * worked out from an angle in a box), so its sine and cosine go in as plain numbers: the other sizes stay variables.
 */
import { neg, plus, times, ZERO, type Ex } from "../ex";
import type { Pt } from "../fingers";
import { sixPlaces } from "./common";

export interface StandSizes {
  angle: number;
  slot: Ex;
  lip: Ex;
  back: Ex;
  bar: Ex;
}

export function trigOf(angle: number) {
  const a = (angle * Math.PI) / 180;
  const sin = sixPlaces(Math.sin(a));
  const cos = sixPlaces(Math.cos(a));
  return { sin, cos, perSin: sixPlaces(1 / sin) };
}

/** Where the outline's corners are (anticlockwise from the back of the foot), plus a few spots the laser stand needs. */
export function standProfile(s: StandSizes) {
  const { sin, cos, perSin } = trigOf(s.angle);
  const { slot, lip, back, bar } = s;
  const slotFront = times(slot, perSin);
  const lipFront = plus(slotFront, bar);
  const lipTop = plus(bar, lip);
  const rear = neg(plus(times(back, cos), times(bar, sin)));
  const restTop: Pt = [neg(times(back, cos)), plus(bar, times(back, sin))];
  const restBack: Pt = [rear, plus(times(bar, 1 - cos), times(back, sin))];
  const outline: Pt[] = [
    [rear, ZERO],
    [lipFront, ZERO],
    [lipFront, lipTop],
    [slotFront, lipTop],
    [slotFront, bar],
    [ZERO, bar],
    restTop,
    restBack,
    [neg(times(bar, perSin)), bar],
    [rear, bar],
  ];
  return { outline, rear, slotFront, lipFront };
}
