/**
 * Assembly features (Onshape's) and Edit in context, in the app:
 * - `AssemblyFeaturesSection`: the "Assembly features" list in the assembly's
 *   left panel (suppress, delete, which parts each one cuts);
 * - `AsmCutPanel`: the Hole / Cut dialog (click a flat face, then where each
 *   hole or cut goes; sizes; which parts);
 * - `asmCutPick`: what a click in the 3D view does while it's open;
 * - `InstanceMenu`: an instance row's right-click menu (Edit in context);
 * - `ContextBar`: in a Part Studio with contexts, shows each one with Update
 *   context / Hide / Remove.
 * The rules are pure in src/assembly/assemblyFeatures.ts and inContext.ts;
 * the state and actions are in assemblyFeatureState.ts.
 */
import { useEffect, useRef, useState } from "react";

import { assemblyFeatureDependents, assemblyFeaturesOf } from "../assembly/assemblyFeatures";
import { applyPlacement, compose, rotate, type Vec3 } from "../assembly/math";
import { solveWithParts } from "../assembly/mates";
import { findMesh, meshIdOf } from "../assembly/configured";
import { leavesOf } from "../assembly/subassembly";
import { evaluate } from "../model/expr";
import { activeAssembly, activeStudioId, useLengthUnit, useStore } from "../model/store";
import { lengthNumber, storeLength } from "../model/units";
import type { Assembly, Feature } from "../model/types";
import { planeFrame, planeOnFace } from "../sketch/planes";
import type { PickTarget } from "../viewport/SceneManager";
import { useAssemblyLeaves } from "./assemblySolve";
import {
  acceptAsmCut,
  cancelAsmCut,
  changeAsmCut,
  cutMeshFor,
  deleteAsmFeatures,
  editInContext,
  forgetContext,
  hideContext,
  setAsmFeatureParts,
  toggleAsmFeatureSuppressed,
  updateContextNow,
  useAsmFeatures,
} from "./assemblyFeatureState";
import { Icons } from "./icons";

// ---------------------------------------------------------------------------
// The list in the left panel

export function AssemblyFeaturesSection({ assembly }: { assembly: Assembly }) {
  const list = assemblyFeaturesOf(assembly);
  const errors = useAsmFeatures((s) => (s.cuts?.assembly.id === assembly.id ? s.cuts.result.errors : null));
  const reached = useAsmFeatures((s) => (s.cuts?.assembly.id === assembly.id ? s.cuts.result.reached : null));
  const leaves = useAssemblyLeaves();
  const [choosing, setChoosing] = useState<string | null>(null);
  if (!list.length) return null;
  const nameOf = (key: string) => leaves.find((l) => l.key === key)?.name ?? "a part that's gone";
  return (
    <section className="panel-section">
      <h3>
        Assembly features <span className="count">({list.length})</span>
      </h3>
      <p className="dialog-hint">Cut only in this assembly — the parts in their Part Studios don't change.</p>
      <ul className="feature-list">
        {list.map((f) => {
          const error = errors?.[f.id];
          const chosen = assembly.featureParts?.[f.id];
          const cuts = reached?.[f.id] ?? [];
          const title = f.type === "sketch" ? "A sketch in the assembly (its holes and cuts use it)" : `${f.type === "hole" ? "Hole" : "Cut"} — ${chosen ? (chosen.length ? `only ${chosen.map(nameOf).join(", ")}` : "no parts chosen") : "every part it reaches"}${cuts.length ? `. Cutting: ${cuts.map(nameOf).join(", ")}` : ""}`;
          return (
            <li key={f.id} className={["feature-row", f.suppressed && "suppressed", error && "failed"].filter(Boolean).join(" ")} title={error ?? title}>
              <span className="feature-icon" aria-hidden="true">
                {f.type === "sketch" ? <Icons.Sketch size={15} /> : f.type === "hole" ? <Icons.Hole size={15} /> : <Icons.Extrude size={15} />}
              </span>
              <span className="feature-name">{f.name}</span>
              {error && (
                <span className="feature-error-icon" aria-label="Problem" title={error}>
                  <Icons.Warning size={16} />
                </span>
              )}
              {f.type !== "sketch" && (
                <button className="text-button small" onClick={() => setChoosing(choosing === f.id ? null : f.id)} aria-expanded={choosing === f.id} title="Choose which parts it cuts">
                  Parts…
                </button>
              )}
              <button className="text-button small" onClick={() => toggleAsmFeatureSuppressed(f.id)} title={f.suppressed ? "Switch it back on" : "Switch it off for now (it cuts nothing)"}>
                {f.suppressed ? "On" : "Off"}
              </button>
              <button
                className="icon-button small"
                onClick={() => {
                  const going = assemblyFeatureDependents(assembly, [f.id]);
                  const more = going.length > 1 ? list.filter((x) => going.includes(x.id) && x.id !== f.id).map((x) => x.name) : [];
                  if (more.length && !window.confirm(`Delete ${f.name} and ${more.join(", ")}, which use${more.length === 1 ? "s" : ""} it?`)) return;
                  deleteAsmFeatures([f.id]);
                }}
                aria-label={`Delete ${f.name}`}
                title="Delete (a sketch takes its holes and cuts with it)"
              >
                <Icons.Trash size={15} />
              </button>
              {choosing === f.id && <PartsChooser assembly={assembly} feature={f} onDone={() => setChoosing(null)} />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Which parts a feature cuts: every top-level part it reaches, or the ones ticked (parts inside sub-assemblies too). */
function PartsChooser({ assembly, feature, onDone }: { assembly: Assembly; feature: Feature; onDone: () => void }) {
  const leaves = useAssemblyLeaves();
  const chosen = assembly.featureParts?.[feature.id] ?? null;
  return (
    <div className="asm-feature-parts" onClick={(e) => e.stopPropagation()}>
      <label className="check-row">
        <input type="checkbox" checked={chosen === null} onChange={(e) => setAsmFeatureParts(feature.id, e.target.checked ? null : leaves.filter((l) => !l.path.length).map((l) => l.key))} />
        Every part it reaches (not inside sub-assemblies)
      </label>
      {chosen !== null &&
        leaves.map((l) => (
          <label className="check-row" key={l.key}>
            <input
              type="checkbox"
              checked={chosen.includes(l.key)}
              onChange={(e) => setAsmFeatureParts(feature.id, e.target.checked ? [...chosen, l.key] : chosen.filter((k) => k !== l.key))}
            />
            {l.name}
          </label>
        ))}
      <button className="text-button small" onClick={onDone}>
        Done
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The Hole / Cut dialog

function LengthBox({ label, value, onCommit }: { label: string; value: number; onCommit: (v: number) => void }) {
  const unit = useLengthUnit();
  const shown = lengthNumber(value, unit, 4);
  const [text, setText] = useState(shown);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setText(shown);
    setError(null);
  }, [shown]);
  const commit = () => {
    if (text.trim() === shown) return;
    const r = evaluate(storeLength(text, unit));
    if (!r.ok) return setError(r.error);
    setError(null);
    onCommit(r.value);
  };
  return (
    <div className={`param-field compact${error ? " invalid" : ""}`}>
      <label>
        {label}
        <div className="param-input">
          <input
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
              }
            }}
            aria-invalid={!!error}
          />
          <span className="unit">{unit}</span>
        </div>
      </label>
      {error && <div className="param-message error">{error}</div>}
    </div>
  );
}

export function AsmCutPanel() {
  const draft = useAsmFeatures((s) => s.draft);
  const asm = useStore(activeAssembly);
  const [problem, setProblem] = useState<string | null>(null);
  if (!draft || !asm) return null;
  const hole = draft.kind === "hole";
  const accept = () => setProblem(acceptAsmCut());
  return (
    <div className="feature-dialog instance-panel" role="region" aria-label={hole ? "Hole in the assembly" : "Cut in the assembly"}>
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">{hole ? "Hole" : "Cut"} (in this assembly)</span>
        <span className="feature-dialog-actions">
          <button type="button" className="dialog-ok" onClick={accept} title="Accept" aria-label="Accept">
            <Icons.Tick size={18} />
          </button>
          <button type="button" className="dialog-cancel" onClick={cancelAsmCut} title="Cancel" aria-label="Cancel">
            <Icons.Cross size={18} />
          </button>
        </span>
      </header>
      <div className="feature-dialog-body">
        <p className="dialog-hint">
          {draft.plane
            ? `On ${draft.label}. Click more places on it to add ${hole ? "holes" : "cuts"}, or type exact positions below (mm across and up the face).`
            : `Click a flat face of a part, where the ${hole ? "hole" : "cut"} goes. It goes through the parts it reaches here, in this assembly only — the parts in their Part Studios don't change.`}
        </p>
        {draft.points.map(([x, y], i) => (
          <div className="param-row" key={i}>
            <LengthBox label={`${i + 1}: across`} value={x} onCommit={(v) => changeAsmCut({ points: draft.points.map((p, k) => (k === i ? [v, p[1]] : p)) })} />
            <LengthBox label="up" value={y} onCommit={(v) => changeAsmCut({ points: draft.points.map((p, k) => (k === i ? [p[0], v] : p)) })} />
            <button className="icon-button small" onClick={() => changeAsmCut({ points: draft.points.filter((_, k) => k !== i) })} aria-label={`Remove place ${i + 1}`} title="Remove this one">
              <Icons.Trash size={14} />
            </button>
          </div>
        ))}
        {!hole && (
          <div className="segmented two" role="radiogroup" aria-label="Shape">
            {(["rectangle", "circle"] as const).map((sh) => (
              <button type="button" key={sh} role="radio" aria-checked={draft.shape === sh} className={draft.shape === sh ? "selected" : ""} onClick={() => changeAsmCut({ shape: sh })}>
                {sh === "rectangle" ? "Rectangle" : "Circle"}
              </button>
            ))}
          </div>
        )}
        {hole || draft.shape === "circle" ? (
          <LengthBox label="Diameter" value={draft.diameter} onCommit={(v) => changeAsmCut({ diameter: v })} />
        ) : (
          <div className="param-row">
            <LengthBox label="Width" value={draft.width} onCommit={(v) => changeAsmCut({ width: v })} />
            <LengthBox label="Height" value={draft.height} onCommit={(v) => changeAsmCut({ height: v })} />
          </div>
        )}
        <label className="check-row">
          <input type="checkbox" checked={draft.throughAll} onChange={(e) => changeAsmCut({ throughAll: e.target.checked })} />
          Through all
        </label>
        {!draft.throughAll && <LengthBox label="Depth" value={draft.depth} onCommit={(v) => changeAsmCut({ depth: v })} />}
        {!draft.throughAll && (
          <label className="check-row">
            <input type="checkbox" checked={draft.flip} onChange={(e) => changeAsmCut({ flip: e.target.checked })} />
            Flip direction (out of the face)
          </label>
        )}
        <p className="dialog-hint">It cuts every part it reaches. Afterwards, “Parts…” in the Assembly features list chooses which.</p>
        {problem && <div className="param-message error">{problem}</div>}
      </div>
    </div>
  );
}

const flipX = (v: Vec3): Vec3 => [-v[0], v[1], v[2]];

/**
 * A click in the 3D view while the Hole / Cut dialog is open: the first flat
 * face clicked is where it's drawn (kept as numbers, in the assembly's
 * coordinates); each click on that face adds a place. True when it was used.
 */
export function asmCutPick(target: PickTarget | null): boolean {
  const draft = useAsmFeatures.getState().draft;
  if (!draft) return false;
  const s = useStore.getState();
  const asm = activeAssembly(s);
  if (!asm || target?.kind !== "part" || target.item.kind !== "face" || !target.point) return true;
  const key = target.item.partId;
  const assemblies = s.history.present.assemblies ?? [];
  const leaf = leavesOf(asm, s.parts, assemblies).find((l) => l.key === key);
  const part = leaf && findMesh(s.parts, meshIdOf(leaf.instance));
  const shown = cutMeshFor(key) ?? part;
  const ref = shown?.faceRefs[target.item.index];
  if (!leaf || !ref) return true;
  if (ref.surface !== "PLANE") {
    s.showToast("That face is curved. Click a flat face.", "info");
    return true;
  }
  const solved = solveWithParts(asm, s.parts, { assemblies });
  const top = solved.placements[leaf.top] ?? asm.instances.find((i) => i.id === leaf.top)!.placement;
  const placement = leaf.path.length ? compose(top, leaf.relative) : top;
  const mirrored = !!leaf.instance.mirrored;
  const normal = rotate(placement.rotation, mirrored ? flipX(ref.normal) : ref.normal);
  const centre = applyPlacement(placement, mirrored ? flipX(ref.center) : ref.center);
  let plane = draft.plane;
  if (!plane) plane = planeOnFace(normal, centre, `a face of ${leaf.name}`);
  const f = planeFrame(plane);
  const p = target.point as Vec3;
  const off = (p[0] - f.origin[0]) * f.n[0] + (p[1] - f.origin[1]) * f.n[1] + (p[2] - f.origin[2]) * f.n[2];
  const facing = normal[0] * f.n[0] + normal[1] * f.n[1] + normal[2] * f.n[2];
  if (draft.plane && (Math.abs(off) > 1e-3 || facing < 0.9999)) {
    s.showToast(`Click on ${draft.label} again (it's drawn on that face), or Cancel to start on another face.`, "info");
    return true;
  }
  const x = (p[0] - f.origin[0]) * f.u[0] + (p[1] - f.origin[1]) * f.u[1] + (p[2] - f.origin[2]) * f.u[2];
  const y = (p[0] - f.origin[0]) * f.v[0] + (p[1] - f.origin[1]) * f.v[1] + (p[2] - f.origin[2]) * f.v[2];
  const r = (v: number) => Math.round(v * 1000) / 1000 || 0;
  changeAsmCut({ plane, label: draft.plane ? draft.label : `a face of ${leaf.name}`, points: [...draft.points, [r(x), r(y)]] });
  return true;
}

// ---------------------------------------------------------------------------
// Edit in context

/** An instance row's right-click menu. */
export function InstanceMenu({ at, partKey, onClose }: { at: { x: number; y: number }; partKey: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const away = (e: Event) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      if (e instanceof MouseEvent && ref.current?.contains(e.target as Node)) return;
      close.current();
    };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", away);
    return () => {
      window.removeEventListener("mousedown", away);
      window.removeEventListener("keydown", away);
    };
  }, []);
  return (
    <div className="context-menu" ref={ref} style={{ left: at.x, top: at.y, position: "fixed" }} role="menu">
      <button
        role="menuitem"
        className="menu-item"
        title="Open this part's Part Studio with the assembly's other parts shown round it, to sketch on and use their edges"
        onClick={() => {
          onClose();
          editInContext(partKey);
        }}
      >
        Edit in context
      </button>
    </div>
  );
}

/** In a Part Studio with contexts: one line each, with Update context, Show/Hide and Remove. */
export function ContextBar() {
  const studio = useStore(activeStudioId);
  const inAssembly = useStore((s) => !!activeAssembly(s));
  const contexts = useStore((s) => s.history.present.contexts);
  const here = contexts?.filter((c) => c.studioId === studio) ?? [];
  if (inAssembly || !here.length) return null;
  return (
    <div className="context-bar" role="region" aria-label="Edit in context">
      {here.map((c) => (
        <div className="context-bar-row" key={c.id}>
          <span title="The assembly's other parts are shown faint for reference: sketch on their faces, snap to them and Use their edges. Their places are as they were when this context was taken.">
            In context: <strong>{c.name}</strong>
          </span>
          <button className="text-button small" onClick={() => updateContextNow(c.id)} title="Take the parts' places from the assembly again (sketches using their edges follow)">
            Update context
          </button>
          <button className="text-button small" onClick={() => hideContext(c.id, !c.hidden)} title={c.hidden ? "Show its parts again" : "Hide its parts (sketches using them keep working)"}>
            {c.hidden ? "Show" : "Hide"}
          </button>
          <button
            className="text-button small"
            onClick={() => {
              if (window.confirm(`Remove the context ${c.name}? Sketches using its parts' edges will say those references are lost.`)) forgetContext(c.id);
            }}
            title="Remove this context"
          >
            Remove
          </button>
        </div>
      ))}
    </div>
  );
}
