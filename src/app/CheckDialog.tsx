import { useEffect, useState } from "react";

import { getKernel } from "../kernel/connect";
import { buildCheckReport, type CheckReport, type Level } from "../model/checkReport";
import { activeAssembly, activeFeatures, studioParts, useLengthUnit, useStore } from "../model/store";
import { evaluate } from "../model/expr";
import { lengthNumber, storeLength } from "../model/units";
import { solveWithParts } from "../assembly/mates";
import { assemblyReport, DEFAULT_CLASH_OPTIONS, judgeContacts, parseClashOptions, type ClashOptions } from "../assembly/assemblyCheck";
import { instancesForKernel } from "./assemblySolve";
import { Icons } from "./icons";
import { Modal } from "./Modal";
import { DEFAULT_MATERIAL, formatMass, massGrams, MATERIALS } from "../model/materials";

export function LevelIcon({ level }: { level: Level }) {
  if (level === "ok") return <Icons.Tick size={16} className="level-icon ok" />;
  if (level === "warn") return <Icons.Warning size={16} className="level-icon warn" />;
  return <Icons.Cross size={16} className="level-icon error" />;
}

const CLASH_KEY = "juracad.clashOptions";

/** The clash check options last used (kept in this browser). */
export function loadClashOptions(): ClashOptions {
  try {
    return parseClashOptions(JSON.parse(localStorage.getItem(CLASH_KEY) ?? "null"));
  } catch {
    return DEFAULT_CLASH_OPTIONS;
  }
}

function saveClashOptions(o: ClashOptions) {
  try {
    localStorage.setItem(CLASH_KEY, JSON.stringify(o));
  } catch {
    // not kept; fine
  }
}

/** Runs the check in the geometry worker and returns the report (an assembly's check when one is on show). */
export async function runCheck(options: ClashOptions = loadClashOptions()): Promise<CheckReport> {
  const kernel = getKernel();
  await kernel.whenIdle();
  const asm = activeAssembly(useStore.getState());
  if (asm) {
    const s = useStore.getState();
    const solved = solveWithParts(asm, s.parts);
    // Suppressed parts are always left out (instancesForKernel); hidden ones when asked.
    const hidden = options.skipHidden ? asm.instances.filter((i) => !i.suppressed && s.hiddenInstances.includes(i.id)).map((i) => i.id) : [];
    const instances = instancesForKernel(asm, s.parts, solved).filter((i) => !hidden.includes(i.id));
    const measured = await kernel.clashes(instances, options.tolerance);
    const names = Object.fromEntries(s.parts.map((p) => [p.id, p.name]));
    return assemblyReport(asm, solved, names, judgeContacts(measured, options), options, { hidden: hidden.length, suppressed: asm.instances.filter((i) => i.suppressed).length });
  }
  const s0 = useStore.getState();
  const result = await kernel.check("normal", studioParts(s0).map((p) => p.id));
  const s = useStore.getState();
  const failed = activeFeatures(s).filter((f) => !f.suppressed && s.featureErrors[f.id]).length;
  return buildCheckReport(result, failed);
}

/** What a part weighs, solid, in the material chosen for it (changeable here). */
function PartMass({ partId, volumeMm3 }: { partId: string; volumeMm3: number }) {
  const key = useStore((s) => s.history.present.materials?.[partId] ?? DEFAULT_MATERIAL);
  const setPartMaterial = useStore((s) => s.setPartMaterial);
  return (
    <span className="part-mass">
      {formatMass(massGrams(volumeMm3, key))} in{" "}
      <select aria-label="Material" value={key} onChange={(e) => setPartMaterial(partId, e.target.value)} title="What it's made of — sets the weight (solid; less infill weighs less)">
        {MATERIALS.map((m) => (
          <option key={m.key} value={m.key}>
            {m.label}
          </option>
        ))}
      </select>
    </span>
  );
}

export function ReportView({ report }: { report: CheckReport }) {
  return (
    <div className="check-report">
      <div className={`check-headline ${report.level}`}>
        <LevelIcon level={report.level} />
        <span>{report.headline}</span>
      </div>
      {report.parts.map((p) => (
        <section key={p.partId} className="check-part">
          <h4>
            <LevelIcon level={p.level} /> {p.name}
            {p.size && (
              <span className="check-meta">
                {p.size} · {p.volume} · <PartMass partId={p.partId} volumeMm3={p.volumeMm3} />
              </span>
            )}
          </h4>
          <ul>
            {p.findings.map((f, i) => (
              <li key={i} className={f.level}>
                <LevelIcon level={f.level} /> {f.text}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

export function CheckDialog() {
  const openDialog = useStore((s) => s.openDialog);
  const [report, setReport] = useState<CheckReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inAssembly = useStore((s) => !!activeAssembly(s));
  const [options, setOptions] = useState<ClashOptions>(loadClashOptions);

  useEffect(() => {
    let cancelled = false;
    setReport(null);
    setError(null);
    runCheck(options).then(
      (r) => !cancelled && setReport(r),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, [options]);

  const change = (patch: Partial<ClashOptions>) => {
    const next = { ...options, ...patch };
    saveClashOptions(next);
    setOptions(next);
  };

  const close = () => openDialog(null);

  return (
    <Modal
      title={useStore.getState().activeTab && activeAssembly(useStore.getState()) ? "Check assembly" : "Check model"}
      onClose={close}
      footer={
        <>
          <button className="text-button" onClick={close}>
            Close
          </button>
          <button className="primary-button" onClick={() => openDialog("export")} disabled={!report}>
            <Icons.Export size={18} /> Export…
          </button>
        </>
      }
    >
      {inAssembly && <ClashOptionsBar options={options} onChange={change} />}
      {error ? (
        <p className="dialog-error">{error}</p>
      ) : report ? (
        <ReportView report={report} />
      ) : (
        <p className="muted">Checking…</p>
      )}
    </Modal>
  );
}

/** The assembly check's choices: touching parts, how close counts as touching, and hidden parts. */
function ClashOptionsBar({ options, onChange }: { options: ClashOptions; onChange: (patch: Partial<ClashOptions>) => void }) {
  const unit = useLengthUnit();
  const shown = lengthNumber(options.tolerance, unit, unit === "in" ? 5 : 4);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  const commit = () => {
    const r = evaluate(storeLength(text, unit));
    // 0 to 10 mm; anything else goes back to what it was.
    if (r.ok && r.value >= 0 && r.value <= 10) onChange({ tolerance: r.value });
    else setText(shown);
  };
  return (
    <div className="clash-options" role="group" aria-label="Clash check options">
      <label title="Parts that meet face to face (or overlap less than the amount below) aren't listed">
        <input type="checkbox" checked={options.ignoreTouching} onChange={(e) => onChange({ ignoreTouching: e.target.checked })} /> Ignore parts that only touch
      </label>
      <label title="Overlaps thinner than this, and gaps smaller than it, count as touching — handy for parts that are meant to sit tight together">
        Touching within{" "}
        <input
          className="clash-tolerance"
          aria-label="Touching tolerance"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />{" "}
        {unit}
      </label>
      <label title="Leave out parts you've hidden with the eye button (suppressed parts are always left out)">
        <input type="checkbox" checked={options.skipHidden} onChange={(e) => onChange({ skipHidden: e.target.checked })} /> Leave out hidden parts
      </label>
    </div>
  );
}
