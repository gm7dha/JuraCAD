import { useEffect, useRef } from "react";

import { useStore, type SelectionItem } from "../model/store";
import { SceneManager, type PickTarget } from "./SceneManager";

/** Lets keyboard shortcuts and toolbar buttons reach the 3D view. */
export const viewportApi: { current: SceneManager | null } = { current: null };

/** Apply a click in the viewport to the selection, like Onshape. */
function handlePick(target: PickTarget | null, additive: boolean) {
  const { selection: current, setSelection, selectPlane, selectedPlane } = useStore.getState();
  if (!target) {
    if (!additive) {
      setSelection([]);
      selectPlane(null);
    }
    return;
  }
  if (target.kind === "plane") {
    // Clicking the selected plane again deselects it.
    selectPlane(selectedPlane === target.plane ? null : target.plane);
    return;
  }
  const item = target.item;
  const same = (x: SelectionItem) => x.partId === item.partId && x.kind === item.kind && x.index === item.index;
  if (additive) {
    setSelection(current.some(same) ? current.filter((x) => !same(x)) : [...current, item]);
  } else {
    setSelection(current.length === 1 && same(current[0]) ? [] : [item]);
  }
}

export function Viewport() {
  const containerRef = useRef<HTMLDivElement>(null);
  const parts = useStore((s) => s.parts);
  const selection = useStore((s) => s.selection);
  const hiddenParts = useStore((s) => s.hiddenParts);
  const selectedPlane = useStore((s) => s.selectedPlane);
  const listHoverPlane = useStore((s) => s.listHoverPlane);
  const hiddenDatums = useStore((s) => s.hiddenDatums);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let manager: SceneManager;
    try {
      manager = new SceneManager(container, { onPick: handlePick });
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
    manager.setDatums({ selected: s.selectedPlane, listHover: s.listHoverPlane, hidden: s.hiddenDatums });
    return () => {
      viewportApi.current = null;
      manager.dispose();
    };
  }, []);

  useEffect(() => viewportApi.current?.setHidden(hiddenParts), [hiddenParts]);
  useEffect(() => viewportApi.current?.setParts(parts), [parts]);
  useEffect(() => viewportApi.current?.setSelection(selection), [selection]);
  useEffect(
    () => viewportApi.current?.setDatums({ selected: selectedPlane, listHover: listHoverPlane, hidden: hiddenDatums }),
    [selectedPlane, listHoverPlane, hiddenDatums],
  );

  return <div ref={containerRef} className="viewport" data-testid="viewport" />;
}
