/** Plays a mate's animation in the 3D view (see assembly/animate.ts). */
import { animatedValues, animationRange } from "../assembly/animate";
import { activeAssembly, useStore } from "../model/store";

let frame = 0;

/** Start animating a mate, or stop if it's the one already playing. */
export function toggleMateAnimation(mateId: string) {
  const s = useStore.getState();
  if (s.animatingMate === mateId) return stopMateAnimation();
  stopMateAnimation();
  const mate = activeAssembly(s)?.mates?.find((m) => m.id === mateId);
  const range = mate && animationRange(mate);
  if (!mate || !range) {
    s.showToast("This mate doesn't allow any movement to animate (a Fasten holds the parts still).", "info");
    return;
  }
  s.setAnimatingMate(mateId);
  const start = performance.now();
  const step = (now: number) => {
    const st = useStore.getState();
    // Stopped, or the assembly changed under it.
    if (st.animatingMate !== mateId || !activeAssembly(st)) return stopMateAnimation();
    st.setDragPreview({ kind: "mate", id: mateId, values: animatedValues(mate, range, now - start) });
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
}

export function stopMateAnimation() {
  cancelAnimationFrame(frame);
  const s = useStore.getState();
  if (s.animatingMate) {
    s.setAnimatingMate(null);
    s.setDragPreview(null);
  }
}
