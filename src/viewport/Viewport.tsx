import { useEffect, useRef } from "react";

import { useStore } from "../model/store";
import { SceneManager } from "./SceneManager";

/** Lets keyboard shortcuts and toolbar buttons reach the 3D view. */
export const viewportApi: { current: SceneManager | null } = { current: null };

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const parts = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const hiddenParts = useStore((s) => s.hiddenParts);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let manager: SceneManager;
    try {
      manager = new SceneManager(container, {
        onPick: (item, additive) => {
          const { selection: current, setSelection } = useStore.getState();
          if (!item) {
            if (!additive) setSelection([]);
            return;
          }
          const same = (x: typeof item) => x.partId === item.partId && x.kind === item.kind && x.index === item.index;
          if (additive) {
            setSelection(current.some(same) ? current.filter((x) => !same(x)) : [...current, item]);
          } else {
            setSelection(current.length === 1 && same(current[0]) ? [] : [item]);
          }
        },
      });
    } catch (e) {
      useStore.getState().showToast(
        "Your browser couldn't start 3D graphics (WebGL). Try Chrome or Edge, and check hardware acceleration is on.",
        "error",
      );
      console.error(e);
      return;
    }
    viewportApi.current = manager;
    // Show whatever is already built (e.g. after a hot reload).
    const s = useStore.getState();
    manager.setHidden(s.hiddenParts);
    manager.setParts(s.parts);
    manager.setSelection(s.selection);
    return () => {
      viewportApi.current = null;
      manager.dispose();
    };
  }, []);

  useEffect(() => viewportApi.current?.setHidden(hiddenParts), [hiddenParts]);
  useEffect(() => viewportApi.current?.setParts(parts), [parts]);
  useEffect(() => viewportApi.current?.setSelection(selection), [selection]);

  return <div ref={containerRef} className="viewport" data-testid="viewport" />;
}
