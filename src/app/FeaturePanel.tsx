import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import { describeParamErrors, FEATURE_DEFS, isPatternFeature, isPickFeature, isSolidFeature, OPERATION_LABELS } from "../model/features";
import { useDocument, useStore, type DatumName, type PlaneName } from "../model/store";
import type { Feature, FeatureType } from "../model/types";
import { viewportApi } from "../viewport/Viewport";
import { Icons } from "./icons";

const TYPE_ICONS: Record<FeatureType, (p: { size?: number }) => ReactNode> = {
  box: Icons.Box,
  cylinder: Icons.Cylinder,
  sphere: Icons.Sphere,
  sketch: Icons.Sketch,
  extrude: Icons.Extrude,
  revolve: Icons.Revolve,
  shell: Icons.Shell,
  fillet: Icons.Fillet,
  mirror: Icons.Mirror,
  linearPattern: Icons.LinearPattern,
  circularPattern: Icons.CircularPattern,
  chamfer: Icons.Chamfer,
};

type MenuEntry = { label: string; action: () => void; danger?: boolean } | "divider";

interface MenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    const blur = () => onCloseRef.current();
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
      window.removeEventListener("blur", blur);
    };
  }, []);

  return (
    <div className="context-menu" ref={ref} style={{ left: menu.x, top: menu.y }} role="menu">
      {menu.entries.map((entry, i) =>
        entry === "divider" ? (
          <div className="menu-divider" key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`menu-item${entry.danger ? " danger" : ""}`}
            onClick={() => {
              entry.action();
              onClose();
            }}
          >
            {entry.label}
          </button>
        ),
      )}
    </div>
  );
}

function EyeButton({ hidden, name, onToggle }: { hidden: boolean; name: string; onToggle: () => void }) {
  return (
    <button
      className={`icon-button small eye${hidden ? " is-hidden" : ""}`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      onDoubleClick={(e) => e.stopPropagation()}
      aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
      title={hidden ? "Show" : "Hide"}
    >
      {hidden ? <Icons.EyeOff size={16} /> : <Icons.Eye size={16} />}
    </button>
  );
}

/** Origin and the Top / Front / Right planes, which every Part Studio starts with. */
function DatumRow({ name, onMenu }: { name: DatumName; onMenu: (e: ReactMouseEvent, entries: MenuEntry[]) => void }) {
  const isPlane = name !== "Origin";
  const plane = isPlane ? (name as PlaneName) : null;
  const selected = useStore((s) => plane !== null && s.selectedPlane === plane);
  const hidden = useStore((s) => s.hiddenDatums.includes(name));
  const selectPlane = useStore((s) => s.selectPlane);
  const setListHoverPlane = useStore((s) => s.setListHoverPlane);
  const toggleDatum = useStore((s) => s.toggleDatum);

  const entries: MenuEntry[] = [
    ...(plane ? [{ label: "View normal to", action: () => viewportApi.current?.viewNormalToPlane(plane) }] : []),
    { label: hidden ? "Show" : "Hide", action: () => toggleDatum(name) },
  ];

  return (
    <li
      className={["feature-row", "datum", selected && "selected", hidden && "hidden"].filter(Boolean).join(" ")}
      onClick={() => {
        if (!plane || hidden) return;
        const st = useStore.getState();
        if (st.sketch && st.editing?.draft.sketch && !st.editing.draft.sketch.plane) st.setSketchPlane({ kind: "default", name: plane });
        else if (st.editing?.draft.type === "mirror") st.setDraftMirrorPlane({ kind: "default", name: plane });
        else selectPlane(selected ? null : plane);
      }}
      onDoubleClick={() => plane && viewportApi.current?.viewNormalToPlane(plane)}
      onMouseEnter={() => plane && !hidden && setListHoverPlane(plane)}
      onMouseLeave={() => plane && setListHoverPlane(null)}
      onContextMenu={(e) => onMenu(e, entries)}
      title={
        plane
          ? `${name} plane. Click to select, double-click to look straight at it, right-click for more.`
          : "The origin (0, 0, 0). Right-click to hide or show it."
      }
    >
      <span className={`feature-icon${plane ? " plane" : ""}`}>{plane ? <Icons.Plane size={18} /> : <Icons.Origin size={18} />}</span>
      <span className="feature-name">{name}</span>
      <EyeButton hidden={hidden} name={name} onToggle={() => toggleDatum(name)} />
    </li>
  );
}

function FeatureRow({ feature, onMenu }: { feature: Feature; onMenu: (e: ReactMouseEvent, entries: MenuEntry[]) => void }) {
  const kernelError = useStore((s) => s.featureErrors[feature.id]);
  const selected = useStore((s) => s.selectedFeatureId === feature.id);
  const editing = useStore((s) => s.editing?.draft.id === feature.id);
  const selectFeature = useStore((s) => s.selectFeature);
  const startEdit = useStore((s) => s.startEdit);
  const toggleSuppressed = useStore((s) => s.toggleSuppressed);
  const deleteFeature = useStore((s) => s.deleteFeature);
  const renameFeature = useStore((s) => s.renameFeature);
  const Icon = TYPE_ICONS[feature.type];
  const error = kernelError ?? describeParamErrors(feature);
  const isSource = useStore((s) => {
    const d = s.editing?.draft;
    return !!d && ((d.mirror?.sources ?? d.pattern?.sources ?? []) as string[]).includes(feature.id);
  });
  const op =
    feature.operation === "new" || feature.type === "sketch" || isPickFeature(feature.type) || isPatternFeature(feature.type) ? "" : ` (${OPERATION_LABELS[feature.operation]})`;

  const entries: MenuEntry[] = [
    { label: "Edit…", action: () => startEdit(feature.id) },
    {
      label: "Rename…",
      action: () => {
        const name = window.prompt("Rename feature", feature.name);
        if (name !== null) renameFeature(feature.id, name);
      },
    },
    { label: feature.suppressed ? "Unsuppress" : "Suppress", action: () => toggleSuppressed(feature.id) },
    "divider",
    { label: "Delete", action: () => deleteFeature(feature.id), danger: true },
  ];

  return (
    <li
      className={[
        "feature-row",
        selected && "selected",
        editing && "editing",
        error && !feature.suppressed && "failed",
        feature.suppressed && "suppressed",
        isSource && "source",
      ]
        .filter(Boolean)
        .join(" ")}
      onClick={() => {
        // While a mirror or pattern is open, clicking a feature adds it to (or removes it from) what's repeated.
        const st = useStore.getState();
        const d = st.editing?.draft;
        if (d && isPatternFeature(d.type) && d.id !== feature.id) {
          if (isSolidFeature(feature.type)) st.toggleDraftSource(feature.id);
          else st.showToast(`${feature.name} doesn't add or cut a solid, so it can't be ${d.type === "mirror" ? "mirrored" : "patterned"}.`);
          return;
        }
        selectFeature(feature.id);
      }}
      onDoubleClick={() => startEdit(feature.id)}
      onContextMenu={(e) => onMenu(e, entries)}
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

const DATUMS: DatumName[] = ["Origin", "Top", "Front", "Right"];

export function FeaturePanel() {
  const doc = useDocument();
  const parts = useStore((s) => s.parts);
  const hiddenParts = useStore((s) => s.hiddenParts);
  const toggleHidden = useStore((s) => s.toggleHidden);
  const draftIsNew = useStore((s) => (s.editing?.mode === "create" ? s.editing.draft : null));
  const [menu, setMenu] = useState<MenuState | null>(null);

  const onMenu = (e: ReactMouseEvent, entries: MenuEntry[]) => {
    e.preventDefault();
    setMenu({ x: e.clientX, y: e.clientY, entries });
  };

  const features = doc.features;

  return (
    <aside className="side-panel" aria-label="Feature list">
      <section className="panel-section features">
        <h3>
          Features <span className="count">({features.length})</span>
        </h3>
        <ul className="feature-list">
          {DATUMS.map((d) => (
            <DatumRow key={d} name={d} onMenu={onMenu} />
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
                <EyeButton hidden={hidden} name={p.name} onToggle={() => toggleHidden(p.id)} />
              </li>
            );
          })}
        </ul>
        {parts.length === 0 && <p className="panel-hint">No parts yet.</p>}
      </section>

      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </aside>
  );
}
