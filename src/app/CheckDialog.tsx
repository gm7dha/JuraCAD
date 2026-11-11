import { useEffect, useState } from "react";

import { getKernel } from "../kernel/connect";
import { buildCheckReport, type CheckReport, type Level } from "../model/checkReport";
import { activeAssembly, activeFeatures, studioParts, useLengthUnit, useStore } from "../model/store";
import { evaluate } from "../model/expr";
import { lengthNumber, storeLength } from "../model/units";
import { solveWithParts } from "../assembly/mates";
import { assemblyReport, DEFAULT_CLASH_OPTIONS, judgeContacts, parseClashOptions, type ClashOptions } from "../assembly/assemblyCheck";
import { copyPathName, defaultFitRange, fitFor, fitRangeFor, judgeFits, matePair, MAX_FIT, pairKey, printFitsFrom, type FitFinding } from "../assembly/fits";
import type { PrintFits } from "../model/printSettings";
import { newId } from "../model/document";
import type { Assembly, IntendedFit } from "../model/types";
import { loadPrinter } from "./printerSetting";
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

/** The printed fits to compare with: the design's fit_* variables where it has them, else this browser's printer settings (as the extension, which falls back to the usual values). */
function printFitsNow(): PrintFits {
  const read = (text: string) => {
    const r = evaluate(text);
    return r.ok ? r.value : null;
  };
  return printFitsFrom(useStore.getState().history.present.variables, read, loadPrinter().print.fits);
}

/** Runs the check in the geometry worker and returns the report (an assembly's check when one is on show). */
export async function runCheck(options: ClashOptions = loadClashOptions()): Promise<CheckReport> {
  const kernel = getKernel();
  await kernel.whenIdle();
  const asm = activeAssembly(useStore.getState());
  if (asm) {
    const s = useStore.getState();
    const assemblies = s.history.present.assemblies ?? [];
    const solved = solveWithParts(asm, s.parts, { assemblies });
    // Suppressed parts are always left out (instancesForKernel); hidden ones when asked. Parts inside
    // sub-assemblies are checked too — against each other and against everything else.
    const all = instancesForKernel(asm, s.parts, assemblies, solved);
    const isHidden = (key: string) => options.skipHidden && s.hiddenInstances.some((h) => key === h || key.startsWith(`${h}/`));
    const instances = all.filter((i) => !isHidden(i.id));
    const hidden = all.filter((i) => isHidden(i.id));
    // Gaps only matter when touching parts are listed — or for the fit check: every pair when it's asked for, else just the marked ones.
    const withFits = !!options.checkFits || !!asm.fits?.length;
    const range = withFits ? fitRangeFor(asm.fits) : 0;
    const onlyMarked = !options.checkFits ? (asm.fits ?? []).map((f): [string, string] => [f.a, f.b]) : undefined;
    const measured = await kernel.clashes(instances, options.tolerance, !options.ignoreTouching, range, onlyMarked);
    const names = Object.fromEntries(s.parts.map((p) => [p.id, p.name]));
    const fits = withFits
      ? judgeFits({ measured, intended: asm.fits ?? [], tolerance: options.tolerance, printFits: printFitsNow(), nameOf: (k) => instances.find((i) => i.id === k)?.name })
      : undefined;
    return assemblyReport(asm, solved, names, judgeContacts(measured, options), options, { hidden: hidden.length, suppressed: asm.instances.filter((i) => i.suppressed).length }, assemblies, fits);
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

/** The pair a Fits line is about, for marking it as a fit. */
export type FitPair = NonNullable<FitFinding["pair"]>;

export function ReportView({ report, onFit }: { report: CheckReport; onFit?: (pair: FitPair) => void }) {
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
            {p.findings.map((f, i) => {
              const pair = (f as FitFinding).pair;
              return (
                <li key={i} className={f.level}>
                  <LevelIcon level={f.level} /> <span>{f.text}</span>
                  {pair && onFit && (
                    <button className="link-button fit-mark" onClick={() => onFit(pair)}>
                      {pair.fit ? "Change…" : "Mark as a fit…"}
                    </button>
                  )}
                </li>
              );
            })}
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
  const asmFits = useStore((s) => activeAssembly(s)?.fits ?? NO_FITS);
  const [editing, setEditing] = useState<FitPair | null>(null);

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
  }, [options, asmFits]);

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
      {inAssembly && (options.checkFits || asmFits.length > 0) && <MatePairPicker onPick={setEditing} />}
      {inAssembly && editing && <FitEditor key={pairKey(editing.a, editing.b)} pair={editing} onClose={() => setEditing(null)} />}
      {error ? (
        <p className="dialog-error">{error}</p>
      ) : report ? (
        <ReportView report={report} onFit={inAssembly ? setEditing : undefined} />
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
      <label title="How much parts that overlap go into each other, and the gap between parts that nearly touch (a pin in a hole, a sliding lid) — with which of your printer's fits each gap is like">
        <input type="checkbox" checked={!!options.checkFits} onChange={(e) => onChange({ checkFits: e.target.checked })} /> Check fits (interference and clearance)
      </label>
    </div>
  );
}

const NO_FITS: IntendedFit[] = [];

/** A part's name in the assembly by its key ("copy" or "copy/inner/part"), every level named: "Sub <1> / Inner <1> / Pin <1>". */
/** Mark the two parts a mate joins as a fit. */
function MatePairPicker({ onPick }: { onPick: (pair: FitPair) => void }) {
  const asm = useStore((s) => activeAssembly(s));
  const assemblies = useStore((s) => s.history.present.assemblies ?? NO_ASSEMBLIES);
  const mates = (asm?.mates ?? []).filter((m) => matePair(m));
  if (!asm || !mates.length) return null;
  return (
    <div className="clash-options">
      <label>
        Mark the parts of a mate as a fit:{" "}
        <select
          aria-label="Mate to mark as a fit"
          value=""
          onChange={(e) => {
            const m = mates.find((x) => x.id === e.target.value);
            const p = m && matePair(m);
            if (!p) return;
            onPick({ a: p[0], b: p[1], names: [copyPathName(asm, assemblies, p[0]), copyPathName(asm, assemblies, p[1])], fit: fitFor(asm, p[0], p[1]) });
          }}
        >
          <option value="">Choose a mate…</option>
          {mates.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

const NO_ASSEMBLIES: Assembly[] = [];

/** Mark (or change, or remove) the fit wanted between two parts: press or clearance, and how much. */
function FitEditor({ pair, onClose }: { pair: FitPair; onClose: () => void }) {
  const unit = useLengthUnit();
  const asm = useStore((s) => activeAssembly(s));
  const setAssemblyFit = useStore((s) => s.setAssemblyFit);
  const removeAssemblyFit = useStore((s) => s.removeAssemblyFit);
  const existing = (asm && fitFor(asm, pair.a, pair.b)) ?? pair.fit;
  const startKind: IntendedFit["kind"] = existing?.kind ?? (pair.measured?.kind === "gap" ? "clearance" : "press");
  const [kind, setKind] = useState<IntendedFit["kind"]>(startKind);
  const [printFits] = useState(printFitsNow);
  const show = (mm: number) => lengthNumber(mm, unit, unit === "in" ? 5 : 3);
  const [from, setFrom] = useState(show(existing?.min ?? defaultFitRange(startKind, printFits)[0]));
  const [to, setTo] = useState(show(existing?.max ?? defaultFitRange(startKind, printFits)[1]));
  const onEnter = (e: { key: string; preventDefault(): void }) => {
    if (e.key === "Enter") {
      e.preventDefault();
      save();
    }
  };
  const [problem, setProblem] = useState<string | null>(null);
  const read = (t: string) => {
    const r = evaluate(storeLength(t, unit));
    return r.ok && Number.isFinite(r.value) ? r.value : null;
  };
  const save = () => {
    const min = read(from);
    const max = read(to);
    if (min === null || max === null || min < 0 || max > MAX_FIT) return setProblem(`Type two amounts from 0 to ${MAX_FIT} mm.`);
    if (min > max) return setProblem("The first amount should be the smaller one.");
    setAssemblyFit({ id: existing?.id ?? newId("fit"), a: pair.a, b: pair.b, kind, min, max });
    onClose();
  };
  return (
    <div className="fit-editor" role="group" aria-label="Fit between two parts">
      <div className="fit-editor-title">
        {pair.names[0]} and {pair.names[1]}
      </div>
      <label>
        Meant to be{" "}
        <select
          aria-label="Kind of fit"
          value={kind}
          onChange={(e) => {
            const k = e.target.value as IntendedFit["kind"];
            setKind(k);
            if (!existing) {
              const [lo, hi] = defaultFitRange(k, printFits);
              setFrom(show(lo));
              setTo(show(hi));
            }
          }}
        >
          <option value="press">a press fit — drawn a little too big, so they overlap and it grips</option>
          <option value="printed">a printed press fit — drawn with a small gap, as printed holes come out small</option>
          <option value="clearance">a clearance fit — a small gap, so it slides</option>
        </select>
      </label>
      <label>
        {kind === "press" ? "Overlap" : "Gap"} from <input className="clash-tolerance" aria-label="Smallest amount" value={from} onChange={(e) => setFrom(e.target.value)} onKeyDown={onEnter} /> to{" "}
        <input className="clash-tolerance" aria-label="Largest amount" value={to} onChange={(e) => setTo(e.target.value)} onKeyDown={onEnter} /> {unit}
      </label>
      <p className="muted fit-editor-note">
        On the diameter for a pin in a hole (as your printer's fits are), otherwise straight across.
        {kind === "press" && ` For 3D printing, a press fit is usually drawn with a small gap instead (your printer's is ${lengthNumber(printFits.press, unit, 3)} ${unit}), because printed holes come out a little small — choose "a printed press fit" for that.`}
        {kind === "printed" && ` Your printer's press fit is ${lengthNumber(printFits.press, unit, 3)} ${unit}.`}
      </p>
      {problem && <p className="dialog-error">{problem}</p>}
      <div className="fit-editor-buttons">
        <button className="primary-button" onClick={save}>
          Save fit
        </button>
        {existing && (
          <button
            className="text-button"
            onClick={() => {
              removeAssemblyFit(existing.id);
              onClose();
            }}
          >
            Remove the mark
          </button>
        )}
        <button className="text-button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
