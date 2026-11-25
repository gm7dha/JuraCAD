/**
 * The top bar's last resort when its buttons don't fit: the media queries in styles.css drop the button words at fixed widths,
 * but fonts differ between computers (and the version badge, the save note or "Live with Claude" change length), so the bar
 * also measures itself. `tight-1` hides Install/New/Open/Save's words, `tight-2` every word but Claude's, `tight-3` Claude's
 * too and the save note. It always picks the first step at which the bar fits.
 */
export const TIGHT_STEPS = 3;

/** The first step (0 = as styled) at which `fits(step)` says the bar fits; the last step when none does. */
export function tightStep(fits: (step: number) => boolean): number {
  for (let step = 0; step < TIGHT_STEPS; step++) if (fits(step)) return step;
  return TIGHT_STEPS;
}

const NAME_LEAST = 72; // .doc-name's min-width (70) + rounding: squeezed to it = no room left

/** Sets the bar's tight-N class to the first step at which it fits. Works on the DOM directly, so React never re-renders for it. */
export function fitTopBar(bar: HTMLElement): void {
  const apply = (step: number) => {
    for (let k = 1; k <= TIGHT_STEPS; k++) bar.classList.toggle(`tight-${k}`, k <= step);
  };
  const name = bar.querySelector<HTMLElement>(".doc-name");
  const fits = (step: number) => {
    apply(step);
    if (bar.scrollWidth > bar.clientWidth + 1) return false;
    return !name || name.offsetWidth === 0 || name.offsetWidth > NAME_LEAST;
  };
  apply(tightStep(fits));
}

/** Keeps the bar fitted as the window or anything in it changes. Returns the clean-up. */
export function watchTopBar(bar: HTMLElement): () => void {
  let queued = 0;
  const refit = () => {
    if (queued) return;
    queued = requestAnimationFrame(() => {
      queued = 0;
      fitTopBar(bar);
    });
  };
  fitTopBar(bar);
  const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
  resize?.observe(bar);
  // Words changing inside (the save note, the Claude button) — but not our own class changes on the bar itself.
  const changes = typeof MutationObserver === "undefined" ? null : new MutationObserver(refit);
  changes?.observe(bar, { childList: true, subtree: true, characterData: true });
  window.addEventListener("resize", refit);
  document.fonts?.ready.then(refit).catch(() => {});
  return () => {
    resize?.disconnect();
    changes?.disconnect();
    window.removeEventListener("resize", refit);
    if (queued) cancelAnimationFrame(queued);
  };
}
