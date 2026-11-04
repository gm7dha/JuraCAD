/**
 * A small popup drawn over everything (in document.body, so no panel can cut
 * it off) and placed inside the window by `placePopup`: below what opened it,
 * else above, else beside it. Closes on a click elsewhere or Escape.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

import { placePopup, type Box, type PopupPlace } from "./popupPlace";

export function PlacedPopup({
  anchor,
  owner,
  onClose,
  className,
  role,
  label,
  children,
}: {
  /** Where it opens from (window pixels), worked out again when the window changes. */
  anchor: () => Box | null;
  /** The button that opened it: clicks on it are left to it (it toggles the popup). */
  owner?: RefObject<HTMLElement | null>;
  onClose: () => void;
  className: string;
  role: "dialog" | "menu";
  label: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<PopupPlace | null>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const anchorRef = useRef(anchor);
  anchorRef.current = anchor;

  const replace = useCallback(() => {
    const el = ref.current;
    const at = anchorRef.current();
    if (!el || !at) return;
    // Its natural size (scrollHeight: as if nothing limited its height).
    const size = { width: el.offsetWidth, height: el.scrollHeight };
    const next = placePopup(at, size, { width: window.innerWidth, height: window.innerHeight });
    setPlace((p) => (p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight ? p : next));
  }, []);

  useLayoutEffect(replace, [replace]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || owner?.current?.contains(t)) return;
      closeRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      closeRef.current();
      owner?.current?.focus();
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", replace);
    window.addEventListener("scroll", replace, true);
    const watch = typeof ResizeObserver === "function" ? new ResizeObserver(replace) : null;
    if (ref.current) watch?.observe(ref.current);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", replace);
      window.removeEventListener("scroll", replace, true);
      watch?.disconnect();
    };
  }, [owner, replace]);

  return createPortal(
    <div
      ref={ref}
      className={`placed-popup ${className}`}
      role={role}
      aria-label={label}
      data-side={place?.side}
      style={{
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        // Measured first, then shown where it fits.
        visibility: place ? undefined : "hidden",
        ...(place?.maxHeight !== undefined ? { maxHeight: place.maxHeight, overflowY: "auto" as const } : {}),
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

/** A box for an element on screen (or null when it's gone). */
export function boxOf(el: Element | null | undefined): Box | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}
