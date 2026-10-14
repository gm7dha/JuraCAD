/**
 * The assembly tab: its toolbar, the list of instances and parts, the Insert
 * panel and the panel for placing the selected instance.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { billOfMaterials, bomCsv, placedBox, spotBeside, type Box3 } from "../assembly/assembly";
import { eulerDegFromQuat, quatFromEulerDeg, type Placement } from "../assembly/math";
import { DEFAULT_PART_COLOUR } from "../model/colours";
import { evaluate } from "../model/expr";
import { activeAssembly, partsInStudio, useLengthUnit, useStore } from "../model/store";
import { fromUnit, lengthNumber, showLength, storeLength } from "../model/units";
import { studiosOf } from "../model/studios";
import type { Assembly, Instance, Mate, MateConnector, MateType } from "../model/types";
import { MATE_ORDER, MATE_TYPES, mateLimits, mateValues } from "../assembly/mates";
import { partBox, useSolvedAssembly } from "./assemblySolve";
import type { PartMesh } from "../kernel/protocol";
import { viewportApi } from "../viewport/Viewport";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { detectPlatform, shortcut } from "./platform";
import { startSection } from "./SectionPanel";

function ToolButton({ label, icon, onClick, disabled, active, title }: { label: string; icon: ReactNode; onClick?: () => void; disabled?: boolean; active?: boolean; title?: string }) {
  return (
    <button className={`tool-button${active ? " active" : ""}`} onClick={onClick} disabled={disabled} title={title ?? label} aria-label={label}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

const MATE_ICONS: Record<MateType, (p: { size?: number }) => ReactNode> = {
  fastened: Icons.MateFasten,
  revolute: Icons.MateRevolute,
  slider: Icons.MateSlider,
  cylindrical: Icons.MateCylindrical,
  planar: Icons.MatePlanar,
  ball: Icons.MateBall,
};


/** Put a copy of a part into the assembly on show, beside what's already there. */
export function insertPart(part: PartMesh) {
  const s = useStore.getState();
  const asm = activeAssembly(s);
  if (!asm) return;
  const boxes: Box3[] = [];
  for (const i of asm.instances) {
    const p = s.parts.find((x) => x.id === i.partId);
    const b = p && partBox(p);
    if (b) boxes.push(placedBox(b, i.placement));
  }
  const box = partBox(part);
  s.insertInstance({ id: part.id, name: part.name }, box ? spotBeside(boxes, box) : undefined);
}

export function AssemblyToolbar() {
  const canUndo = useStore((s) => s.history.past.length > 0);
  const canRedo = useStore((s) => s.history.future.length > 0);
  const undo = useStore((s) => s.undo);
  const redo = useStore((s) => s.redo);
  const asm = useStore(activeAssembly);
  const selection = useStore((s) => s.asmSelection);
  const insertOpen = useStore((s) => s.dialog === "insert");
  const sectionOn = useStore((s) => s.section !== null);
  const draftType = useStore((s) => s.mateDraft?.mate.type ?? null);
  const platform = detectPlatform();
  const selected = asm?.instances.filter((i) => selection.includes(i.id)) ?? [];
  const allFixed = selected.length > 0 && selected.every((i) => i.fixed);

  return (
    <div className="toolbar" role="toolbar" aria-label="Assembly tools">
      <div className="tool-group">
        <ToolButton label="Undo" icon={<Icons.Undo />} onClick={undo} disabled={!canUndo} title={`Undo (${shortcut(platform, "Z")})`} />
        <ToolButton label="Redo" icon={<Icons.Redo />} onClick={redo} disabled={!canRedo} title={`Redo (${shortcut(platform, platform === "mac" ? "Z" : "Y", { shift: platform === "mac" })})`} />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        <ToolButton
          label="Insert"
          icon={<Icons.Insert />}
          onClick={() => useStore.getState().openDialog(insertOpen ? null : "insert")}
          active={insertOpen}
          title="Insert — put copies of your Part Studio parts into this assembly"
        />
        <ToolButton
          label={allFixed ? "Unfix" : "Fix"}
          icon={<Icons.Pin />}
          disabled={selected.length === 0}
          onClick={() => selected.forEach((i) => useStore.getState().updateInstance(i.id, { fixed: !allFixed }))}
          title={selected.length ? (allFixed ? "Unfix — let the selected parts move again" : "Fix — keep the selected parts where they are") : "Select a part first"}
        />
        <ToolButton
          label="Delete"
          icon={<Icons.Trash />}
          disabled={selected.length === 0}
          onClick={() => useStore.getState().removeInstances(selected.map((i) => i.id))}
          title={selected.length ? "Remove the selected parts from this assembly (Delete)" : "Select a part first"}
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        {MATE_ORDER.map((type) => {
          const Icon = MATE_ICONS[type];
          const enough = (asm?.instances.length ?? 0) >= 2;
          return (
            <ToolButton
              key={type}
              label={MATE_TYPES[type].label}
              icon={<Icon />}
              onClick={() => useStore.getState().startMate(type)}
              disabled={!enough}
              active={draftType === type}
              title={enough ? `${MATE_TYPES[type].label} — ${MATE_TYPES[type].description}` : "Insert at least two parts first, then join them with a mate"}
            />
          );
        })}
      </div>
      <div className="toolbar-spacer" />
      <div className="tool-group">
        <ToolButton
          label="Explode"
          icon={<Icons.Explode />}
          onClick={() => {
            const s = useStore.getState();
            s.setExplode(asm?.explode ? null : 1);
            s.setAsmSelection([]);
            // Zoom to show the parts in their new places.
            setTimeout(() => viewportApi.current?.fit(), 50);
          }}
          disabled={(asm?.instances.length ?? 0) < 2 || draftType !== null}
          active={!!asm?.explode}
          title={asm?.explode ? "Put the parts back together" : "Exploded view — pull the parts apart to show how they go together"}
        />
        <ToolButton
          label="Section"
          icon={<Icons.Section />}
          onClick={() => (useStore.getState().section ? useStore.getState().setSection(null) : startSection())}
          disabled={!asm?.instances.length}
          active={sectionOn}
          title="Section view — slice the view open to see inside"
        />
      </div>
      <div className="tool-group">
        <ToolButton label="Fit" icon={<Icons.Fit />} onClick={() => viewportApi.current?.fit()} title="Zoom to fit (F)" />
      </div>
    </div>
  );
}

function InstanceRow({ instance, missing }: { instance: Instance; missing: boolean }) {
  const selected = useStore((s) => s.asmSelection.includes(instance.id));
  const hidden = useStore((s) => s.hiddenInstances.includes(instance.id));
  const colour = useStore((s) => s.history.present.appearance?.[instance.partId] ?? DEFAULT_PART_COLOUR);
  return (
    <li
      className={["feature-row", selected && "selected", hidden && "hidden", missing && "failed"].filter(Boolean).join(" ")}
      onClick={(e) => {
        const s = useStore.getState();
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (additive) s.setAsmSelection(selected ? s.asmSelection.filter((x) => x !== instance.id) : [...s.asmSelection, instance.id]);
        else s.setAsmSelection(selected && s.asmSelection.length === 1 ? [] : [instance.id]);
      }}
      title={missing ? "Its part no longer exists in the Part Studio" : instance.fixed ? "Fixed — it stays where it is" : "Click to select; Shift-click to add"}
    >
      <span className="instance-colour" style={{ background: colour }} aria-hidden="true" />
      <span className="feature-name">{instance.name}</span>
      {instance.fixed && (
        <span className="instance-fixed" title="Fixed" aria-label="Fixed">
          <Icons.Pin size={15} />
        </span>
      )}
      {missing && (
        <span className="feature-error-icon" aria-label="Missing part">
          <Icons.Warning size={16} />
        </span>
      )}
      <button
        className={`icon-button small eye${hidden ? " is-hidden" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          useStore.getState().toggleInstanceHidden(instance.id);
        }}
        aria-label={hidden ? `Show ${instance.name}` : `Hide ${instance.name}`}
        title={hidden ? "Show" : "Hide"}
      >
        {hidden ? <Icons.EyeOff size={16} /> : <Icons.Eye size={16} />}
      </button>
    </li>
  );
}

function MateRow({ mate, error, instanceNames }: { mate: Mate; error?: string; instanceNames: Record<string, string> }) {
  const editing = useStore((s) => s.mateDraft?.mate.id === mate.id);
  const Icon = MATE_ICONS[mate.type];
  const between = `${instanceNames[mate.a.instanceId] ?? "?"} and ${instanceNames[mate.b.instanceId] ?? "?"}`;
  return (
    <li
      className={["feature-row", editing && "editing", error && !mate.suppressed && "failed", mate.suppressed && "suppressed"].filter(Boolean).join(" ")}
      onDoubleClick={() => useStore.getState().editMate(mate.id)}
      title={mate.suppressed ? "Suppressed — not used" : error ? `Problem: ${error}` : `${MATE_TYPES[mate.type].label} joining ${between}. Double-click to edit.`}
    >
      <span className="feature-icon">
        <Icon size={18} />
      </span>
      <span className="feature-name">{mate.name}</span>
      {error && !mate.suppressed && (
        <span className="feature-error-icon" aria-label="Problem">
          <Icons.Warning size={16} />
        </span>
      )}
      <span className="row-actions">
        <button className="icon-button small" onClick={() => useStore.getState().editMate(mate.id)} aria-label={`Edit ${mate.name}`} title="Edit">
          <Icons.Sketch size={15} />
        </button>
        <button
          className="icon-button small"
          onClick={() => useStore.getState().toggleMateSuppressed(mate.id)}
          aria-label={mate.suppressed ? `Use ${mate.name} again` : `Suppress ${mate.name}`}
          title={mate.suppressed ? "Use again" : "Suppress (switch off for now)"}
        >
          {mate.suppressed ? <Icons.EyeOff size={15} /> : <Icons.Eye size={15} />}
        </button>
        <button className="icon-button small" onClick={() => useStore.getState().deleteMate(mate.id)} aria-label={`Delete ${mate.name}`} title="Delete (the parts stay where they are)">
          <Icons.Trash size={15} />
        </button>
      </span>
    </li>
  );
}

function MatesSection({ assembly }: { assembly: Assembly }) {
  const { solved } = useSolvedAssembly();
  const mates = assembly.mates ?? [];
  const instanceNames = useMemo(() => Object.fromEntries(assembly.instances.map((i) => [i.id, i.name])), [assembly.instances]);
  return (
    <section className="panel-section mates">
      <h3>
        Mates <span className="count">({mates.length})</span>
      </h3>
      <ul className="feature-list">
        {mates.map((m) => (
          <MateRow key={m.id} mate={m} error={solved?.mateErrors[m.id]} instanceNames={instanceNames} />
        ))}
      </ul>
      {mates.length === 0 && assembly.instances.length >= 2 && (
        <p className="panel-hint">Join parts with a mate: choose Fasten, Hinge, Slider… in the toolbar, then click a face or edge on each part.</p>
      )}
    </section>
  );
}

/** Left panel in an assembly: its instances, then the bill of materials. */
export function AssemblyPanel({ assembly }: { assembly: Assembly }) {
  const parts = useStore((s) => s.parts);
  const docName = useStore((s) => s.history.present.name);
  const doc = useStore((s) => s.history.present);
  const partNames = useMemo(() => {
    const studios = studiosOf(doc);
    const label = (p: PartMesh) => {
      if (studios.length < 2) return p.name;
      return `${p.name} (${studios.find((st) => st.id === (p.studioId ?? "main"))?.name ?? "Part Studio"})`;
    };
    return Object.fromEntries(parts.map((p) => [p.id, label(p)]));
  }, [parts, doc]);
  const bom = useMemo(() => billOfMaterials(assembly, partNames), [assembly, partNames]);
  const kernelReady = useStore((s) => s.kernelStatus === "ready");

  return (
    <aside className="side-panel" aria-label="Assembly">
      <section className="panel-section features">
        <h3>
          Instances <span className="count">({assembly.instances.length})</span>
        </h3>
        <ul className="feature-list">
          {assembly.instances.map((i) => (
            <InstanceRow key={i.id} instance={i} missing={kernelReady && !partNames[i.partId]} />
          ))}
        </ul>
        {assembly.instances.length === 0 && <p className="panel-hint">Click Insert to bring in parts from the Part Studio.</p>}
      </section>
      <MatesSection assembly={assembly} />
      <section className="panel-section parts">
        <h3>
          Parts list <span className="count">({bom.reduce((n, r) => n + r.quantity, 0)})</span>
        </h3>
        <table className="bom-table" aria-label="Parts list">
          <thead>
            <tr>
              <th>#</th>
              <th>Part</th>
              <th>Qty</th>
            </tr>
          </thead>
          <tbody>
            {bom.map((r, n) => (
              <tr key={r.partId} className={r.missing ? "missing" : ""}>
                <td>{n + 1}</td>
                <td>{r.name}</td>
                <td>{r.quantity}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {bom.length > 0 && (
          <button
            className="text-button bom-download"
            onClick={() => downloadFile(new Blob([bomCsv(bom)], { type: "text/csv" }), `${safeFileName(`${docName} ${assembly.name} parts list`, "Parts list")}.csv`)}
            title="Download the parts list as a spreadsheet (CSV)"
          >
            Download parts list (CSV)
          </button>
        )}
      </section>
    </aside>
  );
}

/** Floating list of the Part Studio's parts, each with an Insert button. */
export function InsertPanel() {
  const open = useStore((s) => s.dialog === "insert");
  const asm = useStore(activeAssembly);
  const parts = useStore((s) => s.parts);
  const doc = useStore((s) => s.history.present);
  const studios = useMemo(() => studiosOf(doc), [doc]);
  if (!open || !asm) return null;
  const close = () => useStore.getState().openDialog(null);
  return (
    <div className="feature-dialog" role="dialog" aria-label="Insert parts">
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">Insert parts</span>
        <span className="feature-dialog-actions">
          <button type="button" className="dialog-ok" onClick={close} title="Done" aria-label="Done">
            <Icons.Tick size={18} />
          </button>
        </span>
      </header>
      <div className="feature-dialog-body">
        {parts.length === 0 ? (
          <p className="dialog-hint">There are no parts yet. Make some in the Part Studio tab first.</p>
        ) : (
          <>
            <p className="dialog-hint">Click a part to put a copy of it into {asm.name}. Click again for more copies.</p>
            {studios.map((st) => {
              const mine = partsInStudio(parts, st.id);
              if (mine.length === 0) return null;
              return (
            <div key={st.id}>
            {studios.length > 1 && <div className="insert-studio">{st.name}</div>}
            <ul className="insert-list">
              {mine.map((p) => {
                const count = asm.instances.filter((i) => i.partId === p.id).length;
                return (
                  <li key={p.id}>
                    <button className="insert-row" onClick={() => insertPart(p)} aria-label={`Insert ${p.name}`}>
                      <Icons.Part size={16} />
                      <span className="feature-name">{p.name}</span>
                      {count > 0 && <span className="muted small">×{count}</span>}
                      <Icons.Plus size={16} />
                    </button>
                  </li>
                );
              })}
            </ul>
            </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

/** A number box that accepts maths and units, and applies the value on Enter or when you leave it. */
function NumberBox({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }) {
  const lengthUnit = useLengthUnit();
  const isLength = unit === "mm";
  const shown = isLength ? lengthNumber(value, lengthUnit, 4) : String(Math.round(value * 1e4) / 1e4);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(shown);
    setError(null);
  }, [shown]);
  const commit = () => {
    if (text.trim() === shown) return;
    const r = evaluate(isLength ? storeLength(text, lengthUnit) : text);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setError(null);
    onCommit(r.value);
  };
  const id = `instance-${label.replace(/\W+/g, "-").toLowerCase()}`;
  return (
    <div className={`param-field compact${error ? " invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      <div className="param-input">
        <input
          id={id}
          value={text}
          spellCheck={false}
          autoComplete="off"
          inputMode="decimal"
          onChange={(e) => setText(e.target.value)}
          onFocus={(e) => e.target.select()}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            } else if (e.key === "Escape") {
              setText(shown);
              setError(null);
              (e.target as HTMLInputElement).blur();
            }
          }}
          aria-invalid={!!error}
        />
        <span className="unit">{isLength ? lengthUnit : unit}</span>
      </div>
      {error && <div className="param-message error">{error}</div>}
    </div>
  );
}

/** Position and turn of the one selected instance. */
export function InstancePanel() {
  const asm = useStore(activeAssembly);
  const selection = useStore((s) => s.asmSelection);
  const insertOpen = useStore((s) => s.dialog === "insert");
  const mating = useStore((s) => s.mateDraft !== null);
  const { solved } = useSolvedAssembly();
  const instance = asm && selection.length === 1 ? asm.instances.find((i) => i.id === selection[0]) : undefined;
  if (!instance || insertOpen || mating) return null;
  const drivenBy = solved?.drivenBy[instance.id];
  const driver = drivenBy ? asm?.mates?.find((m) => m.id === drivenBy) : undefined;
  const update = useStore.getState().updateInstance;
  const { position, rotation } = instance.placement;
  const turn = eulerDegFromQuat(rotation);
  const setPosition = (k: number, v: number) => {
    const p = [...position] as Placement["position"];
    p[k] = v;
    update(instance.id, { placement: { position: p, rotation } });
  };
  const setTurn = (k: number, v: number) => {
    const t = [...turn] as [number, number, number];
    t[k] = v;
    update(instance.id, { placement: { position, rotation: quatFromEulerDeg(t[0], t[1], t[2]) } });
  };

  return (
    <div className="feature-dialog instance-panel" role="region" aria-label={`Place ${instance.name}`}>
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">{instance.name}</span>
        <span className="feature-dialog-actions">
          <button type="button" className="dialog-cancel" onClick={() => useStore.getState().setAsmSelection([])} title="Close (Esc)" aria-label="Close">
            <Icons.Cross size={18} />
          </button>
        </span>
      </header>
      <div className="feature-dialog-body">
        <label className="check-row">
          <input type="checkbox" checked={instance.fixed} onChange={(e) => update(instance.id, { fixed: e.target.checked })} />
          Fixed (stays where it is)
        </label>
        {driver ? (
          <p className="dialog-hint">
            Placed by <strong>{driver.name}</strong>. To move it, change the mate's amounts (double-click the mate), or delete the mate.
          </p>
        ) : (
          <>
        <fieldset className="param-group">
          <legend>Position</legend>
          {(["X (red)", "Y (green)", "Z (blue)"] as const).map((l, k) => (
            <NumberBox key={l} label={l} value={position[k]} unit="mm" onCommit={(v) => setPosition(k, v)} />
          ))}
        </fieldset>
        <fieldset className="param-group">
          <legend>Turned about</legend>
          {(["X", "Y", "Z"] as const).map((l, k) => (
            <NumberBox key={l} label={l} value={turn[k]} unit="°" onCommit={(v) => setTurn(k, v)} />
          ))}
        </fieldset>
        <button
          type="button"
          className="text-button"
          onClick={() => update(instance.id, { placement: { position, rotation: [0, 0, 0, 1] } })}
          disabled={turn.every((t) => t === 0)}
        >
          Straighten (no turn)
        </button>
          </>
        )}
      </div>
    </div>
  );
}

/** The exploded view's settings: how far apart the parts are spread. */
export function ExplodePanel() {
  const asm = useStore(activeAssembly);
  const preview = useStore((s) => s.explodePreview);
  const busy = useStore((s) => s.asmSelection.length > 0 || s.dialog === "insert" || s.mateDraft !== null);
  if (!asm?.explode || busy) return null;
  const st = useStore.getState();
  const amount = preview ?? asm.explode;
  const commit = () => {
    const p = useStore.getState().explodePreview;
    if (p !== null) {
      useStore.getState().setExplode(p);
      setTimeout(() => viewportApi.current?.fit(), 50);
    }
  };
  return (
    <div className="feature-dialog instance-panel" role="region" aria-label="Exploded view">
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">Exploded view</span>
        <span className="feature-dialog-actions">
          <button type="button" className="dialog-cancel" onClick={() => st.setExplode(null)} title="Put the parts back together" aria-label="Close exploded view">
            <Icons.Cross size={18} />
          </button>
        </span>
      </header>
      <div className="feature-dialog-body">
        <label className="field-label" htmlFor="explode-spread">
          Spread: {Math.round(amount * 100)}%
        </label>
        <input
          id="explode-spread"
          type="range"
          className="mate-slider"
          min={0.1}
          max={3}
          step={0.05}
          value={amount}
          onChange={(e) => st.setExplodePreview(Number(e.target.value))}
          onPointerUp={commit}
          onKeyUp={commit}
          onBlur={commit}
        />
        <p className="dialog-hint">
          Parts move straight out from the middle{asm.instances.some((i) => i.fixed) ? " of the fixed parts, which stay put" : ""}. Only the picture changes —
          mates, exports and clash checks use the real places. Drawings of this assembly can show it exploded too.
        </p>
      </div>
    </div>
  );
}

/** "Flat face", "Circular edge"… for showing what was picked. */
function connectorLabel(c: MateConnector): string {
  const ref = c.pick.ref;
  if (ref.kind === "face") {
    if (ref.surface === "PLANE") return "flat face";
    if (ref.surface.startsWith("CYLIND")) return "round face";
    if (ref.surface === "SPHERE") return "ball face";
    if (ref.surface === "CONE") return "cone face";
    return "curved face";
  }
  if (ref.curve === "LINE") return "straight edge";
  if (ref.curve === "CIRCLE") return "circular edge";
  return "curved edge";
}

/** Typed box (live) for a mate amount, with a slider for movements, and optional limits on how far it can go. */
function MateValueField({
  def,
  value,
  onChange,
  limit,
  limitRange,
  limitError,
  onLimit,
}: {
  def: { key: string; label: string; unit: "mm" | "°"; free: boolean };
  value: string;
  onChange: (v: string) => void;
  limit?: { min?: string; max?: string };
  limitRange?: { min: number; max: number };
  limitError?: string;
  onLimit?: (l: { min?: string; max?: string } | undefined) => void;
}) {
  const r = evaluate(value.trim() || "0");
  const id = `mate-${def.key}`;
  const unitNow = useLengthUnit();
  const isLength = def.unit === "mm";
  // Lengths are shown, typed and slid in the design's units (see units.ts).
  const show = (v: string) => (isLength ? showLength(v, unitNow) : v);
  const store = (v: string) => (isLength ? storeLength(v, unitNow) : v);
  const k = isLength ? fromUnit(1, unitNow) : 1;
  const span = def.unit === "°" ? 180 : unitNow === "in" && isLength ? 8 : 200;
  const lo = limitRange && Number.isFinite(limitRange.min) ? limitRange.min / k : -span;
  const hi = limitRange && Number.isFinite(limitRange.max) ? limitRange.max / k : span;
  const ok = lo <= hi;
  return (
    <div className={`param-field compact${r.ok ? "" : " invalid"}`}>
      <label htmlFor={id}>{def.label}</label>
      <div className="param-input">
        <input
          id={id}
          value={show(value)}
          spellCheck={false}
          autoComplete="off"
          inputMode="decimal"
          onChange={(e) => onChange(store(e.target.value))}
          onFocus={(e) => e.target.select()}
          aria-invalid={!r.ok}
        />
        <span className="unit">{isLength ? unitNow : def.unit}</span>
      </div>
      {def.free && (
        <input
          type="range"
          className="mate-slider"
          aria-label={`${def.label} slider`}
          min={ok ? lo : -span}
          max={ok ? hi : span}
          step={def.unit === "°" ? 1 : unitNow === "in" ? 0.0625 : 0.5}
          value={r.ok ? Math.max(ok ? lo : -span, Math.min(ok ? hi : span, r.value / k)) : 0}
          onChange={(e) => onChange(store(e.target.value))}
        />
      )}
      {!r.ok && <div className="param-message error">{r.error}</div>}
      {def.free && onLimit && (
        <>
          <label className="check-row small-text">
            <input type="checkbox" checked={!!limit} onChange={(e) => onLimit(e.target.checked ? { min: def.unit === "°" ? "-90" : "0", max: def.unit === "°" ? "90" : store(unitNow === "in" ? "2" : "50") } : undefined)} />
            Limit how far it {def.unit === "°" ? "turns" : "slides"}
          </label>
          {limit && (
            <div className="mate-limits">
              {(["min", "max"] as const).map((end) => (
                <div className="param-input" key={end}>
                  <input
                    aria-label={`${def.label} ${end === "min" ? "lowest" : "highest"}`}
                    placeholder={end === "min" ? "lowest" : "highest"}
                    value={show(limit[end] ?? "")}
                    spellCheck={false}
                    autoComplete="off"
                    inputMode="decimal"
                    onChange={(e) => onLimit({ ...limit, [end]: store(e.target.value) })}
                  />
                  <span className="unit">{isLength ? unitNow : def.unit}</span>
                </div>
              ))}
            </div>
          )}
          {limitError && <div className="param-message error">{limitError}</div>}
        </>
      )}
    </div>
  );
}

/** The mate dialog: pick a face or edge on two parts, choose the kind of joint and its amounts. */
export function MateDialog() {
  const draftState = useStore((s) => s.mateDraft);
  const asm = useStore(activeAssembly);
  const { solved } = useSolvedAssembly();
  if (!draftState || !asm) return null;
  const { mate, mode } = draftState;
  const st = useStore.getState();
  const def = MATE_TYPES[mate.type];
  const ready = !!mate.a && !!mate.b;
  const { errors } = mateValues(mate);
  const limits = mateLimits(mate);
  const problem = ready ? solved?.mateErrors[mate.id] : undefined;
  const nameOf = (c?: MateConnector) => (c ? asm.instances.find((i) => i.id === c.instanceId)?.name ?? "?" : "");
  const slot = (c: MateConnector | undefined, n: 1 | 2) => (
    <div className={`connector-slot${c ? " filled" : ""}${(!mate.a && n === 1) || (mate.a && !mate.b && n === 2) ? " waiting" : ""}`}>
      <span className="connector-number">{n}</span>
      {c ? (
        <span>
          {nameOf(c)} — {connectorLabel(c)}
        </span>
      ) : (
        <span className="muted">{n === 1 ? "Click a face or edge on the part that stays put" : "Click a face or edge on the part to move"}</span>
      )}
    </div>
  );

  return (
    <form
      className="feature-dialog mate-dialog"
      aria-label="Mate"
      onSubmit={(e) => {
        e.preventDefault();
        st.commitMateDraft();
      }}
    >
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">{def.label} mate</span>
        <span className="feature-dialog-actions">
          <button
            type="submit"
            className="dialog-ok"
            disabled={!ready || Object.keys(errors).length > 0}
            title={ready ? "Accept (Enter)" : "Pick a face or edge on each of two parts first"}
            aria-label="Accept"
          >
            <Icons.Tick size={18} />
          </button>
          <button type="button" className="dialog-cancel" onClick={st.cancelMateDraft} title="Cancel (Esc)" aria-label="Cancel">
            <Icons.Cross size={18} />
          </button>
        </span>
      </header>
      <div className="feature-dialog-body">
        <input className="feature-name-input" value={mate.name} aria-label="Mate name" onChange={(e) => st.setMateDraft({ name: e.target.value })} />
        <label className="field-label" htmlFor="mate-type">
          Kind of mate
        </label>
        <select id="mate-type" value={mate.type} onChange={(e) => st.setMateDraft({ type: e.target.value as MateType })}>
          {MATE_ORDER.map((t) => (
            <option key={t} value={t}>
              {MATE_TYPES[t].label}
            </option>
          ))}
        </select>
        <p className="dialog-hint field-hint">{def.description}</p>
        {slot(mate.a, 1)}
        {slot(mate.b, 2)}
        {ready && (
          <button type="button" className="text-button small-text" onClick={() => st.setMateDraft({ a: undefined, b: undefined })}>
            Pick again
          </button>
        )}
        <label className="check-row">
          <input type="checkbox" checked={mate.flip} onChange={(e) => st.setMateDraft({ flip: e.target.checked })} />
          Flip (turn the moving part round)
        </label>
        {def.values.map((d) => (
          <MateValueField
            key={d.key}
            def={d}
            value={mate.values[d.key] ?? "0"}
            onChange={(v) => st.setMateDraft({ values: { ...mate.values, [d.key]: v } })}
            limit={mate.limits?.[d.key]}
            limitRange={limits.limits[d.key]}
            limitError={limits.errors[d.key]}
            onLimit={(l) => {
              const next = { ...(mate.limits ?? {}) };
              if (l) next[d.key] = l;
              else delete next[d.key];
              st.setMateDraft({ limits: Object.keys(next).length ? next : undefined });
            }}
          />
        ))}
        {problem && <p className="param-message error">{problem}</p>}
        {mode === "edit" && (
          <button type="button" className="text-button danger-text" onClick={() => st.deleteMate(mate.id)}>
            Delete this mate
          </button>
        )}
      </div>
    </form>
  );
}
