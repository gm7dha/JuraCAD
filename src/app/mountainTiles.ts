/** The browser side of reading height tiles: fetch a terrarium tile and read its exact pixel colours. */
import { TILE_URL, type TilePixels } from "../terrain/elevation";

export async function loadTerrainTile(z: number, x: number, y: number): Promise<TilePixels> {
  const url = TILE_URL.replace("{z}", String(z)).replace("{x}", String(x)).replace("{y}", String(y));
  let res: Response;
  try {
    res = await fetch(url, { mode: "cors" });
  } catch {
    throw new Error("Couldn't reach the height data — check you're online.");
  }
  if (!res.ok) throw new Error(`The height data server said ${res.status} for one of the map tiles.`);
  // The colours ARE the heights: no colour correction, no premultiplying, or they'd be changed.
  const bitmap = await createImageBitmap(await res.blob(), { colorSpaceConversion: "none", premultiplyAlpha: "none" });
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!ctx) throw new Error("This browser can't read the height pictures.");
  ctx.drawImage(bitmap, 0, 0);
  const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  bitmap.close();
  return { width: canvas.width, height: canvas.height, data };
}
