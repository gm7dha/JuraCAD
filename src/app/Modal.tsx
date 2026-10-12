import { useEffect, useRef, type ReactNode } from "react";

import { Icons } from "./icons";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

/** A centred dialog box. Closes on Escape or the ✕ button. */
export function Modal({ title, onClose, children, footer, width = 520 }: ModalProps) {
  const ref = useRef<HTMLDivElement>(null);
  // Keep the latest onClose without re-running the effects below on every render.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Focus the dialog once when it opens — never again, or it would steal the
  // cursor from text boxes inside it every time the dialog redraws.
  useEffect(() => {
    if (!ref.current?.contains(document.activeElement)) ref.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onCloseRef.current();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title} style={{ width }} ref={ref} tabIndex={-1}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <Icons.Cross size={18} />
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  );
}
