/**
 * JuraCAD's end of the link with JuraCUT (src/link/juraLink.ts): started once by App; designs JuraCUT sends (DXF) become
 * a new sketch (`store.addLinkedSketch`); `sendToJuraCUT` hands the Laser panel's outlines (SVG, layers as colours) to
 * JuraCUT, which puts them on its bed.
 */
import { useStore } from "../model/store";
import { APP_LABEL, LINK_CHANNEL, LinkEnd, siblingUrl, type Parcel, type Received } from "../link/juraLink";

let link: LinkEnd | null = null;

function randomId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function receiveParcel(p: Parcel): Received {
  if (p.kind !== "dxf") return { ok: false, message: `JuraCAD takes designs from ${APP_LABEL[p.from]} as DXF.` };
  return useStore.getState().addLinkedSketch(p.name, p.content);
}

/** Open the link (once). Does nothing where the browser has no BroadcastChannel. */
export function startLink(): () => void {
  if (link || typeof BroadcastChannel === "undefined") return () => undefined;
  const url = new URL(window.location.href);
  const waitingFor = url.searchParams.get("link");
  if (waitingFor) {
    url.searchParams.delete("link");
    window.history.replaceState(null, "", url.toString());
  }
  link = new LinkEnd({
    app: "juracad",
    waitingFor,
    receive: receiveParcel,
    env: {
      channel: new BroadcastChannel(LINK_CHANNEL),
      now: () => Date.now(),
      setTimer: (fn, ms) => window.setTimeout(fn, ms),
      clearTimer: (t) => window.clearTimeout(t as number),
      openTab: (to, id) => window.open(siblingUrl(import.meta.env.BASE_URL, window.location.origin, to, id), "_blank"),
      newId: randomId,
    },
  });
  const shown = () => document.visibilityState === "visible" && link?.wake();
  const bye = () => link?.close();
  document.addEventListener("visibilitychange", shown);
  window.addEventListener("pagehide", bye);
  return () => {
    document.removeEventListener("visibilitychange", shown);
    window.removeEventListener("pagehide", bye);
    link?.close();
    link = null;
  };
}

/** Send outlines (SVG text) to JuraCUT: into a tab of it that's open, or a new one. Call straight from the click. */
export async function sendToJuraCUT(name: string, svg: string): Promise<void> {
  const s = useStore.getState();
  if (!link) {
    s.showToast("This browser can't pass designs between JuraCAD and JuraCUT. Save the SVG and import it into JuraCUT instead.", "error");
    return;
  }
  const r = await link.send("juracut", name, "svg", svg);
  useStore.getState().showToast(r.ok ? `Sent to JuraCUT. ${r.message}` : r.message, r.ok ? "success" : "error");
}
