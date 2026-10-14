import { useMemo, useState } from "react";

import { getKernel } from "../kernel/connect";
import type { CheckReport } from "../model/checkReport";
import { useDocument, activeAssembly, studioParts, useStore } from "../model/store";
import type { MeshQuality } from "../model/types";
import { runCheck, ReportView } from "./CheckDialog";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { Modal } from "./Modal";
import { instancesForKernel } from "./assemblySolve";

const QUALITY: { value: MeshQuality; label: string; hint: string }[] = [
  { value: "coarse", label: "Coarse", hint: "Small file, visible facets on curves" },
  { value: "normal", label: "Normal", hint: "Good for most uses" },
  { value: "fine", label: "Fine", hint: "Smoothest curves, larger file" },
];

export type ExportFormat = "step" | "stl" | "3mf";

const FORMATS: { value: ExportFormat; label: string; hint: string }[] = [
  {
    value: "step",
    label: "STEP (.step)",
    hint: "The exact shape — curves stay perfectly round. What machine shops and most manufacturers ask for (metal, nylon, moulding…).",
  },
  {
    value: "stl",
    label: "STL (.stl)",
    hint: "The shape as small triangles. For 3D printing and slicers, and services that ask for STL.",
  },
  {
    value: "3mf",
    label: "3MF (.3mf)",
    hint: "Triangles too, but tidier: keeps part names and is preferred by modern slicers (Bambu, Prusa, Cura).",
  },
];

type Stage = { kind: "options" } | { kind: "working"; text: string } | { kind: "warning"; report: CheckReport };

export function ExportDialog() {
  const doc = useDocument();
  const asm0 = activeAssembly(useStore.getState());
  // The Part Studio on show, or the copies placed in the assembly on show.
  const asm = useStore(activeAssembly);
  const allParts = useStore((s) => s.parts);
  const studio = useStore(studioParts);
  const instances = useMemo(() => (asm ? instancesForKernel(asm, allParts) : null), [asm, allParts]);
  const parts = instances ?? studio;
  const openDialog = useStore((s) => s.openDialog);
  const showToast = useStore((s) => s.showToast);
  const [which, setWhich] = useState<string>("all");
  const [quality, setQuality] = useState<MeshQuality>("normal");
  const [format, setFormat] = useState<ExportFormat>("step");
  const [fileName, setFileName] = useState(() => safeFileName(asm0 ? `${doc.name} ${asm0.name}` : doc.name));
  const [stage, setStage] = useState<Stage>({ kind: "options" });
  const [error, setError] = useState<string | null>(null);

  const close = () => openDialog(null);
  const partIds = instances ? [] : which === "all" ? parts.map((p) => p.id) : [which];
  // In an assembly: every copy, or just the one chosen.
  const chosenInstances = instances ? (which === "all" ? instances : instances.filter((i) => i.id === which)) : undefined;

  const doExport = async () => {
    setError(null);
    setStage({ kind: "working", text: `Creating ${format.toUpperCase()}…` });
    try {
      if (format === "step") {
        const { step, partCount } = await getKernel().exportStep(partIds, doc.appearance, chosenInstances);
        const name = `${safeFileName(fileName, "partsmith")}.step`;
        downloadFile(step, name, "model/step");
        showToast(`Saved ${name} (${partCount === 1 ? "1 part" : `${partCount} parts`})`, "success");
      } else if (format === "3mf") {
        const { data, triangleCount } = await getKernel().export3mf(partIds, quality, doc.name, doc.appearance, chosenInstances);
        const name = `${safeFileName(fileName, "partsmith")}.3mf`;
        downloadFile(data, name, "model/3mf");
        showToast(`Saved ${name} (${triangleCount.toLocaleString()} triangles)`, "success");
      } else {
        const { stl, triangleCount } = await getKernel().exportStl(partIds, quality, chosenInstances);
        const name = `${safeFileName(fileName, "partsmith")}.stl`;
        downloadFile(stl, name, "model/stl");
        showToast(`Saved ${name} (${triangleCount.toLocaleString()} triangles)`, "success");
      }
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage({ kind: "options" });
    }
  };

  /** Check first, as agreed in the design: only export straight away when everything is fine. */
  const checkThenExport = async () => {
    setError(null);
    setStage({ kind: "working", text: "Checking the model…" });
    try {
      const report = await runCheck();
      const relevant = which === "all" || instances ? report : { ...report, parts: report.parts.filter((p) => p.partId === which) };
      const level = relevant.parts.some((p) => p.level === "error")
        ? "error"
        : relevant.parts.some((p) => p.level === "warn") || report.level === "warn"
          ? "warn"
          : "ok";
      if (level === "ok") await doExport();
      else setStage({ kind: "warning", report: { ...relevant, level } });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage({ kind: "options" });
    }
  };

  if (stage.kind === "warning") {
    return (
      <Modal
        title="Before you export"
        onClose={close}
        footer={
          <>
            <button className="text-button" onClick={() => setStage({ kind: "options" })}>
              Back
            </button>
            <button className="primary-button" onClick={doExport}>
              Export anyway
            </button>
          </>
        }
      >
        <ReportView report={stage.report} />
      </Modal>
    );
  }

  const working = stage.kind === "working";
  return (
    <Modal
      title="Export"
      onClose={close}
      footer={
        <>
          <button className="text-button" onClick={close}>
            Cancel
          </button>
          <button className="primary-button" onClick={checkThenExport} disabled={working || parts.length === 0}>
            <Icons.Export size={18} /> {working ? stage.text : "Check & export"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <label htmlFor="export-parts">Parts</label>
        <select id="export-parts" value={which} onChange={(e) => setWhich(e.target.value)} disabled={working}>
          <option value="all">{asm ? `The whole assembly (${parts.length} parts, in place) in one file` : `All parts (${parts.length}) in one file`}</option>
          {parts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} only
            </option>
          ))}
        </select>

        <span className="form-label">Format</span>
        <div className="quality-options" role="radiogroup" aria-label="Format">
          {FORMATS.map((f) => (
            <label key={f.value} className={`quality-option${format === f.value ? " selected" : ""}`}>
              <input
                type="radio"
                name="format"
                value={f.value}
                checked={format === f.value}
                onChange={() => setFormat(f.value)}
                disabled={working}
              />
              <span className="quality-label">{f.label}</span>
              <span className="quality-hint">{f.hint}</span>
            </label>
          ))}
        </div>

        {format !== "step" && <span className="form-label">Quality</span>}
        {format !== "step" && (
        <div className="quality-options" role="radiogroup" aria-label="Quality">
          {QUALITY.map((q) => (
            <label key={q.value} className={`quality-option${quality === q.value ? " selected" : ""}`}>
              <input
                type="radio"
                name="quality"
                value={q.value}
                checked={quality === q.value}
                onChange={() => setQuality(q.value)}
                disabled={working}
              />
              <span className="quality-label">{q.label}</span>
              <span className="quality-hint">{q.hint}</span>
            </label>
          ))}
        </div>
        )}

        <label htmlFor="export-name">File name</label>
        <div className="param-input">
          <input id="export-name" value={fileName} onChange={(e) => setFileName(e.target.value)} disabled={working} />
          <span className="unit">.{format}</span>
        </div>
      </div>
      <p className="muted small">
        Units are millimetres. PartSmith checks the model before saving and warns you about any problems. Not sure which
        format? Send STEP — almost every manufacturer can use it.
      </p>
      {error && <p className="dialog-error">{error}</p>}
    </Modal>
  );
}
