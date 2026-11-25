/**
 * Whether "As many pieces as will print well" is ticked in each puzzle window: remembered for the session (closing and
 * opening a window keeps it), never saved.
 */
const ticked = { island: false, mountain: false };

export type MostPiecesWindow = keyof typeof ticked;

export const mostPiecesTicked = (w: MostPiecesWindow) => ticked[w];
export const setMostPiecesTicked = (w: MostPiecesWindow, on: boolean) => {
  ticked[w] = on;
};
