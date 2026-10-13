/**
 * The assembly tab: its toolbar, the list of instances and parts, the Insert
 * panel and the panel for placing the selected instance.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { billOfMaterials, bomCsv, boundsOfVertices, placedBox, spotBeside, type Box3 } from "../assembly/assembly";
import { eulerDegFromQuat, quatFromEulerDeg, type Placement } from "../assembly/math";
import { DEFAULT_PART_COLOUR } from "../model/colours";
import { evaluate } from "../model/expr";
import { activeAssembly, useStore } from "../model/store";
import type { Assembly, Instance } from "../model/types";
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

/** Box of each part, worked out once per rebuild. */
const boxCache = new WeakMap<PartMesh, Box3 | null>();
function partBox(p: PartMesh): Box3 | null {
  if (!boxCache.has(p)) boxCache.set(p, boundsOfVertices(p.vertices));
  return boxCache.get(p) ?? null;
}

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
      <div className="toolbar-spacer" />
      <div className="tool-group">
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

/** Left panel in an assembly: its instances, then the bill of materials. */
export function AssemblyPanel({ assembly }: { assembly: Assembly }) {
  const parts = useStore((s) => s.parts);
  const docName = useStore((s) => s.history.present.name);
  const partNames = useMemo(() => Object.fromEntries(parts.map((p) => [p.id, p.name])), [parts]);
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
            <ul className="insert-list">
              {parts.map((p) => {
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
          </>
        )}
      </div>
    </div>
  );
}

/** A number box that accepts maths and units, and applies the value on Enter or when you leave it. */
function NumberBox({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }) {
  const shown = String(Math.round(value * 1e4) / 1e4);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(shown);
    setError(null);
  }, [shown]);
  const commit = () => {
    if (text.trim() === shown) return;
    const r = evaluate(text);
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
        <span className="unit">{unit}</span>
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
  const instance = asm && selection.length === 1 ? asm.instances.find((i) => i.id === selection[0]) : undefined;
  if (!instance || insertOpen) return null;
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
      </div>
    </div>
  );
}
