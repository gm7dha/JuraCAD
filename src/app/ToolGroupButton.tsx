/**
 * A toolbar button standing for a family of similar tools (Rectangle and
 * Centre rectangle, the kinds of dimension…), like Onshape's: the button runs
 * the tool last used from the family, and the small ▾ beside it lists the
 * others. Keeps toolbars short without hiding anything.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export interface GroupItem {
  /** Stays the same while the label might not (used to remember the last one picked). */
  key: string;
  label: string;
  icon: ReactNode;
  title: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  /** Keyboard shortcut shown in the list, e.g. "R". */
  shortcut?: string;
}

const remembered = (id: string): string | null => {
  try {
    return localStorage.getItem(`partsmith.toolGroup.${id}`);
  } catch {
    return null;
  }
};
const remember = (id: string, key: string) => {
  try {
    localStorage.setItem(`partsmith.toolGroup.${id}`, key);
  } catch {
    // Not remembered; the first tool shows next time.
  }
};

export function ToolGroupButton({ id, name, items, pressed = false }: { id: string; name: string; items: GroupItem[]; pressed?: boolean }) {
  const [last, setLast] = useState<string | null>(() => remembered(id));
  const [open, setOpen] = useState(false);
  const arrow = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  // The tool in use shows on the button; otherwise the last one picked.
  const shown = items.find((i) => i.active) ?? items.find((i) => i.key === last) ?? items[0];

  const pick = (item: GroupItem) => {
    setOpen(false);
    setLast(item.key);
    remember(id, item.key);
    item.onClick();
  };

  useLayoutEffect(() => {
    if (!open || !arrow.current) return;
    const r = arrow.current.getBoundingClientRect();
    setAt({ left: Math.max(4, Math.min(r.left - 40, window.innerWidth - 230)), top: r.bottom + 4 });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !arrow.current?.contains(e.target as Node)) setOpen(false);
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
        arrow.current?.focus();
      }
    };
    const close = () => setOpen(false);
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("resize", close);
    };
  }, [open]);
  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [open, at]);

  const allOff = items.every((i) => i.disabled);
  return (
    <div className="tool-split">
      <button
        className={`tool-button${shown.active || pressed ? " active" : ""}`}
        onClick={() => pick(shown)}
        disabled={shown.disabled}
        title={shown.title}
        aria-label={shown.label}
        aria-pressed={shown.active}
      >
        {shown.icon}
        <span>{shown.label}</span>
      </button>
      <button
        ref={arrow}
        className={`tool-split-arrow${open ? " open" : ""}`}
        onClick={() => setOpen((o) => !o)}
        disabled={allOff}
        title={`More ${name} tools: ${items.map((i) => i.label).join(", ")}`}
        aria-label={`More ${name} tools`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-items={`|${items.map((i) => i.label).join("|")}|`}
      >
        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M1 2.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open &&
        at &&
        createPortal(
          <div
            ref={menu}
            className="tool-menu"
            role="menu"
            aria-label={`${name} tools`}
            style={{ left: at.left, top: at.top }}
            onKeyDown={(e) => {
              if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
              e.preventDefault();
              const buttons = [...(menu.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
              const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
              buttons[(i + (e.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus();
            }}
          >
            {items.map((item) => (
              <button
                key={item.key}
                role="menuitem"
                className={item.active ? "active" : ""}
                disabled={item.disabled}
                onClick={() => pick(item)}
                title={item.title}
                aria-label={item.label}
              >
                <span className="tool-menu-icon">{item.icon}</span>
                <span className="tool-menu-label">{item.label}</span>
                {item.shortcut && <kbd>{item.shortcut}</kbd>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </div>
  );
}
