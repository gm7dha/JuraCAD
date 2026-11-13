/**
 * The printer setting, kept in this browser: which printer (its bed size) and
 * the print settings (nozzle, limits, printed fits). Stored under the old
 * PartSmith key so a printer chosen before is remembered; the print settings
 * were added to the same record later (missing = the usual values).
 */
import { bedSize, PRINTERS } from "../model/printBed";
import { parsePrintSettings, type PrintSettings } from "../model/printSettings";

// Browser-storage key from the app's old name (PartSmith); kept so the chosen printer is remembered.
export const PRINTER_KEY = "partsmith.printer";

export interface PrinterChoice {
  printer: string;
  custom?: [number, number, number];
}

export interface PrinterSetting extends PrinterChoice {
  print: PrintSettings;
  /** Filament slots in the AMS units: 4 (one AMS) or 8 (two). Missing = 8 on the X2D (the owner has two AMS Pros), else 4. */
  amsSlots?: 4 | 8;
}

/** How many filaments the AMS units hold, for the puzzles' colours. */
export const amsSlotsOf = (p: Pick<PrinterSetting, "printer" | "amsSlots">): 4 | 8 => p.amsSlots ?? (p.printer === "bambu-x2d" ? 8 : 4);

function readRaw(): Record<string, unknown> {
  try {
    const raw = globalThis.localStorage?.getItem(PRINTER_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

const isSize = (v: unknown): v is [number, number, number] => Array.isArray(v) && v.length === 3 && v.every((n) => typeof n === "number" && n > 0);

/** The printer chosen last time (the first in the list if none), with its print settings. */
export function loadPrinter(): PrinterSetting {
  const r = readRaw();
  return {
    printer: typeof r.printer === "string" ? r.printer : PRINTERS[0].id,
    ...(isSize(r.custom) ? { custom: r.custom } : {}),
    print: parsePrintSettings(r.print),
    ...(r.amsSlots === 4 || r.amsSlots === 8 ? { amsSlots: r.amsSlots } : {}),
  };
}

/** Remember a change to the printer or its settings (anything not given is kept). */
export function savePrinter(change: Partial<PrinterSetting>): PrinterSetting {
  const next = { ...loadPrinter(), ...change };
  try {
    globalThis.localStorage?.setItem(PRINTER_KEY, JSON.stringify(next));
  } catch {
    // Not remembered next time; fine.
  }
  return next;
}

/** The chosen printer's build volume, X × Y × Z mm. */
export function printerBed(p: PrinterChoice = loadPrinter()): [number, number, number] {
  return bedSize(p.printer, p.custom);
}
