/**
 * Colours the Island and Mountain puzzles off the page's own thread, so the window never freezes while a big puzzle is
 * coloured. The work is src/terrain/colourJob.ts (it keeps the pieces and the last cut into bands between jobs).
 */
import { ColourCache, replyTransfers, type ColourJob, type ColourReply } from "../terrain/colourJob";

const ctx = self as unknown as {
  postMessage(message: ColourReply, transfer: Transferable[]): void;
  onmessage: ((e: MessageEvent<ColourJob>) => void) | null;
};

const cache = new ColourCache();

ctx.onmessage = (e) => {
  const reply = cache.run(e.data);
  ctx.postMessage(reply, replyTransfers(reply));
};
