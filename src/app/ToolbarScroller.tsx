import { useEffect, useRef, useState, type ReactNode } from "react";

import { Icons } from "./icons";

/**
 * Lets a toolbar that's wider than the window scroll with the mouse: the
 * ordinary (up/down) wheel or trackpad scrolls it sideways, and ‹ › buttons
 * appear at either end while there are more tools to see.
 */
export function ToolbarScroller({ children }: { children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [ends, setEnds] = useState({ left: false, right: false });

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const bar = () => el.querySelector<HTMLElement>(".toolbar");
    const update = () => {
      const b = bar();
      const left = !!b && b.scrollLeft > 1;
      const right = !!b && b.scrollLeft + b.clientWidth < b.scrollWidth - 1;
      setEnds((e) => (e.left === left && e.right === right ? e : { left, right }));
    };
    const onWheel = (e: WheelEvent) => {
      const b = bar();
      if (!b || b.scrollWidth <= b.clientWidth) return;
      // Sideways trackpad swipes already scroll; turn up/down into left/right.
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      e.preventDefault();
      b.scrollLeft += e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", update, true);
    const resize = new ResizeObserver(update);
    resize.observe(el);
    // The toolbar changes (sketching, drawings, assemblies), so watch what's inside too.
    const changes = new MutationObserver(() => {
      const b = bar();
      if (b) resize.observe(b);
      update();
    });
    changes.observe(el, { childList: true, subtree: true });
    const b = bar();
    if (b) resize.observe(b);
    update();
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", update, true);
      resize.disconnect();
      changes.disconnect();
    };
  }, []);

  const scroll = (dir: number) => {
    const b = wrap.current?.querySelector<HTMLElement>(".toolbar");
    if (b) b.scrollBy({ left: dir * Math.max(120, b.clientWidth * 0.7), behavior: "smooth" });
  };

  return (
    <div className="toolbar-scroller" ref={wrap}>
      {children}
      {ends.left && (
        <button type="button" className="toolbar-arrow left" aria-label="Scroll tools left" title="More tools" onClick={() => scroll(-1)}>
          <Icons.ChevronLeft size={18} />
        </button>
      )}
      {ends.right && (
        <button type="button" className="toolbar-arrow right" aria-label="Scroll tools right" title="More tools" onClick={() => scroll(1)}>
          <Icons.ChevronRight size={18} />
        </button>
      )}
    </div>
  );
}
