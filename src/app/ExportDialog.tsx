import { useState } from "react";

import { getKernel } from "../kernel/connect";
import type { CheckReport } from "../model/checkReport";
import { useDocument, useStore } from "../model/store";
import type { MeshQuality } from "../model/types";
import { runCheck, ReportView } from "./CheckDialog";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { Modal } from "./Modal";

const QUALITY: { value: MeshQuality; label: string; hint: string }[] = [
  { value: "coarse", label: "Coarse", hint: "Small file, visible facets on curves" },
  { value: "normal", label: "Normal", hint: "Good for most prints" },
  { value: "fine", label: "Fine", hint: "Smoothest curves, larger file" },
];

type Stage = { kind: "options" } | { kind: "working"; text: string } | { kind: "warning"; report: CheckReport };

export function ExportDialog() {
  const doc = useDocument();
  const parts = useStore((s) => s.parts);
  const openDialog = useStore((s) => s.openDialog);
  const showToast = useStore((s) => s.showToast);
  const [which, setWhich] = useState<string>("all");
  const [quality, setQuality] = useState<MeshQuality>("normal");
  const [fileName, setFileName] = useState(() => safeFileName(doc.name));
  const [stage, setStage] = useState<Stage>({ kind: "options" });
  const [error, setError] = useState<string | null>(null);

  const close = () => openDialog(null);
  const partIds = which === "all" ? [] : [which];

  const doExport = async () => {
    setError(null);
    setStage({ kind: "working", text: "Creating STL…" });
    try {
      const { stl, triangleCount } = await getKernel().exportStl(partIds, quality);
      const name = `${safeFileName(fileName, "partsmith")}.stl`;
      downloadFile(stl, name, "model/stl");
      showToast(`Saved ${name} (${triangleCount.toLocaleString()} triangles)`, "success");
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
      const relevant = which === "all" ? report : { ...report, parts: report.parts.filter((p) => p.partId === which) };
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
      title="Export STL"
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
          <option value="all">All parts ({parts.length}) in one file</option>
          {parts.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} only
            </option>
          ))}
        </select>

        <span className="form-label">Quality</span>
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

        <label htmlFor="export-name">File name</label>
        <div className="param-input">
          <input id="export-name" value={fileName} onChange={(e) => setFileName(e.target.value)} disabled={working} />
          <span className="unit">.stl</span>
        </div>
      </div>
      <p className="muted small">Units are millimetres. PartSmith checks the model before saving and warns you about any problems.</p>
      {error && <p className="dialog-error">{error}</p>}
    </Modal>
  );
}
