import { useEffect, useMemo, useRef, useState } from "react";

import { getKernel } from "../kernel/connect";
import type { PrintCheckPart } from "../kernel/protocol";
import { newId } from "../model/document";
import { CUSTOM_PRINTER, printerOf, PRINTERS } from "../model/printBed";
import { arrangeOnBed, MODEL_DOWN, printHeadline, printPartReport, type PrintPartReport, type PrintPartResult } from "../model/printCheck";
import { FIT_LABELS, FIT_NAMES, minWallOf, withFitVariables, type PrintSettings } from "../model/printSettings";
import { SLICERS, sentMessage, slicerById, type SlicerId } from "../model/slicers";
import { activeAssembly, studioParts, useDocument, useLengthUnit, useStore } from "../model/store";
import { formatArea, fromUnit, lengthNumber } from "../model/units";
import { viewportApi } from "../viewport/Viewport";
import { LevelIcon } from "./CheckDialog";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { loadPrinter, printerBed, savePrinter, type PrinterSetting } from "./printerSetting";
import { setPartDown, usePrintPanel } from "./printState";

/** Highlight colours in the 3D view (also shown as the key in the panel). */
export const PRINT_COLOURS = { overhang: "#ff8c1a", thin: "#e53935", small: "#9b59b6", bed: "#2e9d4f" };

const SLICER_KEY = "juracad.slicer";

function loadSlicer(): SlicerId {
  try {
    return slicerById(globalThis.localStorage?.getItem(SLICER_KEY) ?? undefined).id;
  } catch {
    return "bambu";
  }
}

/** The 3D print panel (Part Studios only). */
export function PrintPanel() {
  const open = usePrintPanel((s) => s.open);
  const inAssembly = useStore((s) => !!activeAssembly(s));
  if (!open || inAssembly) return null;
  return <PrintPanelBody />;
}

function PrintPanelBody() {
  const doc = useDocument();
  const parts = useStore(studioParts);
  const hidden = useStore((s) => s.hiddenParts);
  const downs = usePrintPanel((s) => s.downs);
  const picking = usePrintPanel((s) => s.picking);
  const unit = useLengthUnit();
  const showToast = useStore((s) => s.showToast);
  const [which, setWhich] = useState("shown");
  const [setting, setSetting] = useState<PrinterSetting>(loadPrinter);
  const [results, setResults] = useState<PrintPartResult[] | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [slicer, setSlicer] = useState<SlicerId>(loadSlicer);
  const [sent, setSent] = useState<string[] | null>(null);
  const runId = useRef(0);
  // Make room for the Print bed panel below (bottom right) when it's open.
  const bedPanelOn = useStore((s) => s.printBed !== null);
  const [bedPanelHeight, setBedPanelHeight] = useState(0);
  useEffect(() => {
    if (!bedPanelOn) {
      setBedPanelHeight(0);
      return;
    }
    let observer: ResizeObserver | null = null;
    const frame = requestAnimationFrame(() => {
      const el = document.querySelector(".print-bed-panel") as HTMLElement | null;
      if (!el) return;
      const measure = () => setBedPanelHeight(el.offsetHeight);
      measure();
      observer = new ResizeObserver(measure);
      observer.observe(el);
    });
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [bedPanelOn]);
  // The printer changed in the Print bed panel: use it here too.
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.printBed !== prev.printBed && s.printBed) setSetting(loadPrinter());
      }),
    [],
  );

  const chosen = useMemo(
    () => (which === "shown" ? parts.filter((p) => !hidden.includes(p.id)) : parts.filter((p) => p.id === which)),
    [parts, hidden, which],
  );
  const bed = printerBed(setting);
  const print = setting.print;
  // The parts the last check looked at; when they're rebuilt the results are out of date until "Check again".
  const [checkedParts, setCheckedParts] = useState<unknown>(null);
  const [nonce, setNonce] = useState(0);
  const stale = results !== null && checkedParts !== null && checkedParts !== parts && !working;
  const chosenKey = chosen.map((p) => p.id).join("|");

  // Check when the panel opens, and again when the parts chosen, which way they lie or the limits change —
  // not on every edit (the check can take a second or two, and the geometry engine does one thing at a time).
  useEffect(() => {
    const id = ++runId.current;
    setError(null);
    setSent(null);
    const st = useStore.getState();
    const now = studioParts(st);
    const ids = chosenKey ? chosenKey.split("|") : [];
    const requests: PrintCheckPart[] = ids.filter((i) => now.some((p) => p.id === i)).map((partId) => ({ partId, down: usePrintPanel.getState().downs[partId] ?? MODEL_DOWN }));
    if (!requests.length) {
      setResults([]);
      setCheckedParts(now);
      return;
    }
    setWorking(true);
    const timer = setTimeout(async () => {
      try {
        const kernel = getKernel();
        await kernel.whenIdle();
        const looked = studioParts(useStore.getState());
        const r = await kernel.printCheck(requests, { overhangAngle: print.overhangAngle, minWall: minWallOf(print), minHole: print.minHole, minPin: print.minPin });
        if (id === runId.current) {
          setResults(r);
          setCheckedParts(looked);
        }
      } catch (e) {
        if (id === runId.current) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (id === runId.current) setWorking(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [chosenKey, downs, print, nonce]);
  const requests: PrintCheckPart[] = useMemo(() => chosen.map((p) => ({ partId: p.id, down: downs[p.id] ?? MODEL_DOWN })), [chosen, downs]);

  // Light up what was found.
  useEffect(() => {
    const view = viewportApi.current;
    if (!view) return;
    view.setPrintMarks(
      (stale ? [] : (results ?? [])).flatMap((r) => [
        { triangles: r.marks.bed, colour: PRINT_COLOURS.bed, opacity: 0.55 },
        { triangles: r.marks.overhang, colour: PRINT_COLOURS.overhang },
        { triangles: r.marks.small, colour: PRINT_COLOURS.small },
        { triangles: r.marks.thin, colour: PRINT_COLOURS.thin, opacity: 0.85 },
      ]),
    );
  }, [results, stale]);
  useEffect(() => () => viewportApi.current?.setPrintMarks(null), []);

  // Picking the bed face: the next face clicked in the view.
  useEffect(() => {
    if (!picking) return;
    useStore.getState().setSelection([]);
    return useStore.subscribe((s, prev) => {
      if (s.selection === prev.selection) return;
      const face = s.selection.find((i) => i.kind === "face");
      if (!face) return;
      const flat = viewportApi.current?.flatFace(face);
      useStore.getState().setSelection([]);
      if (!flat) {
        useStore.getState().showToast("That face is curved — click a flat face to lay the part on.", "info");
        return;
      }
      setPartDown(face.partId, flat.normal);
      const name = useStore.getState().parts.find((p) => p.id === face.partId)?.name ?? "The part";
      useStore.getState().showToast(`${name} will print lying on that face (the design itself isn't changed).`, "success");
    });
  }, [picking]);
  // Esc stops picking.
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && usePrintPanel.setState({ picking: false });
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  const len = (mm: number) => `${lengthNumber(mm, unit, unit === "in" ? 3 : 2)} ${unit}`;
  const area = (mm2: number) => (unit === "in" ? formatArea(mm2, "in") : `${Math.round(mm2)} mm²`);
  const reports: PrintPartReport[] = (results ?? []).map((r) => printPartReport(r, print, bed, len, area));
  const headline = printHeadline(reports);
  const solid = (results ?? []).filter((r) => !r.surface);
  const layout = solid.length > 1 ? arrangeOnBed(solid.map((r) => ({ id: r.partId, size: [r.size[0], r.size[1]] })), [bed[0], bed[1]], print.gap) : null;
  const nameOf = (id: string) => parts.find((p) => p.id === id)?.name ?? id;

  const change = (next: Partial<PrinterSetting>) => {
    const saved = savePrinter(next);
    setSetting(saved);
    // Keep the print bed preview (if on) showing the same printer.
    if (next.printer !== undefined && useStore.getState().printBed) useStore.getState().setPrintBed(saved.custom ? { printer: saved.printer, custom: saved.custom } : { printer: saved.printer });
  };
  const changePrint = (patch: Partial<PrintSettings>) => change({ print: { ...print, ...patch } });

  const sendToSlicer = async () => {
    setError(null);
    setSent(null);
    const solidRequests = requests.filter((r) => !parts.find((p) => p.id === r.partId)?.surface);
    if (!solidRequests.length) {
      setError("There's no solid part to send. Surfaces can't be printed — thicken them first.");
      return;
    }
    setWorking(true);
    try {
      const kernel = getKernel();
      await kernel.whenIdle();
      const out = await kernel.exportPrint3mf(solidRequests, [bed[0], bed[1]], print.gap, "normal", doc.name, doc.appearance);
      // (Plain colours only: slicers read #RRGGBB, and a print is never see-through.)
      const name = `${safeFileName(chosen.length === 1 ? `${doc.name} ${chosen[0].name}` : doc.name, "juracad")}.3mf`;
      downloadFile(out.data, name, "model/3mf");
      const off = out.layout.places.filter((p) => !p.onBed).length;
      setSent(sentMessage(slicerById(slicer), name, out.layout.places.length - off, off));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const addFitVariables = () => {
    const s = useStore.getState();
    const { variables, added, changed } = withFitVariables(s.history.present.variables, print.fits, () => newId("v"), true);
    if (!added.length && !changed.length) {
      showToast("The design's fit variables already match these sizes.", "info");
      return;
    }
    s.setVariables(variables);
    showToast(
      `${added.length ? `Added ${added.join(", ")}` : ""}${added.length && changed.length ? "; " : ""}${changed.length ? `updated ${changed.join(", ")}` : ""}. Type e.g. "5 + fit_sliding" for a hole's size.`,
      "success",
    );
  };

  const num = (label: string, value: number | null, onChange: (v: number | null) => void, opts: { min?: number; step?: number; length?: boolean; placeholder?: string } = {}) => (
    <NumberField
      label={label}
      value={value === null ? "" : opts.length === false ? String(value) : lengthNumber(value, unit, unit === "in" ? 4 : 3)}
      min={opts.min ?? 0}
      step={opts.step ?? 0.1}
      placeholder={opts.placeholder}
      onChange={(text) => {
        if (text.trim() === "") return onChange(null);
        const v = Number(text);
        if (Number.isFinite(v)) onChange(opts.length === false ? v : fromUnit(v, unit));
      }}
    />
  );

  return (
    <div
      className="section-panel print-panel"
      role="region"
      aria-label="3D print"
      style={bedPanelHeight ? { maxHeight: `max(140px, calc(100% - 170px - ${bedPanelHeight + 12}px))` } : undefined}
    >
      <div className="section-header">
        <strong>3D print</strong>
        <button className="icon-button small" onClick={() => usePrintPanel.setState({ open: false, picking: false })} title="Close the 3D print panel" aria-label="Close 3D print">
          <Icons.Cross size={14} />
        </button>
      </div>
      <label className="field-label" htmlFor="print-which">
        Parts
      </label>
      <select id="print-which" className="full-select" value={which} onChange={(e) => setWhich(e.target.value)}>
        <option value="shown">Every part shown ({parts.filter((p) => !hidden.includes(p.id)).length})</option>
        {parts.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>

      <div className="print-orient">
        {picking ? (
          <>
            <p className="small print-picking">Click a flat face of a part: it goes face-down on the bed. (Esc to stop.)</p>
            <button className="text-button" onClick={() => usePrintPanel.setState({ picking: false })}>
              Stop
            </button>
          </>
        ) : (
          <>
            <button className="text-button" onClick={() => usePrintPanel.setState({ picking: true })} title="Choose the face each part sits on when printed. The design isn't changed — only the check and the slicer file.">
              Lay flat on a face…
            </button>
            {chosen.some((p) => downs[p.id]) && (
              <button className="text-button" onClick={() => chosen.forEach((p) => setPartDown(p.id, null))} title="Print the way it's modelled, with Z up">
                As modelled
              </button>
            )}
          </>
        )}
      </div>
      <p className="muted small">
        {chosen.length === 1
          ? downs[chosen[0].id]
            ? "Lying on the face you chose."
            : "The way it's modelled (Z up)."
          : `${chosen.filter((p) => downs[p.id]).length} of ${chosen.length} lying on a chosen face; the rest as modelled (Z up).`}
      </p>

      <button className={stale ? "primary-button" : "text-button"} onClick={() => setNonce((n) => n + 1)} disabled={working} title="Check the parts again (after changing the design)">
        {working ? "Checking…" : "Check again"}
      </button>
      {error && <p className="dialog-error">{error}</p>}
      {working && !results && <p className="muted small">Checking…</p>}
      {results && (
        <div className="print-report" aria-busy={working}>
          <div className={`check-headline ${stale ? "warn" : headline.level}`}>
            <LevelIcon level={stale ? "warn" : headline.level} />
            <span>{working ? "Checking…" : stale ? "The design has changed since this check." : headline.text}</span>
          </div>
          {reports.map((r) => (
            <section key={r.partId} className="check-part">
              {reports.length > 1 && (
                <h4>
                  <LevelIcon level={r.level} /> {r.name}
                </h4>
              )}
              <ul>
                {r.findings.map((f, i) => (
                  <li key={i} className={f.level}>
                    <LevelIcon level={f.level} /> {f.text}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {layout && (
            <p className={`small ${layout.tooBig.length || layout.noRoom.length ? "print-bed-bad" : "print-bed-ok"}`}>
              {layout.tooBig.length || layout.noRoom.length
                ? `Not all on one plate: ${[...layout.tooBig, ...layout.noRoom].map(nameOf).join(", ")} ${layout.tooBig.length + layout.noRoom.length === 1 ? "needs" : "need"} a plate of ${layout.tooBig.length + layout.noRoom.length === 1 ? "its" : "their"} own (or a bigger printer).`
                : `✓ All ${solid.length} parts fit on one plate together.`}
            </p>
          )}
          <div className="print-key small" aria-label="Colour key">
            <span><i style={{ background: PRINT_COLOURS.overhang }} /> needs support</span>
            <span><i style={{ background: PRINT_COLOURS.thin }} /> too thin</span>
            <span><i style={{ background: PRINT_COLOURS.small }} /> small hole/pin</span>
            <span><i style={{ background: PRINT_COLOURS.bed }} /> on the bed</span>
          </div>
        </div>
      )}

      <fieldset className="param-group print-send">
        <legend>Send to slicer</legend>
        <select className="full-select" aria-label="Slicer" value={slicer} onChange={(e) => {
          const id = e.target.value as SlicerId;
          setSlicer(id);
          setSent(null);
          try {
            globalThis.localStorage?.setItem(SLICER_KEY, id);
          } catch {
            // not remembered; fine
          }
        }}>
          {SLICERS.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button className="primary-button" onClick={sendToSlicer} disabled={working || !chosen.length}>
          <Icons.Export size={16} /> Save 3MF for {slicer === "other" ? "the slicer" : slicerById(slicer).name}
        </button>
        <p className="muted small">Each part as its own named, coloured object, the right way up and laid out on the plate. Your design isn't changed.</p>
        {sent && (
          <div className="print-sent" role="status">
            {sent.map((line, i) => (
              <p key={i} className="small">
                {line}
              </p>
            ))}
          </div>
        )}
      </fieldset>

      <button className="text-button" aria-expanded={showSettings} onClick={() => setShowSettings((v) => !v)}>
        {showSettings ? "▾" : "▸"} Printer settings
      </button>
      {showSettings && (
        <div className="print-settings">
          <label className="field-label" htmlFor="print-printer">
            Printer
          </label>
          <select id="print-printer" className="full-select" value={setting.printer} onChange={(e) => change(e.target.value === CUSTOM_PRINTER ? { printer: CUSTOM_PRINTER, custom: bed } : { printer: e.target.value })}>
            {PRINTERS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.size.join(" × ")}
              </option>
            ))}
            <option value={CUSTOM_PRINTER}>Another printer (type its bed size)…</option>
          </select>
          {printerOf(setting.printer)?.note && <p className="muted small">{printerOf(setting.printer)!.note}</p>}
          {setting.printer === CUSTOM_PRINTER && (
            <div className="print-setting-grid">
              {["Bed X", "Bed Y", "Height"].map((label, i) => (
                <span key={label}>
                  {num(label, bed[i], (v) => {
                    if (!(v && v > 0)) return;
                    const custom = [...bed] as [number, number, number];
                    custom[i] = v;
                    change({ printer: CUSTOM_PRINTER, custom });
                  }, { min: 1, step: 1 })}
                </span>
              ))}
            </div>
          )}
          <div className="print-setting-grid">
            {num("Nozzle", print.nozzle, (v) => v && v > 0 && changePrint({ nozzle: v }), { step: 0.05 })}
            {num("Overhang limit (°)", print.overhangAngle, (v) => v && v > 0 && v < 90 && changePrint({ overhangAngle: v }), { step: 5, length: false })}
            {num("Thinnest wall", print.minWall, (v) => changePrint({ minWall: v && v > 0 ? v : null }), { placeholder: `${lengthNumber(2 * print.nozzle, unit)} (2 × nozzle)` })}
            {num("Smallest hole", print.minHole, (v) => v !== null && v >= 0 && changePrint({ minHole: v }))}
            {num("Thinnest pin", print.minPin, (v) => v !== null && v >= 0 && changePrint({ minPin: v }))}
            {num("Space between parts", print.gap, (v) => v !== null && v >= 0 && changePrint({ gap: v }), { step: 1 })}
          </div>
          <p className="field-label">Printed fits — how much bigger to make a hole than what goes in it</p>
          <div className="print-setting-grid">
            {FIT_NAMES.map((f) => (
              <span key={f} title={FIT_LABELS[f].hint}>
                {num(FIT_LABELS[f].label, print.fits[f], (v) => v !== null && changePrint({ fits: { ...print.fits, [f]: v } }), { min: -2, step: 0.05 })}
              </span>
            ))}
          </div>
          <button className="text-button" onClick={addFitVariables} title="Adds fit_press, fit_snug, fit_sliding and fit_loose to this design's variables (or updates them), so a hole can be typed as 5 + fit_sliding">
            Put these fits in the design as variables
          </button>
          <p className="muted small">Print a test piece to tune them for your printer: they're remembered in this browser. A hole dialog's "Printed fit" uses them too.</p>
        </div>
      )}
    </div>
  );
}

/** A number box that keeps what's being typed (e.g. "0.") and settles to the saved value when left. */
function NumberField({ label, value, min, step, placeholder, onChange }: { label: string; value: string; min: number; step: number; placeholder?: string; onChange: (text: string) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="print-setting">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        step={step}
        aria-label={label}
        placeholder={placeholder}
        value={text ?? value}
        onChange={(e) => {
          setText(e.target.value);
          onChange(e.target.value);
        }}
        onBlur={() => setText(null)}
      />
    </label>
  );
}
