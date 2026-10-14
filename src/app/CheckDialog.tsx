import { useEffect, useState } from "react";

import { getKernel } from "../kernel/connect";
import { buildCheckReport, type CheckReport, type Level } from "../model/checkReport";
import { activeAssembly, activeFeatures, studioParts, useStore } from "../model/store";
import { solveWithParts } from "../assembly/mates";
import { assemblyReport } from "../assembly/assemblyCheck";
import { instancesForKernel } from "./assemblySolve";
import { Icons } from "./icons";
import { Modal } from "./Modal";
import { DEFAULT_MATERIAL, formatMass, massGrams, MATERIALS } from "../model/materials";

export function LevelIcon({ level }: { level: Level }) {
  if (level === "ok") return <Icons.Tick size={16} className="level-icon ok" />;
  if (level === "warn") return <Icons.Warning size={16} className="level-icon warn" />;
  return <Icons.Cross size={16} className="level-icon error" />;
}

/** Runs the check in the geometry worker and returns the report (an assembly's check when one is on show). */
export async function runCheck(): Promise<CheckReport> {
  const kernel = getKernel();
  await kernel.whenIdle();
  const asm = activeAssembly(useStore.getState());
  if (asm) {
    const s = useStore.getState();
    const solved = solveWithParts(asm, s.parts);
    const clashes = await kernel.clashes(instancesForKernel(asm, s.parts, solved));
    const names = Object.fromEntries(s.parts.map((p) => [p.id, p.name]));
    return assemblyReport(asm, solved, names, clashes);
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

  useEffect(() => {
    let cancelled = false;
    runCheck().then(
      (r) => !cancelled && setReport(r),
      (e: Error) => !cancelled && setError(e.message),
    );
    return () => {
      cancelled = true;
    };
  }, []);

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
