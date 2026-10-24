/**
 * The assembly tab: its toolbar, the list of instances and parts, the Insert
 * panel and the panel for placing the selected instance.
 */
import { canBeDriven, canDrive, nextRelationName, RELATION_KIND_NAMES, RELATION_KINDS } from "../assembly/relations";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { billOfMaterials, bomCsv, bomTotalMass, nextPositionName, placedBox, spotBeside, type BomRow, type Box3 } from "../assembly/assembly";
import { Modal } from "./Modal";
import { formatMass } from "../model/materials";
import { eulerDegFromQuat, quatFromEulerDeg, type Placement } from "../assembly/math";
import { DEFAULT_PART_COLOUR } from "../model/colours";
import { evaluate } from "../model/expr";
import { activeAssembly, partsInStudio, useLengthUnit, useStore } from "../model/store";
import { fromUnit, lengthNumber, showLength, storeLength } from "../model/units";
import { studiosOf } from "../model/studios";
import type { Assembly, ConnectorSpot, ExplodeStep, Instance, Mate, MateConnector, MateRelation, MateType } from "../model/types";
import { stepDistance } from "../assembly/explode";
import { newId } from "../model/document";
import { MATE_ORDER, MATE_TYPES, mateLimits, mateValues } from "../assembly/mates";
import { bomInfo, partBox, useSolvedAssembly } from "./assemblySolve";
import { insertProblem, instanceAt, leafKey, ownBox } from "../assembly/subassembly";
import { mateInactive } from "../assembly/suppress";
import { isOrigin, ORIGIN_ID, ORIGIN_PLANES, originConnector, originPlaneOf } from "../assembly/origin";
import { spotOptions } from "../assembly/connectors";
import type { PartMesh } from "../kernel/protocol";
import { viewportApi } from "../viewport/Viewport";
import { downloadFile, safeFileName } from "./download";
import { ToolGroupButton } from "./ToolGroupButton";
import { Icons } from "./icons";
import { toggleMateAnimation } from "./animateMate";
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
  pinSlot: Icons.MatePinSlot,
  parallel: Icons.MateParallel,
  width: Icons.MateWidth,
  tangent: Icons.MateTangent,
};


/** Boxes round everything already in the assembly on show (parts and sub-assemblies), where they are. */
function boxesInAssembly(): Box3[] {
  const s = useStore.getState();
  const asm = activeAssembly(s);
  const boxes: Box3[] = [];
  for (const i of asm?.instances ?? []) {
    const b = ownBox(asm!, i, s.parts, s.history.present.assemblies ?? [], partBox);
    if (b) boxes.push(placedBox(b, i.placement));
  }
  return boxes;
}

/** Put a copy of a part into the assembly on show, beside what's already there. */
export function insertPart(part: PartMesh) {
  const s = useStore.getState();
  if (!activeAssembly(s)) return;
  const box = partBox(part);
  s.insertInstance({ id: part.id, name: part.name }, box ? spotBeside(boxesInAssembly(), box) : undefined);
}

/** Put a copy of another assembly into the assembly on show (a sub-assembly), beside what's already there. */
export function insertAssembly(sub: Assembly) {
  const s = useStore.getState();
  if (!activeAssembly(s)) return;
  // Its box: round all its parts, where its own mates put them.
  const probe: Assembly = { id: "@insert", name: "", instances: [{ id: "@sub", partId: "", subAssembly: sub.id, name: sub.name, placement: { position: [0, 0, 0], rotation: [0, 0, 0, 1] }, fixed: true }] };
  const box = ownBox(probe, probe.instances[0], s.parts, s.history.present.assemblies ?? [], partBox);
  s.insertSubAssembly(sub.id, box ? spotBeside(boxesInAssembly(), box) : undefined);
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
  const allSuppressed = selected.length > 0 && selected.every((i) => i.suppressed);

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
          title="Insert — put copies of your Part Studio parts, or of other assemblies, into this assembly"
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
        <ToolButton
          label={allSuppressed ? "Unsuppress" : "Suppress"}
          icon={<Icons.Suppress />}
          disabled={selected.length === 0}
          onClick={() => useStore.getState().setInstancesSuppressed(selected.map((i) => i.id), !allSuppressed)}
          title={
            selected.length
              ? allSuppressed
                ? "Unsuppress — bring the selected parts back"
                : "Suppress — switch the selected parts off for now: they're hidden and left out of the parts list, exports, clash checks and mates"
              : "Select a part first (click it in the 3D view or the Instances list)"
          }
        />
        <ToolGroupButton
          id="asm-copies"
          name="copies"
          items={[
            {
              key: "duplicate",
              label: "Duplicate",
              icon: <Icons.Duplicate />,
              disabled: selected.length === 0,
              onClick: () => useStore.getState().duplicateInstances(),
              title: selected.length ? "Duplicate — copy the selected parts (and the mates between them), placed beside everything" : "Select the parts to copy first",
            },
            {
              key: "pattern",
              label: "Pattern",
              icon: <Icons.LinearPattern />,
              disabled: !selected.some((i) => !i.copyOf),
              onClick: () => useStore.getState().createPattern(),
              title: selected.some((i) => !i.copyOf) ? "Pattern — repeat the selected parts in a row or round an axis (the copies follow the originals)" : "Select the parts to repeat first",
            },
            {
              key: "mirror",
              label: "Mirror",
              icon: <Icons.Mirror />,
              disabled: !selected.some((i) => !i.copyOf),
              onClick: () => useStore.getState().createPattern("mirror"),
              title: selected.some((i) => !i.copyOf) ? "Mirror — a mirror-image copy of the selected parts across a plane (the copies follow the originals)" : "Select the parts to mirror first",
            },
            {
              key: "replicate",
              label: "Replicate",
              icon: <Icons.Replicate />,
              disabled: selected.length !== 1,
              onClick: () => useStore.getState().createReplicate(),
              title:
                selected.length === 1
                  ? "Replicate — copy this part into every other hole like the one it's mated into (e.g. a bolt into all the matching holes)"
                  : "Select one part that's mated into a hole first",
            },
          ]}
        />
        <ToolButton
          label="Group"
          icon={<Icons.Group />}
          disabled={selected.length < 2}
          onClick={() => useStore.getState().createGroup()}
          title={selected.length >= 2 ? "Group — lock the selected parts together where they are, so they move as one" : "Select two or more parts first (Ctrl or Shift + click)"}
        />
      </div>
      <div className="tool-divider" />
      <div className="tool-group">
        {MATE_ORDER.slice(0, 5).map((type) => {
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
        <ToolGroupButton
          id="asm-more-mates"
          name="mate"
          items={MATE_ORDER.slice(5).map((type) => {
            const Icon = MATE_ICONS[type];
            const enough = (asm?.instances.length ?? 0) >= 2;
            return {
              key: type,
              label: MATE_TYPES[type].label,
              icon: <Icon />,
              onClick: () => useStore.getState().startMate(type),
              disabled: !enough,
              active: draftType === type,
              title: enough ? `${MATE_TYPES[type].label} — ${MATE_TYPES[type].description}` : "Insert at least two parts first, then join them with a mate",
            };
          })}
        />
      </div>
      <div className="toolbar-spacer" />
      <div className="tool-group">
        <ToolButton
          label="Explode"
          icon={<Icons.Explode />}
          onClick={() => {
            const s = useStore.getState();
            s.setExplode(asm?.explode !== undefined ? null : 1);
            s.setAsmSelection([]);
            // Zoom to show the parts in their new places.
            setTimeout(() => viewportApi.current?.fit(), 50);
          }}
          disabled={(asm?.instances.length ?? 0) < 2 || draftType !== null}
          active={asm?.explode !== undefined}
          title={asm?.explode !== undefined ? "Put the parts back together" : "Exploded view — pull the parts apart to show how they go together"}
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
  const sub = useStore((s) => (instance.subAssembly ? s.history.present.assemblies?.find((a) => a.id === instance.subAssembly) : undefined));
  const [open, setOpen] = useState(false);
  return (
    <>
    <li
      className={["feature-row", selected && "selected", hidden && "hidden", missing && "failed", instance.suppressed && "suppressed"].filter(Boolean).join(" ")}
      onClick={(e) => {
        const s = useStore.getState();
        const additive = e.shiftKey || e.ctrlKey || e.metaKey;
        if (additive) s.setAsmSelection(selected ? s.asmSelection.filter((x) => x !== instance.id) : [...s.asmSelection, instance.id]);
        else s.setAsmSelection(selected && s.asmSelection.length === 1 ? [] : [instance.id]);
      }}
      // Double-click a sub-assembly to open it (its own tab) and change it: every copy follows.
      onDoubleClick={sub ? () => useStore.getState().setActiveTab(sub.id) : undefined}
      title={
        instance.suppressed
          ? "Suppressed — switched off for now. Select it and click Unsuppress to bring it back."
          : missing
            ? "Its part no longer exists in the Part Studio"
            : sub
              ? `A copy of ${sub.name}, moving as one piece${instance.fixed ? " (fixed)" : ""}. Double-click to open ${sub.name} and change it — every copy follows.`
              : instance.fixed
                ? "Fixed — it stays where it is"
                : "Click to select; Shift-click to add"
      }
    >
      {sub ? (
        <button
          className="icon-button small subassembly-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setOpen(!open);
          }}
          aria-expanded={open}
          aria-label={open ? `Hide the parts in ${instance.name}` : `Show the parts in ${instance.name}`}
          title={open ? "Hide its parts" : "Show its parts"}
        >
          {open ? <Icons.ChevronLeft size={14} /> : <Icons.ChevronRight size={14} />}
        </button>
      ) : (
        <span className="instance-colour" style={{ background: colour }} aria-hidden="true" />
      )}
      {sub && (
        <span className="feature-icon" aria-label="Sub-assembly">
          <Icons.Assembly size={15} />
        </span>
      )}
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
      {instance.suppressed ? (
        <span className="instance-suppressed muted" aria-label="Suppressed">
          off
        </span>
      ) : (
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
      )}
    </li>
    {sub && open && <SubAssemblyRows sub={sub} prefix={instance.id} depth={1} within={[sub.id]} />}
    </>
  );
}

/** What's inside a sub-assembly, indented under it: its parts (each can be hidden) and its own sub-assemblies. */
function SubAssemblyRows({ sub, prefix, depth, within }: { sub: Assembly; prefix: string; depth: number; within: string[] }) {
  const all = useStore((s) => s.history.present.assemblies);
  const hiddenList = useStore((s) => s.hiddenInstances);
  const appearance = useStore((s) => s.history.present.appearance);
  const shown = sub.instances.filter((i) => !i.suppressed);
  if (!shown.length) return <li className="feature-row nested muted" style={{ paddingLeft: 12 + 16 * depth }}>(empty)</li>;
  return (
    <>
      {shown.map((i) => {
        const key = `${prefix}/${i.id}`;
        const hidden = hiddenList.includes(key);
        const inner = i.subAssembly && !within.includes(i.subAssembly) ? all?.find((a) => a.id === i.subAssembly) : undefined;
        return (
          <SubRow key={key} rowKey={key} name={i.name} hidden={hidden} depth={depth} colour={appearance?.[i.partId] ?? DEFAULT_PART_COLOUR} inner={inner} within={within} />
        );
      })}
    </>
  );
}

function SubRow({ rowKey, name, hidden, depth, colour, inner, within }: { rowKey: string; name: string; hidden: boolean; depth: number; colour: string; inner?: Assembly; within: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <li
        className={["feature-row", "nested", hidden && "hidden"].filter(Boolean).join(" ")}
        style={{ paddingLeft: 12 + 16 * depth }}
        title={inner ? `A copy of ${inner.name} inside it. Double-click to open ${inner.name}.` : "A part inside the sub-assembly. Mate to it by clicking its faces; open the sub-assembly to move it."}
        onDoubleClick={inner ? () => useStore.getState().setActiveTab(inner.id) : undefined}
      >
        {inner ? (
          <button
            className="icon-button small subassembly-toggle"
            onClick={() => setOpen(!open)}
            aria-expanded={open}
            aria-label={open ? `Hide the parts in ${name}` : `Show the parts in ${name}`}
            title={open ? "Hide its parts" : "Show its parts"}
          >
            {open ? <Icons.ChevronLeft size={14} /> : <Icons.ChevronRight size={14} />}
          </button>
        ) : (
          <span className="instance-colour" style={{ background: colour }} aria-hidden="true" />
        )}
        <span className="feature-name">{name}</span>
        <button
          className={`icon-button small eye${hidden ? " is-hidden" : ""}`}
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().toggleInstanceHidden(rowKey);
          }}
          aria-label={hidden ? `Show ${name}` : `Hide ${name}`}
          title={hidden ? "Show" : "Hide"}
        >
          {hidden ? <Icons.EyeOff size={16} /> : <Icons.Eye size={16} />}
        </button>
      </li>
      {inner && open && <SubAssemblyRows sub={inner} prefix={rowKey} depth={depth + 1} within={[...within, inner.id]} />}
    </>
  );
}

function MateRow({ mate, error, instanceNames, inactive }: { mate: Mate; error?: string; instanceNames: Record<string, string>; inactive: string | null }) {
  const editing = useStore((s) => s.mateDraft?.mate.id === mate.id);
  const Icon = MATE_ICONS[mate.type];
  const playing = useStore((s) => s.animatingMate === mate.id);
  const canAnimate = !inactive && MATE_TYPES[mate.type].values.some((d) => d.free);
  const between = `${instanceNames[mate.a.instanceId] ?? "?"} and ${instanceNames[mate.b.instanceId] ?? "?"}`;
  return (
    <li
      className={["feature-row", editing && "editing", error && !inactive && "failed", inactive && "suppressed"].filter(Boolean).join(" ")}
      onDoubleClick={() => useStore.getState().editMate(mate.id)}
      title={inactive ?? (error ? `Problem: ${error}` : `${MATE_TYPES[mate.type].label} joining ${between}. Double-click to edit.`)}
    >
      <span className="feature-icon">
        <Icon size={18} />
      </span>
      <span className="feature-name">{mate.name}</span>
      {error && !inactive && (
        <span className="feature-error-icon" aria-label="Problem">
          <Icons.Warning size={16} />
        </span>
      )}
      <span className="row-actions">
        {canAnimate && (
          <button
            className={`icon-button small${playing ? " active" : ""}`}
            onClick={() => toggleMateAnimation(mate.id)}
            aria-label={playing ? `Stop animating ${mate.name}` : `Animate ${mate.name}`}
            title={playing ? "Stop" : "Animate — sweep its movement back and forth to see it work"}
          >
            {playing ? <Icons.Stop size={15} /> : <Icons.Play size={15} />}
          </button>
        )}
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
  const instanceNames = useMemo(() => ({ ...Object.fromEntries(assembly.instances.map((i) => [i.id, i.name])), [ORIGIN_ID]: "the origin" }), [assembly.instances]);
  return (
    <section className="panel-section mates">
      <h3>
        Mates <span className="count">({mates.length})</span>
      </h3>
      <ul className="feature-list">
        {mates.map((m) => (
          <MateRow key={m.id} mate={m} error={solved?.mateErrors[m.id]} instanceNames={instanceNames} inactive={mateInactive(assembly, m)} />
        ))}
      </ul>
      {mates.length === 0 && assembly.instances.length >= 2 && (
        <p className="panel-hint">Join parts with a mate: choose Fasten, Hinge, Slider… in the toolbar, then click a face or edge on each part.</p>
      )}
    </section>
  );
}

/** Groups: parts locked together. */
function GroupsSection({ assembly }: { assembly: Assembly }) {
  const { solved } = useSolvedAssembly();
  const groups = assembly.groups ?? [];
  if (!groups.length) return null;
  const names = Object.fromEntries(assembly.instances.map((i) => [i.id, i.name]));
  return (
    <section className="panel-section groups">
      <h3>
        Groups <span className="count">({groups.length})</span>
      </h3>
      <ul className="feature-list">
        {groups.map((g) => {
          const error = solved?.groupErrors?.[g.id];
          return (
            <li
              key={g.id}
              className={["feature-row", error && "failed"].filter(Boolean).join(" ")}
              title={error ? `Problem: ${error}` : `${g.members.map((m) => names[m] ?? "?").join(", ")} — they move as one. Click to select them; double-click to rename.`}
              onClick={() => useStore.getState().setAsmSelection(g.members)}
              onDoubleClick={() => {
                const name = window.prompt("Group name", g.name);
                if (name) useStore.getState().renameGroup(g.id, name);
              }}
            >
              <span className="feature-icon">
                <Icons.Group size={18} />
              </span>
              <span className="feature-name">
                {g.name} <span className="muted">({g.members.length})</span>
              </span>
              {error && (
                <span className="feature-error-icon" aria-label="Problem">
                  <Icons.Warning size={16} />
                </span>
              )}
              <span className="row-actions">
                <button
                  className="icon-button small"
                  onClick={(e) => {
                    e.stopPropagation();
                    useStore.getState().deleteGroup(g.id);
                  }}
                  aria-label={`Ungroup ${g.name}`}
                  title="Ungroup — the parts stay where they are, but move separately again"
                >
                  <Icons.Trash size={15} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Patterns: copies of instances repeated in a row or round an axis. */
function PatternsSection({ assembly }: { assembly: Assembly }) {
  const { solved } = useSolvedAssembly();
  const editing = useStore((s) => s.editingPattern);
  const patterns = assembly.patterns ?? [];
  const replicates = assembly.replicates ?? [];
  if (!patterns.length && !replicates.length) return null;
  return (
    <section className="panel-section patterns">
      <h3>
        Patterns <span className="count">({patterns.length + replicates.length})</span>
      </h3>
      <ul className="feature-list">
        {replicates.map((r) => {
          const copies = assembly.instances.filter((i) => i.replicaOf?.replicate === r.id).length;
          const seed = assembly.instances.find((i) => i.id === r.seed);
          return (
            <li key={r.id} className="feature-row" title={`${seed?.name ?? "A part"} copied into ${copies} more matching hole${copies === 1 ? "" : "s"}.`}>
              <span className="feature-icon">
                <Icons.Replicate size={18} />
              </span>
              <span className="feature-name">
                {r.name} <span className="muted">({copies + 1})</span>
              </span>
              <span className="row-actions">
                <button className="icon-button small" onClick={() => useStore.getState().refreshReplicate(r.id)} aria-label={`Update ${r.name}`} title="Look for matching holes again (after the part has changed)">
                  <Icons.Redo size={15} />
                </button>
                <button className="icon-button small" onClick={() => useStore.getState().deleteReplicate(r.id)} aria-label={`Delete ${r.name}`} title="Delete (and its copies)">
                  <Icons.Trash size={15} />
                </button>
              </span>
            </li>
          );
        })}
        {patterns.map((p) => {
          const error = solved?.patternErrors?.[p.id];
          return (
            <li
              key={p.id}
              className={["feature-row", editing === p.id && "editing", error && "failed"].filter(Boolean).join(" ")}
              onDoubleClick={() => useStore.getState().setEditingPattern(p.id)}
              title={error ? `Problem: ${error}` : `${p.count} in ${p.kind === "linear" ? "a row" : "a circle"}. Double-click to edit.`}
            >
              <span className="feature-icon">{p.kind === "linear" ? <Icons.LinearPattern size={18} /> : p.kind === "mirror" ? <Icons.Mirror size={18} /> : <Icons.CircularPattern size={18} />}</span>
              <span className="feature-name">{p.name}</span>
              {error && (
                <span className="feature-error-icon" aria-label="Problem">
                  <Icons.Warning size={16} />
                </span>
              )}
              <span className="row-actions">
                <button className="icon-button small" onClick={() => useStore.getState().setEditingPattern(p.id)} aria-label={`Edit ${p.name}`} title="Edit">
                  <Icons.Sketch size={15} />
                </button>
                <button className="icon-button small" onClick={() => useStore.getState().deletePattern(p.id)} aria-label={`Delete ${p.name}`} title="Delete (and its copies)">
                  <Icons.Trash size={15} />
                </button>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Settings of the pattern being edited; each change applies straight away (and can be undone). */
export function PatternPanel() {
  const asm = useStore(activeAssembly);
  const id = useStore((s) => s.editingPattern);
  const { solved } = useSolvedAssembly();
  const busy = useStore((s) => s.asmSelection.length > 0 || s.dialog === "insert" || s.mateDraft !== null);
  const p = asm?.patterns?.find((x) => x.id === id);
  if (!asm || !p || busy) return null;
  const st = useStore.getState();
  const update = (patch: Parameters<typeof st.updatePattern>[1]) => st.updatePattern(p.id, patch);
  const amount = evaluate(p.amount);
  const error = solved?.patternErrors?.[p.id];
  const names = p.seeds.map((s) => asm.instances.find((i) => i.id === s)?.name ?? "?").join(", ");
  const centre = p.centre ?? [0, 0, 0];
  return (
    <div className="feature-dialog instance-panel" role="region" aria-label={`Pattern ${p.name}`}>
      <header className="feature-dialog-header">
        <span className="feature-dialog-title">{p.name}</span>
        <span className="feature-dialog-actions">
          <button type="button" className="dialog-cancel" onClick={() => st.setEditingPattern(null)} title="Close (Esc)" aria-label="Close pattern">
            <Icons.Cross size={18} />
          </button>
        </span>
      </header>
      <div className="feature-dialog-body">
        <p className="dialog-hint">{p.kind === "mirror" ? `Mirroring ${names}.` : `Repeating ${names}.`}</p>
        <div className="segmented three" role="radiogroup" aria-label="Pattern kind">
          {(["linear", "circular", "mirror"] as const).map((k) => (
            <button
              type="button"
              key={k}
              role="radio"
              aria-checked={p.kind === k}
              className={p.kind === k ? "selected" : ""}
              onClick={() =>
                p.kind !== k &&
                update(k === "linear" ? { kind: k, amount: "20", count: Math.max(p.count, 2) } : k === "mirror" ? { kind: k, axis: "x", count: 2 } : { kind: k, amount: "360", axis: "z", count: Math.max(p.count, 4) })
              }
            >
              {k === "linear" ? "In a row" : k === "mirror" ? "Mirror" : "Round an axis"}
            </button>
          ))}
        </div>
        {p.kind === "mirror" ? (
          <>
            <div className="param-field compact">
              <label htmlFor="asm-mirror-plane">Mirror across</label>
              <select id="asm-mirror-plane" value={p.axis} onChange={(e) => update({ axis: e.target.value as "x" | "y" | "z" })}>
                <option value="x">Right plane (left ↔ right)</option>
                <option value="y">Front plane (front ↔ back)</option>
                <option value="z">Top plane (up ↔ down)</option>
              </select>
            </div>
            <NumberBox
              label={`Plane at ${p.axis.toUpperCase()} =`}
              value={centre[p.axis === "x" ? 0 : p.axis === "y" ? 1 : 2]}
              unit="mm"
              onCommit={(v) => {
                const c: [number, number, number] = [0, 0, 0];
                c[p.axis === "x" ? 0 : p.axis === "y" ? 1 : 2] = v;
                update({ centre: c });
              }}
            />
            <p className="dialog-hint">The copies are mirror images — the opposite hand — so the parts list shows them as separate parts.</p>
          </>
        ) : (
          <>
        <NumberBox label="How many (including the original)" value={p.count} unit="" onCommit={(v) => update({ count: Math.max(2, Math.min(100, Math.round(v))) })} />
        {p.kind === "linear" ? (
          <NumberBox label="Spacing" value={amount.ok ? amount.value : 0} unit="mm" onCommit={(v) => update({ amount: String(v) })} />
        ) : (
          <NumberBox label="Spread over" value={amount.ok ? amount.value : 0} unit="°" onCommit={(v) => update({ amount: String(v) })} />
        )}
        <div className="param-field compact">
          <label htmlFor="asm-pattern-axis">{p.kind === "linear" ? "Direction" : "Axis"}</label>
          <select id="asm-pattern-axis" value={p.axis} onChange={(e) => update({ axis: e.target.value as "x" | "y" | "z" })}>
            <option value="x">X (red)</option>
            <option value="y">Y (green)</option>
            <option value="z">Z (blue)</option>
          </select>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={!!p.flip} onChange={(e) => update({ flip: e.target.checked })} />
          {p.kind === "linear" ? "The other way" : "Turn the other way"}
        </label>
          </>
        )}
        {p.kind === "circular" && (
          <fieldset className="param-group">
            <legend>Axis goes through</legend>
            {(["X", "Y", "Z"] as const).map((l, k) => (
              <NumberBox
                key={l}
                label={`Centre ${l}`}
                value={centre[k]}
                unit="mm"
                onCommit={(v) => {
                  const c: [number, number, number] = [...centre];
                  c[k] = v;
                  update({ centre: c });
                }}
              />
            ))}
          </fieldset>
        )}
        {error && <p className="param-message error">{error}</p>}
        <button type="button" className="text-button" onClick={() => st.deletePattern(p.id)}>
          Delete pattern (and its copies)
        </button>
      </div>
    </div>
  );
}

/** Relations: one mate driving another (gears, rack and pinion, screws, linked sliders). */
function RelationsSection({ assembly }: { assembly: Assembly }) {
  const { solved } = useSolvedAssembly();
  const [adding, setAdding] = useState(false);
  const mates = assembly.mates ?? [];
  const relations = assembly.relations ?? [];
  if (mates.length < 2 && !relations.length) return null;
  const st = useStore.getState;
  const add = (kind: MateRelation["kind"]) => {
    setAdding(false);
    const driver = mates.find((m) => canDrive(m, kind));
    const driven = mates.find((m) => m !== driver && canBeDriven(m, kind));
    if (!driver || !driven) {
      st().showToast(
        kind === "gear"
          ? "A gear relation needs two Hinge (or Cylindrical) mates."
          : kind === "linear"
            ? "A linear relation needs two Slider (or Cylindrical) mates."
            : "This needs a Hinge mate to drive it and a Slider (or Cylindrical) mate to move.",
        "info",
      );
      return;
    }
    st().putRelation({ id: newId("rl"), name: nextRelationName(assembly, kind), kind, driver: driver.id, driven: driven.id, ratio: RELATION_KINDS[kind].defaultRatio });
  };
  return (
    <section className="panel-section relations">
      <h3>
        Relations <span className="count">({relations.length})</span>
        <button type="button" className="text-button small-text" onClick={() => setAdding(!adding)} title="Make one mate drive another: gears, rack and pinion, screws, linked sliders">
          + Add
        </button>
      </h3>
      {adding && (
        <ul className="relation-kinds">
          {RELATION_KIND_NAMES.map((k) => (
            <li key={k}>
              <button type="button" className="text-button" onClick={() => add(k)} title={RELATION_KINDS[k].hint}>
                {RELATION_KINDS[k].label}
              </button>
            </li>
          ))}
        </ul>
      )}
      <ul className="relation-list">
        {relations.map((r) => {
          const kind = RELATION_KINDS[r.kind];
          const update = (patch: Partial<MateRelation>) => st().putRelation({ ...r, ...patch });
          const error = solved?.mateErrors[r.id];
          return (
            <li key={r.id} className={`relation-row${error ? " failed" : ""}`}>
              <div className="relation-head">
                <strong>{r.name}</strong>
                <button type="button" className="icon-button small" onClick={() => st().removeRelation(r.id)} aria-label={`Delete ${r.name}`} title="Delete">
                  <Icons.Cross size={14} />
                </button>
              </div>
              <label>
                {r.kind === "linear" ? "Sliding" : "Turning"}
                <select value={r.driver} aria-label={`${r.name} driver`} onChange={(e) => update({ driver: e.target.value })}>
                  {mates.filter((m) => canDrive(m, r.kind)).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {r.kind === "gear" ? "Turns" : "Moves"}
                <select value={r.driven} aria-label={`${r.name} driven`} onChange={(e) => update({ driven: e.target.value })}>
                  {mates.filter((m) => m.id !== r.driver && canBeDriven(m, r.kind)).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {kind.ratioLabel}
                <RatioBox value={r.ratio} label={`${r.name} ${kind.ratioLabel}`} onCommit={(ratio) => update({ ratio })} />
                <span className="muted">{kind.ratioUnit}</span>
              </label>
              <label className="check-row">
                <input type="checkbox" checked={!!r.reverse} onChange={(e) => update({ reverse: e.target.checked || undefined })} />
                The other way
              </label>
              {error && <p className="dialog-error">{error}</p>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Named positions: save how the mates are set now, and go back to it with one click. */
function PositionsSection({ assembly }: { assembly: Assembly }) {
  const positions = assembly.positions ?? [];
  const st = useStore.getState;
  if (!(assembly.mates ?? []).length && !positions.length) return null;
  const save = () => {
    const name = window.prompt("Name for this position", nextPositionName(assembly));
    if (name !== null && name.trim()) st().savePosition(name.trim().slice(0, 80));
  };
  return (
    <section className="panel-section positions">
      <h3>
        Positions <span className="count">({positions.length})</span>
        <button type="button" className="text-button small-text" onClick={save} title="Save how the mates are set now (hinge angles, slider distances…) to come back to">
          + Save current
        </button>
      </h3>
      {positions.length === 0 ? (
        <p className="panel-hint">Save the mechanism's position (open, closed…) to switch between them later.</p>
      ) : (
        <ul className="position-list">
          {positions.map((p) => (
            <li key={p.id}>
              <button type="button" className="text-button" onClick={() => st().applyPosition(p.id)} title={`Move the parts to ${p.name}`}>
                {p.name}
              </button>
              <button type="button" className="icon-button small" onClick={() => st().removePosition(p.id)} aria-label={`Forget ${p.name}`} title="Forget this position">
                <Icons.Cross size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A box for a relation's ratio, applied on Enter or when you leave it. */
function RatioBox({ value, label, onCommit }: { value: string; label: string; onCommit: (v: string) => void }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  return (
    <input
      value={text}
      aria-label={label}
      spellCheck={false}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => text.trim() && text !== value && onCommit(text.trim())}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
      }}
    />
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
  // With sub-assemblies, the parts list can be flattened (every part counted) or structured (each sub-assembly a line, its parts under it).
  const hasSubs = assembly.instances.some((i) => i.subAssembly);
  const [structured, setStructured] = useState(false);
  const bom = useMemo(
    () =>
      billOfMaterials(assembly, partNames, Object.fromEntries((doc.configurations ?? []).map((c) => [c.id, c.name])), bomInfo(parts, doc.materials), doc.partProperties, {
        assemblies: doc.assemblies,
        structured: hasSubs && structured,
      }),
    [assembly, partNames, doc.configurations, parts, doc.materials, doc.partProperties, doc.assemblies, hasSubs, structured],
  );
  const partCount = bom.reduce((n, r) => n + (r.subAssembly ? 0 : r.quantity * (r.level ? levelMultiplier(bom, r) : 1)), 0);
  const [editingProps, setEditingProps] = useState<{ partId: string; name: string } | null>(null);
  const showNumbers = bom.some((r) => r.properties?.number);
  const total = bomTotalMass(bom);
  const kernelReady = useStore((s) => s.kernelStatus === "ready");

  return (
    <aside className="side-panel" aria-label="Assembly">
      <section className="panel-section features">
        <h3>
          Instances <span className="count">({assembly.instances.length})</span>
        </h3>
        <ul className="feature-list">
          {assembly.instances.map((i) => (
            <InstanceRow key={i.id} instance={i} missing={kernelReady && !i.subAssembly && !partNames[i.partId]} />
          ))}
        </ul>
        {assembly.instances.length === 0 && <p className="panel-hint">Click Insert to bring in parts from the Part Studio, or other assemblies.</p>}
      </section>
      <MatesSection assembly={assembly} />
      <GroupsSection assembly={assembly} />
      <PatternsSection assembly={assembly} />
      <RelationsSection assembly={assembly} />
      <PositionsSection assembly={assembly} />
      <section className="panel-section parts">
        <h3>
          Parts list <span className="count">({partCount})</span>
        </h3>
        {hasSubs && (
          <div className="segmented bom-structure" role="group" aria-label="How sub-assemblies are listed">
            <button type="button" className={!structured ? "selected" : ""} aria-pressed={!structured} onClick={() => setStructured(false)} title="Every part counted, however deep inside sub-assemblies">
              Flattened
            </button>
            <button type="button" className={structured ? "selected" : ""} aria-pressed={structured} onClick={() => setStructured(true)} title="Each sub-assembly on one line, with what's in one of it underneath">
              Structured
            </button>
          </div>
        )}
        <table className="bom-table" aria-label="Parts list">
          <thead>
            <tr>
              <th>#</th>
              {showNumbers && <th>Number</th>}
              <th>Part</th>
              <th className="bom-qty">Qty</th>
              <th className="bom-mass" title="What they weigh, made solid in the part's material (set it in the Part Studio's parts list)">Weight</th>
              <th className="bom-edit" aria-label="Edit" />
            </tr>
          </thead>
          <tbody>
            {bom.map((r, n) => (
              <tr
                key={`${r.item ?? n}:${r.partId}`}
                className={[r.missing ? "missing" : r.subAssembly ? "" : "editable", r.subAssembly && "bom-subassembly"].filter(Boolean).join(" ")}
                onDoubleClick={() => !r.missing && !r.subAssembly && setEditingProps({ partId: basePartId(r.partId), name: r.name })}
              >
                <td>{r.item ?? n + 1}</td>
                {showNumbers && <td className="bom-number">{r.properties?.number ?? ""}</td>}
                <td title={r.subAssembly ? `A sub-assembly: the lines under it are what's in one of it` : bomRowTitle(r)} style={r.level ? { paddingLeft: 6 + 12 * r.level } : undefined}>
                  {r.subAssembly && <Icons.Assembly size={13} />} {r.name}
                  {r.properties?.description && <div className="bom-description muted">{r.properties.description}</div>}
                </td>
                <td className="bom-qty">{r.quantity}</td>
                <td className="bom-mass muted" title={r.surface ? "Surfaces have no weight (thicken one to make it solid)" : undefined}>
                  {r.massEach !== undefined ? formatMass(r.massEach * r.quantity) : r.surface ? "—" : ""}
                </td>
                <td className="bom-edit">
                  {!r.missing && !r.subAssembly && (
                    <button
                      className="icon-button small"
                      onClick={() => setEditingProps({ partId: basePartId(r.partId), name: r.name })}
                      aria-label={`Edit the properties on line ${n + 1}`}
                      title="Part number, description and your own properties"
                    >
                      <Icons.Sketch size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {total.grams > 0 && (
          <p className="panel-hint bom-total" title="Printed parts with less infill weigh less">
            Weight of everything: about {formatMass(total.grams)}
            {total.partial ? " (some parts unknown)" : ""}
          </p>
        )}
        {bom.length > 0 && <p className="panel-hint">Click the pencil (or double-click a part) to give it a part number, description or your own properties.</p>}
        {editingProps && <PartPropertiesDialog partId={editingProps.partId} name={editingProps.name} onClose={() => setEditingProps(null)} />}
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

/** Structured parts list: how many of a nested line's sub-assembly there are in all (its line's quantity times its parents'). */
function levelMultiplier(rows: BomRow[], row: BomRow): number {
  let n = 1;
  let at = rows.indexOf(row);
  for (let level = row.level ?? 0; level > 0; level--) {
    while (at > 0 && (rows[at].level ?? 0) >= level) at--;
    n *= rows[at].quantity;
  }
  return n;
}

/** The Part Studio part a parts list line is for (lines for other configurations or mirrored copies have extra bits on the end). */
const basePartId = (rowId: string) => rowId.split(/[@~]/)[0];

/** Hover text for a parts list line: material and weight, and the part's own properties. */
function bomRowTitle(r: BomRow): string | undefined {
  const bits = [
    r.material ? `${r.material}${r.massEach !== undefined ? ` — ${formatMass(r.massEach)} each` : ""}` : "",
    ...(r.properties?.custom ?? []).map((c) => `${c.name}: ${c.value}`),
    r.missing ? "" : "Double-click to edit its part number, description and properties",
  ].filter(Boolean);
  return bits.length ? bits.join("\n") : undefined;
}

/** Edit a part's number, description and your own properties (they show in every parts list of it). */
function PartPropertiesDialog({ partId, name, onClose }: { partId: string; name: string; onClose: () => void }) {
  const saved = useStore((s) => s.history.present.partProperties?.[partId]);
  const [number, setNumber] = useState(saved?.number ?? "");
  const [description, setDescription] = useState(saved?.description ?? "");
  const [custom, setCustom] = useState<{ name: string; value: string }[]>(saved?.custom?.length ? saved.custom : []);
  const save = () => {
    useStore.getState().setPartProperties(partId, { number, description, custom });
    onClose();
  };
  return (
    <Modal
      title={`Properties of ${name}`}
      onClose={onClose}
      width={460}
      footer={
        <>
          <button className="text-button" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-button" onClick={save}>
            Save
          </button>
        </>
      }
    >
      <form
        className="part-properties"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label className="field-label" htmlFor="part-number">
          Part number
        </label>
        <input id="part-number" value={number} maxLength={60} placeholder="e.g. BR-001" onChange={(e) => setNumber(e.target.value)} />
        <label className="field-label" htmlFor="part-description">
          Description
        </label>
        <input id="part-description" value={description} maxLength={200} placeholder="e.g. Shelf bracket, left" onChange={(e) => setDescription(e.target.value)} />
        <div className="field-label">Your own properties</div>
        {custom.map((c, i) => (
          <div className="custom-property" key={i}>
            <input aria-label={`Property ${i + 1} name`} value={c.name} maxLength={40} placeholder="Name (e.g. Supplier)" onChange={(e) => setCustom(custom.map((x, k) => (k === i ? { ...x, name: e.target.value } : x)))} />
            <input aria-label={`Property ${i + 1} value`} value={c.value} maxLength={200} placeholder="Value" onChange={(e) => setCustom(custom.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)))} />
            <button type="button" className="icon-button small" aria-label={`Remove property ${i + 1}`} title="Remove" onClick={() => setCustom(custom.filter((_, k) => k !== i))}>
              <Icons.Trash size={15} />
            </button>
          </div>
        ))}
        <button type="button" className="text-button small-text" onClick={() => setCustom([...custom, { name: "", value: "" }])}>
          <Icons.Plus size={14} /> Add a property
        </button>
        <p className="dialog-hint">They show in every parts list with this part, its CSV file and drawings. Leave a box empty to remove it.</p>
        {/* Enter in a box saves. */}
        <button type="submit" hidden />
      </form>
    </Modal>
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
  // Other assemblies, to put in as sub-assemblies.
  const others = (doc.assemblies ?? []).filter((a) => a.id !== asm.id);
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
        {others.length > 0 && (
          <>
            <div className="insert-studio">Assemblies</div>
            <p className="dialog-hint">Put a whole assembly in as one piece (a sub-assembly). Its parts stay where its own mates put them; change it in its own tab and every copy follows.</p>
            <ul className="insert-list">
              {others.map((a) => {
                const problem = insertProblem(doc, asm.id, a.id);
                const count = asm.instances.filter((i) => i.subAssembly === a.id).length;
                return (
                  <li key={a.id}>
                    <button className="insert-row" onClick={() => insertAssembly(a)} disabled={!!problem} title={problem ?? `Put a copy of ${a.name} into ${asm.name}`} aria-label={`Insert ${a.name}`}>
                      <Icons.Assembly size={16} />
                      <span className="feature-name">{a.name}</span>
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
  const doc = useStore((s) => s.history.present);
  const selection = useStore((s) => s.asmSelection);
  const insertOpen = useStore((s) => s.dialog === "insert");
  const mating = useStore((s) => s.mateDraft !== null);
  const { solved } = useSolvedAssembly();
  const parts = useStore((s) => s.parts);
  const instance = asm && selection.length === 1 ? asm.instances.find((i) => i.id === selection[0]) : undefined;
  const studios = studiosOf(doc);
  // Parts it could show instead (as in their Part Studio, not other configurations).
  const choosable = studios.flatMap((st) => partsInStudio(parts, st.id)).filter((p) => !p.configuration);
  // While exploded, the exploded view's panel is open instead.
  if (!instance || insertOpen || mating || asm?.explode !== undefined) return null;
  const drivenBy = solved?.drivenBy[instance.id];
  const driver = drivenBy ? asm?.mates?.find((m) => m.id === drivenBy) : undefined;
  const group = drivenBy?.startsWith("group:") ? asm?.groups?.find((g) => `group:${g.id}` === drivenBy) : undefined;
  const copyPattern = instance.copyOf ? asm?.patterns?.find((p) => p.id === instance.copyOf!.pattern) : undefined;
  const copyOriginal = instance.copyOf ? asm?.instances.find((i) => i.id === instance.copyOf!.seed) : undefined;
  const update = useStore.getState().updateInstance;
  const { position, rotation } = instance.placement;
  const configurations = doc.configurations ?? [];
  const shownConfiguration = doc.activeConfiguration;
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
        {instance.subAssembly && (
          <>
            <p className="dialog-hint">
              A copy of <strong>{doc.assemblies?.find((a) => a.id === instance.subAssembly)?.name ?? "another assembly"}</strong>, moving as one piece. Mate it by clicking a face of any part inside it.
            </p>
            <button type="button" className="text-button" onClick={() => useStore.getState().setActiveTab(instance.subAssembly!)}>
              Open {doc.assemblies?.find((a) => a.id === instance.subAssembly)?.name ?? "it"} to change it
            </button>
          </>
        )}
        {!instance.subAssembly && !instance.copyOf && !instance.replicaOf && choosable.some((p) => p.id !== instance.partId) && (
          <div className="param-field compact">
            <label htmlFor="instance-part">Part</label>
            <select
              id="instance-part"
              value={instance.partId}
              onChange={(e) => useStore.getState().replaceInstancePart(instance.id, e.target.value)}
              title="Replace — show another part here instead. Its mates are kept where the new part has a matching face (pick again if not)."
            >
              {!choosable.some((p) => p.id === instance.partId) && <option value={instance.partId}>(missing part)</option>}
              {studios.length > 1
                ? studios.map((st) => {
                    const mine = partsInStudio(parts, st.id).filter((p) => !p.configuration);
                    return mine.length ? (
                      <optgroup key={st.id} label={st.name}>
                        {mine.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </optgroup>
                    ) : null;
                  })
                : choosable.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
            </select>
          </div>
        )}
        {configurations.length > 0 && !instance.copyOf && !instance.subAssembly && (
          <div className="param-field compact">
            <label htmlFor="instance-configuration">Configuration</label>
            <select
              id="instance-configuration"
              value={instance.configuration ?? ""}
              onChange={(e) => {
                update(instance.id, { configuration: e.target.value || undefined });
                // Its pattern copies show the same configuration.
                const pattern = asm?.patterns?.find((p) => p.seeds.includes(instance.id));
                if (pattern) useStore.getState().updatePattern(pattern.id, {});
              }}
              title="Show this part as it is in one of the design's configurations"
            >
              <option value="">As in the Part Studio ({configurations.find((c) => c.id === shownConfiguration)?.name ?? configurations[0].name})</option>
              {configurations.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {copyPattern ? (
          <>
            <p className="dialog-hint">
              A copy made by <strong>{copyPattern.name}</strong>: it follows {copyOriginal?.name ?? "its original"}. To move it, move the original or change the pattern.
            </p>
            <button type="button" className="text-button" onClick={() => useStore.getState().setEditingPattern(copyPattern.id)}>
              Edit {copyPattern.name}
            </button>
          </>
        ) : group ? (
          <>
            <p className="dialog-hint">
              In <strong>{group.name}</strong>: it moves with the other parts in the group. Drag it to move them all, or ungroup to move it on its own.
            </p>
            <button type="button" className="text-button" onClick={() => useStore.getState().deleteGroup(group.id)}>
              Ungroup {group.name}
            </button>
          </>
        ) : driver ? (
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

/** The exploded view's settings: how far apart the parts are spread, and steps moving chosen parts. */
export function ExplodePanel() {
  const asm = useStore(activeAssembly);
  const preview = useStore((s) => s.explodePreview);
  const busy = useStore((s) => s.dialog === "insert" || s.mateDraft !== null);
  const selection = useStore((s) => s.asmSelection);
  if (!asm || asm.explode === undefined || busy) return null;
  const st = useStore.getState();
  const amount = preview ?? asm.explode;
  const steps = asm.explodeSteps ?? [];
  const names = Object.fromEntries(asm.instances.map((i) => [i.id, i.name]));
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
          Spread: {amount > 0 ? `${Math.round(amount * 100)}%` : "off (steps only)"}
        </label>
        <input
          id="explode-spread"
          type="range"
          className="mate-slider"
          min={0}
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
          mates, exports and clash checks use the real places. Drawings of this assembly can show it exploded too. To move or change a part itself, close the
          exploded view first.
        </p>
        <fieldset className="param-group explode-steps">
          <legend>Steps</legend>
          {steps.length === 0 && <p className="dialog-hint">Move chosen parts a set distance — the screws straight up out of their holes, then the lid…</p>}
          <ol className="explode-step-list">
            {steps.map((step, n) => (
              <ExplodeStepRow key={step.id} step={step} number={n + 1} names={names} />
            ))}
          </ol>
          <button
            type="button"
            className="text-button"
            onClick={() => st.addExplodeStep()}
            disabled={selection.length === 0}
            title={selection.length ? "Add a step that moves the selected parts" : "Select the parts to move first (click them; Shift-click for more)"}
          >
            + Move {selection.length ? `the ${selection.length === 1 ? "selected part" : `${selection.length} selected parts`}` : "selected parts"}
          </button>
        </fieldset>
      </div>
    </div>
  );
}

/** One exploded view step: which parts, which way and how far. */
function ExplodeStepRow({ step, number, names }: { step: ExplodeStep; number: number; names: Record<string, string> }) {
  const st = useStore.getState();
  const unitNow = useLengthUnit();
  const [text, setText] = useState(showLength(step.distance, unitNow));
  useEffect(() => setText(showLength(step.distance, unitNow)), [step.distance, unitNow]);
  const bad = stepDistance({ ...step, distance: storeLength(text, unitNow) });
  const commit = () => {
    const stored = storeLength(text.trim() || "0", unitNow);
    if (stored !== step.distance && !("error" in bad)) st.updateExplodeStep(step.id, { distance: stored });
  };
  const who = step.instances.map((id) => names[id] ?? "?");
  return (
    <li className="explode-step">
      <div className="relation-head">
        <strong title={who.join(", ")}>
          {number}. {who.length <= 2 ? who.join(" and ") : `${who[0]} and ${who.length - 1} more`}
        </strong>
        <button type="button" className="icon-button small" onClick={() => st.removeExplodeStep(step.id)} aria-label={`Remove step ${number}`} title="Remove this step">
          <Icons.Cross size={14} />
        </button>
      </div>
      <div className="explode-step-fields">
        <select value={`${step.flip ? "-" : "+"}${step.axis}`} aria-label={`Step ${number} direction`} onChange={(e) => st.updateExplodeStep(step.id, { axis: e.target.value.slice(1) as ExplodeStep["axis"], flip: e.target.value.startsWith("-") })}>
          {(["z", "x", "y"] as const).flatMap((a) =>
            (["+", "-"] as const).map((sign) => (
              <option key={sign + a} value={sign + a}>
                {a === "z" ? (sign === "+" ? "Up" : "Down") : `${sign === "+" ? "+" : "−"}${a.toUpperCase()}`}
              </option>
            )),
          )}
        </select>
        <div className={`param-input${"error" in bad ? " invalid" : ""}`}>
          <input
            value={text}
            aria-label={`Step ${number} distance`}
            spellCheck={false}
            autoComplete="off"
            inputMode="decimal"
            onChange={(e) => setText(e.target.value)}
            onFocus={(e) => e.target.select()}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            aria-invalid={"error" in bad}
          />
          <span className="unit">{unitNow}</span>
        </div>
      </div>
      {"error" in bad && <div className="param-message error">{bad.error}</div>}
    </li>
  );
}

/** "Flat face", "Circular edge"… for showing what was picked. */
function connectorLabel(c: MateConnector): string {
  const plane = originPlaneOf(c);
  if (plane) return `${plane} plane`;
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

/** Where on a picked face or edge the connector sits (only when there's a choice). */
function SpotChoice({ c, onChange }: { c: MateConnector; onChange: (c: MateConnector) => void }) {
  const options = spotOptions(c);
  if (options.length < 2) return null;
  return (
    <select
      className="connector-spot"
      aria-label="Where on it"
      title="Where the mate connector sits on the face or edge"
      value={c.spot ?? ""}
      onChange={(e) => {
        const { spot: _old, ...rest } = c;
        onChange(e.target.value ? { ...rest, spot: e.target.value as ConnectorSpot } : rest);
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
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
  const width = mate.type === "width";
  const ready = !!mate.a && !!mate.b && (!width || (!!mate.a.pick2 && !!mate.b.pick2));
  const { errors } = mateValues(mate);
  const limits = mateLimits(mate);
  const problem = ready ? solved?.mateErrors[mate.id] : undefined;
  const nameOf = (c?: MateConnector) => {
    if (!c) return "";
    if (isOrigin(c)) return "Origin";
    const top = asm.instances.find((i) => i.id === c.instanceId);
    if (!top || !c.path?.length) return top?.name ?? "?";
    // A part inside a sub-assembly: "Hinge <1> / Pin <2>".
    return `${top.name} / ${instanceAt(asm, st.history.present.assemblies ?? [], leafKey(c.instanceId, c.path))?.part.name ?? "?"}`;
  };
  const slot = (c: MateConnector | undefined, n: 1 | 2) => (
    <div
      className={`connector-slot${c && (!width || c.pick2) ? " filled" : ""}${
        (n === 1 && (!mate.a || (width && !mate.a.pick2))) || (n === 2 && mate.a && (!width || mate.a.pick2) && (!mate.b || (width && !mate.b.pick2))) ? " waiting" : ""
      }`}
    >
      <span className="connector-number">{n}</span>
      {c && (!width || c.pick2) ? (
        <span className="connector-picked">
          {nameOf(c)} — {width ? "two faces" : connectorLabel(c)}
          {!width && <SpotChoice c={c} onChange={(next) => st.setMateDraft(n === 1 ? { a: next } : { b: next })} />}
        </span>
      ) : c && width ? (
        <span className="muted">{nameOf(c)} — now click the face opposite</span>
      ) : width ? (
        <span className="muted">{n === 1 ? "Click both sides of the slot (on the part that stays put)" : "Click both sides of the part that goes in it"}</span>
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
        {!width && !ready && (
          <div className="origin-picks" role="group" aria-label="Mate to the origin">
            <span className="muted" title="Hold a part in place against the assembly's origin, without fixing it">
              Or use the origin:
            </span>
            {ORIGIN_PLANES.map((p) => (
              <button
                key={p}
                type="button"
                className="text-button small-text"
                onClick={() => st.pickMateConnector(originConnector(p))}
                title={`The origin's ${p} plane — like a flat face that never moves`}
              >
                {p}
              </button>
            ))}
          </div>
        )}
        {ready && (
          <button type="button" className="text-button small-text" onClick={() => st.setMateDraft({ a: undefined, b: undefined })}>
            Pick again
          </button>
        )}
        {mate.type !== "tangent" && (
          <label className="check-row">
            <input type="checkbox" checked={mate.flip} onChange={(e) => st.setMateDraft({ flip: e.target.checked })} />
            Flip (turn the moving part round)
          </label>
        )}
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
