import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { describeParamErrors, FEATURE_DEFS, OPERATION_LABELS } from "../model/features";
import { useDocument, useStore } from "../model/store";
import type { Feature, FeatureType } from "../model/types";
import { Icons } from "./icons";

const TYPE_ICONS: Record<FeatureType, (p: { size?: number }) => ReactNode> = {
  box: Icons.Box,
  cylinder: Icons.Cylinder,
  sphere: Icons.Sphere,
};

interface MenuState {
  x: number;
  y: number;
  feature: Feature;
}

function ContextMenu({ menu, onClose, onRename }: { menu: MenuState; onClose: () => void; onRename: (f: Feature) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const startEdit = useStore((s) => s.startEdit);
  const toggleSuppressed = useStore((s) => s.toggleSuppressed);
  const deleteFeature = useStore((s) => s.deleteFeature);

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onClose();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", onClose);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);

  const item = (label: string, action: () => void, danger = false) => (
    <button
      className={`menu-item${danger ? " danger" : ""}`}
      onClick={() => {
        action();
        onClose();
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="context-menu" ref={ref} style={{ left: menu.x, top: menu.y }} role="menu">
      {item("Edit…", () => startEdit(menu.feature.id))}
      {item("Rename…", () => onRename(menu.feature))}
      {item(menu.feature.suppressed ? "Unsuppress" : "Suppress", () => toggleSuppressed(menu.feature.id))}
      <div className="menu-divider" />
      {item("Delete", () => deleteFeature(menu.feature.id), true)}
    </div>
  );
}

function FeatureRow({ feature, onMenu }: { feature: Feature; onMenu: (e: ReactMouseEvent, f: Feature) => void }) {
  const kernelError = useStore((s) => s.featureErrors[feature.id]);
  const selected = useStore((s) => s.selectedFeatureId === feature.id);
  const editing = useStore((s) => s.editing?.draft.id === feature.id);
  const selectFeature = useStore((s) => s.selectFeature);
  const startEdit = useStore((s) => s.startEdit);
  const Icon = TYPE_ICONS[feature.type];
  const error = kernelError ?? describeParamErrors(feature);
  const op = feature.operation === "new" ? "" : ` (${OPERATION_LABELS[feature.operation]})`;

  return (
    <li
      className={[
        "feature-row",
        selected && "selected",
        editing && "editing",
        error && !feature.suppressed && "failed",
        feature.suppressed && "suppressed",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => selectFeature(feature.id)}
      onDoubleClick={() => startEdit(feature.id)}
      onContextMenu={(e) => onMenu(e, feature)}
      title={
        feature.suppressed
          ? "Suppressed — skipped when building"
          : error
            ? `Couldn't build: ${error}`
            : `${FEATURE_DEFS[feature.type].label}${op}. Double-click to edit, right-click for more.`
      }
    >
      <span className="feature-icon">
        <Icon size={18} />
      </span>
      <span className="feature-name">
        {feature.name}
        {op && <span className="feature-op">{op}</span>}
      </span>
      {error && !feature.suppressed && (
        <span className="feature-error-icon" aria-label="Error">
          <Icons.Warning size={16} />
        </span>
      )}
    </li>
  );
}

export function FeaturePanel() {
  const doc = useDocument();
  const parts = useStore((s) => s.parts);
  const hiddenParts = useStore((s) => s.hiddenParts);
  const toggleHidden = useStore((s) => s.toggleHidden);
  const renameFeature = useStore((s) => s.renameFeature);
  const draftIsNew = useStore((s) => (s.editing?.mode === "create" ? s.editing.draft : null));
  const [menu, setMenu] = useState<MenuState | null>(null);

  const onMenu = (e: ReactMouseEvent, feature: Feature) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, feature });
  };

  const onRename = (f: Feature) => {
    const name = window.prompt("Rename feature", f.name);
    if (name !== null) renameFeature(f.id, name);
  };

  const features = doc.features;

  return (
    <aside className="side-panel" aria-label="Feature list">
      <section className="panel-section features">
        <h3>
          Features <span className="count">({features.length})</span>
        </h3>
        <ul className="feature-list">
          <li className="feature-row default">
            <span className="feature-icon">
              <Icons.Origin size={18} />
            </span>
            <span className="feature-name">Origin</span>
          </li>
          {["Top", "Front", "Right"].map((p) => (
            <li className="feature-row default" key={p}>
              <span className="feature-icon plane">
                <Icons.Plane size={18} />
              </span>
              <span className="feature-name">{p}</span>
            </li>
          ))}
          {features.map((f) => (
            <FeatureRow key={f.id} feature={f} onMenu={onMenu} />
          ))}
          {draftIsNew && (
            <li className="feature-row editing draft">
              <span className="feature-icon">{TYPE_ICONS[draftIsNew.type]({ size: 18 })}</span>
              <span className="feature-name">{draftIsNew.name}</span>
            </li>
          )}
        </ul>
        {features.length === 0 && !draftIsNew && (
          <p className="panel-hint">Pick Box, Cylinder or Sphere from the toolbar to add your first solid.</p>
        )}
      </section>

      <section className="panel-section parts">
        <h3>
          Parts <span className="count">({parts.length})</span>
        </h3>
        <ul className="part-list">
          {parts.map((p) => {
            const hidden = hiddenParts.includes(p.id);
            return (
              <li key={p.id} className={`part-row${hidden ? " hidden" : ""}`}>
                <span className="feature-icon part">
                  <Icons.Part size={18} />
                </span>
                <span className="feature-name">{p.name}</span>
                <button
                  className="icon-button small"
                  onClick={() => toggleHidden(p.id)}
                  aria-label={hidden ? `Show ${p.name}` : `Hide ${p.name}`}
                  title={hidden ? "Show" : "Hide"}
                >
                  {hidden ? <Icons.EyeOff size={16} /> : <Icons.Eye size={16} />}
                </button>
              </li>
            );
          })}
        </ul>
        {parts.length === 0 && <p className="panel-hint">No parts yet.</p>}
      </section>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} onRename={onRename} />}
    </aside>
  );
}
