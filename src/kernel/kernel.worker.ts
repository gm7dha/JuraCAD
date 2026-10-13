/**
 * Background worker: loads the OpenCascade engine once, then answers
 * rebuild / check / export requests from the main thread one at a time.
 */
import opencascade from "replicad-opencascadejs";
import opencascadeWasm from "replicad-opencascadejs/wasm?url";
import { setOC } from "replicad";

import { describeError, GeometryEngine } from "./engine";
import type { FromWorker, KernelResponseBody, ToWorker } from "./protocol";

const ctx = self as unknown as {
  postMessage(message: FromWorker, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
};

const engine = new GeometryEngine();

const ready = (async () => {
  const OC = await opencascade({ locateFile: () => opencascadeWasm });
  setOC(OC);
})();

ready.then(
  () => ctx.postMessage({ kind: "ready" }),
  (e) => ctx.postMessage({ kind: "fatal", error: describeError(e, "The geometry engine failed to load.") }),
);

// Handle requests strictly in order.
let queue: Promise<void> = ready.catch(() => undefined);

ctx.onmessage = (event) => {
  const { id, request } = event.data;
  queue = queue.then(async () => {
    try {
      await ready;
      let body: KernelResponseBody;
      const transfer: Transferable[] = [];
      switch (request.type) {
        case "rebuild": {
          const result = engine.rebuildStudios(request.studios, request.variables, request.partNames);
          for (const p of result.parts) {
            transfer.push(p.vertices.buffer, p.normals.buffer, p.triangles.buffer, p.lines.buffer);
          }
          body = { type: "rebuild", result };
          break;
        }
        case "check":
          body = { type: "check", result: engine.check(request.quality, request.partIds) };
          break;
        case "exportStl": {
          const result = engine.exportStl(request.partIds, request.quality);
          transfer.push(result.stl);
          body = { type: "exportStl", result };
          break;
        }
        case "export3mf": {
          const result = engine.export3mf(request.partIds, request.quality, request.title, request.colours);
          transfer.push(result.data);
          body = { type: "export3mf", result };
          break;
        }
        case "measure":
          body = { type: "measure", result: engine.measure(request.picks) };
          break;
        case "exportStep": {
          const result = await engine.exportStep(request.partIds, request.colours);
          transfer.push(result.step);
          body = { type: "exportStep", result };
          break;
        }
      }
      ctx.postMessage({ kind: "response", id, ok: true, body }, transfer);
    } catch (e) {
      ctx.postMessage({ kind: "response", id, ok: false, error: describeError(e, "Something went wrong in the geometry engine.") });
    }
  });
};
