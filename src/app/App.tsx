import { copySketchSelection, duplicateSketchSelection, pasteIntoSketch } from "./sketchClipboardApp";
import { startLink } from "./juraLinkApp";
import { startFeatureClipboard } from "./featureClipboardApp";
import { PasteDialog, SelectOtherMenu } from "./ViewTools";
import { SketchContextMenu } from "./SketchContextMenu";
import { closeSketchMenu, runSketchKey, sketchMenuNow } from "./sketchMenuActions";
import { sketchKeyFor } from "../sketch/sketchView";
import { useEffect } from "react";

import { connectKernel } from "../kernel/connect";
import { activeAssembly, activeDrawing, activeFeatures, keepsSteps, pickedFeatures, studioParts, useStore } from "../model/store";
import { setRenaming, stepFeatureSelection } from "./featureListState";
import { findDependents } from "../model/dependents";
import { DrawingPanel, DrawingSheet, DrawingToolbar } from "./DrawingUI";
import { AssemblyPanel, AssemblyToolbar, ExplodePanel, InsertPanel, InstancePanel, MateDialog, PatternPanel } from "./AssemblyUI";
import { AsmCutPanel, ContextBar } from "./AssemblyFeaturesUI";
import { Viewport, viewNormalToPlaneFeature, viewportApi } from "../viewport/Viewport";
import type { StandardView } from "../viewport/ViewCube";
import { CheckDialog } from "./CheckDialog";
import { ExportDialog } from "./ExportDialog";
import { DeleteDialog } from "./DeleteDialog";
import { PictureDialog } from "./PictureDialog";
import { FeatureDialog } from "./FeatureDialog";
import { FeaturePanel } from "./FeaturePanel";
import { HelpDialog } from "./HelpDialog";
import { FlatPatternDialog } from "./FlatPatternDialog";
import { WhatsNewDialog } from "./WhatsNewDialog";
import { VariablesDialog } from "./VariablesDialog";
import { LibraryDialog } from "./LibraryDialog";
import { IslandPuzzleDialog } from "./IslandPuzzleDialog";
import { MountainPuzzleDialog } from "./MountainPuzzleDialog";
import { useMountain } from "./mountainState";
import { ConfigurationsDialog } from "./ConfigurationsDialog";
import { CutListDialog } from "./CutListDialog";
import { ComparePanel, VersionBanner, VersionsDialog } from "./VersionsDialog";
import { MeasurePanel } from "./MeasurePanel";
import { MassButton, MassPanel } from "./MassPanel";
import { SectionPanel } from "./SectionPanel";
import { PrintBedPanel } from "./PrintBedPanel";
import { PrintPanel } from "./PrintPanel";
import { LaserPanel } from "./LaserPanel";
import { openFile, openFromFile, saveToFile } from "./fileActions";
import { inPopup } from "./popupGuard";
import { BottomTabs, EmptyHint, EngineStatus, SelectionInfo, ToastView } from "./Overlays";
import { SketchOverlay } from "./SketchOverlay";
import { SketchPanel } from "./SketchPanel";
import { SketchToolbar } from "./SketchToolbar";
import { ToolbarScroller } from "./ToolbarScroller";
import { deleteSketchSelection, setSketchTool, sketchEscape, toggleSketchConstruction, applySketchRelation } from "./sketchActions";
import { startSketchFromSelection, Toolbar } from "./Toolbar";
import { TopBar } from "./TopBar";
import { TouchBar } from "./TouchBar";
import { installTouchCompat } from "./touchCompat";

const SHIFT_VIEWS: Record<string, StandardView> = {
  Digit1: "front",
  Digit2: "back",
  Digit3: "left",
  Digit4: "right",
  Digit5: "top",
  Digit6: "bottom",
  Digit7: "iso",
};

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** Typing in a text box (not a tick box, choice button or slider, which have no text of their own to undo). */
function isTypingText(target: EventTarget | null): boolean {
  if (!isTyping(target)) return false;
  const el = target as HTMLElement;
  return !(el instanceof HTMLInputElement && ["checkbox", "radio", "button", "submit", "reset", "range", "color"].includes(el.type));
}

/** The key was pressed with nothing in particular focused: the page itself or the 3D view. */
function onPage(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || el === document.body || el === document.documentElement) return true;
  return typeof el.closest === "function" && !!el.closest(".viewport");
}

/**
 * Enter meant for the page, not for a control that has its own use for it. Only with nothing focused (the page, the
 * 3D view) — or, with a feature dialog open, a toolbar button (the one that opened the dialog keeps the focus), which
 * Enter would otherwise press again. Every other button, box or list keeps its Enter.
 */
function acceptsEnter(e: KeyboardEvent): boolean {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || e.isComposing) return false;
  if (onPage(e.target)) return true;
  const el = e.target as HTMLElement;
  if (typeof el.closest !== "function" || !useStore.getState().editing) return false;
  return el.tagName === "BUTTON" && !!el.closest('[role="toolbar"]') && !el.closest('[role="menu"], .feature-dialog');
}

/** Keyboard shortcuts while a sketch is open. Returns true if the key was used. */
function sketchShortcut(e: KeyboardEvent): boolean {
  const s = useStore.getState();
  if (!s.sketch) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (isTyping(e.target)) return false;
  if (mod) {
    const key = e.key.toLowerCase();
    // (While one of Move / copy's handles is held, undo waits: the drag is still changing the sketch.)
    if ((key === "z" || key === "y") && viewportApi.sketch?.draggingHandle()) return true;
    if (key === "z" && !e.shiftKey) s.sketchUndo();
    else if (key === "y" || (key === "z" && e.shiftKey)) s.sketchRedo();
    // Copy / paste / duplicate sketch shapes (text picked on the page is copied as usual).
    else if (key === "c" && !e.shiftKey && !e.altKey && !window.getSelection?.()?.toString()) return copySketchSelection();
    else if (key === "v" && !e.shiftKey && !e.altKey) pasteIntoSketch();
    else if (key === "d" && !e.shiftKey && !e.altKey) duplicateSketchSelection();
    else return false;
    return true;
  }
  if (e.altKey || s.dialog) return false;
  if (e.key === "Escape") {
    sketchEscape();
    return true;
  }
  if (e.key === "Delete" || e.key === "Backspace") return deleteSketchSelection() || true;
  // Onshape's relation keys (I, E, B, Shift+L…), X for Extend, Shift+P to hide construction geometry: sketch/sketchView.ts.
  const more = s.editing?.draft.sketch?.plane ? sketchKeyFor(e.code, e.shiftKey, e.key) : null;
  if (more) {
    // (A key pressed with the right-click menu open: the menu goes, its choices would be out of date.)
    if (sketchMenuNow()) closeSketchMenu();
    runSketchKey(more);
    return true;
  }
  // Shift+A while drawing lines: carry on with an arc from the last end (and back), as in Onshape.
  if (e.shiftKey) return e.key.toLowerCase() === "a" && !!viewportApi.sketch?.toggleLineArc();
  const tools: Record<string, Parameters<typeof setSketchTool>[0]> = {
    l: "line",
    r: "rectangle",
    c: "circle",
    a: "arc",
    p: "point",
    d: "dimension",
    s: "slot",
    g: "polygon",
    t: "trim",
    o: "offset",
    m: "mirror",
    u: "useEdge",
  };
  const key = e.key.toLowerCase();
  if (!s.editing?.draft.sketch?.plane) return false;
  if (tools[key]) {
    setSketchTool(tools[key]);
    return true;
  }
  if (key === "q") {
    toggleSketchConstruction();
    return true;
  }
  if (key === "h" || key === "v") {
    applySketchRelation(key === "h" ? "horizontal" : "vertical");
    return true;
  }
  if (key === "n") {
    viewportApi.current?.viewNormalToSketch(s.editing.draft.sketch.plane);
    return true;
  }
  return false;
}

/** Onshape-style keyboard shortcuts. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      // Save and open work everywhere, even while typing (and stop the browser saving the web page).
      if (mod && !e.altKey && (e.key.toLowerCase() === "s" || e.key.toLowerCase() === "o")) {
        e.preventDefault();
        if (s.dialog || inPopup(e.target, document)) return;
        if (e.key.toLowerCase() === "s") void saveToFile(e.shiftKey);
        else void openFromFile();
        return;
      }
      // Keys pressed in a popup (Live with Claude, Install as an app, Settings…) are the popup's own.
      if (inPopup(e.target, document)) return;
      if (sketchShortcut(e)) {
        e.preventDefault();
        return;
      }

      // Move / copy (or a dialog with manipulators) open: Ctrl+Z takes back its last drag (or click), one at a time.
      if (mod && !isTypingText(e.target) && s.editing && keepsSteps(s.editing.draft) && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (s.undoDraftStep()) e.preventDefault();
        return;
      }
      // Undo / redo the document — but not while typing in a box (the box
      // undoes its own text) or while a feature dialog is open, where it
      // would silently undo an earlier, already-saved change.
      if (mod && !isTyping(e.target) && !s.editing) {
        const key = e.key.toLowerCase();
        if (key === "z" && !e.shiftKey) {
          e.preventDefault();
          s.undo();
          return;
        }
        if (key === "y" || (key === "z" && e.shiftKey)) {
          e.preventDefault();
          s.redo();
          return;
        }
        // Ctrl/⌘ + D: duplicate the selected parts (Part Studio).
        if (key === "d" && !e.shiftKey && !activeDrawing(s) && !activeAssembly(s)) {
          const ids = s.selectedParts.length ? s.selectedParts : [...new Set(s.selection.map((x) => x.partId))];
          if (ids.length) {
            e.preventDefault();
            s.duplicateParts(ids);
            return;
          }
        }
      }
      // Enter accepts the open feature dialog from anywhere (as in Onshape) — but not from a text box, list or button
      // of the dialog itself, which handle it their own way (a box inside it submits the dialog anyway).
      if (e.key === "Enter" && acceptsEnter(e) && s.editing && s.editing.draft.type !== "sketch" && !s.dialog) {
        const ok = document.querySelector<HTMLButtonElement>(".feature-dialog .dialog-ok");
        if (ok) {
          e.preventDefault();
          ok.click();
          return;
        }
      }
      if (mod || e.altKey || isTyping(e.target) || (s.dialog && s.dialog !== "insert")) return;

      if (e.shiftKey && SHIFT_VIEWS[e.code]) {
        e.preventDefault();
        viewportApi.current?.setView(SHIFT_VIEWS[e.code]);
        return;
      }
      if (activeDrawing(s)) {
        if (e.key === "?") s.openDialog("help");
        return;
      }
      const asm = activeAssembly(s);
      if (asm) {
        if (e.key === "Escape") {
          if (s.mateDraft) s.cancelMateDraft();
          else if (s.dialog === "insert") s.openDialog(null);
          else s.setAsmSelection([]);
          return;
        }
        if ((e.key === "Delete" || e.key === "Backspace") && s.asmSelection.length && !s.mateDraft) {
          e.preventDefault();
          s.removeInstances(s.asmSelection);
          return;
        }
        if (e.key === "f" || e.key === "F") viewportApi.current?.fit();
        if (e.key === "?") s.openDialog("help");
        return;
      }
      if (e.shiftKey && !s.editing && s.kernelStatus === "ready") {
        if (e.code === "KeyS") {
          e.preventDefault();
          startSketchFromSelection();
          return;
        }
        if (e.code === "KeyE" && activeFeatures(s).some((f) => f.type === "sketch")) {
          e.preventDefault();
          s.startCreate("extrude");
          return;
        }
        if (e.code === "KeyF" && studioParts(s).length > 0) {
          e.preventDefault();
          s.startCreate("fillet");
          return;
        }
      }
      switch (e.key) {
        case "f":
        case "F":
          viewportApi.current?.fit();
          break;
        case "n":
        case "N":
          if (viewportApi.current?.viewNormalToSelection()) break;
          // A Plane feature selected in the list (or clicked in the view).
          if (s.selectedFeatureId && activeFeatures(s).find((f) => f.id === s.selectedFeatureId)?.type === "plane" && viewNormalToPlaneFeature(s.selectedFeatureId)) break;
          s.showToast("Select a face or plane first, then press N.");
          break;
        case "p":
        case "P": {
          // As in Onshape: show or hide all planes. Not in a sketch, where P is the Point tool.
          if (e.shiftKey || s.sketch || s.editing?.draft.type === "sketch") break;
          e.preventDefault();
          const shown = s.toggleAllPlanes();
          s.showToast(shown ? "Planes shown." : "Planes hidden — press P to show them again.");
          break;
        }
        case "?":
          s.openDialog("help");
          break;
        case "Escape":
          if (!s.editing) {
            s.setSelection([]);
            s.selectPlane(null);
            // Several features picked in the list: let them go.
            if (pickedFeatures(s).length > 1) s.selectFeature(null);
          }
          break;
        case "Delete":
        case "Backspace":
          if (s.selectedFeatureId && !s.editing) {
            e.preventDefault();
            const ids = pickedFeatures(s);
            // Other features use them: ask whether to delete those too (as Onshape does); else delete them as before.
            if (findDependents(activeFeatures(s), ids).dependents.length) s.askDelete({ ids, from: "key" });
            else if (ids.length > 1) s.deleteFeatures(ids, true);
            else s.deleteFeature(s.selectedFeatureId);
          }
          break;
        // The feature list: ↑ / ↓ move the selection (Shift: several), Enter edits it, F2 renames it.
        case "ArrowUp":
        case "ArrowDown":
          // Only with nothing else focused: a toolbar list, a menu or a box keeps its arrows.
          if (s.selectedFeatureId && !s.editing && !s.sketch && !s.dialog && onPage(e.target) && stepFeatureSelection(e.key === "ArrowDown" ? 1 : -1, e.shiftKey)) e.preventDefault();
          break;
        case "Enter":
          if (s.selectedFeatureId && !s.editing && !s.sketch && !s.dialog && pickedFeatures(s).length === 1 && acceptsEnter(e)) {
            e.preventDefault();
            s.startEdit(s.selectedFeatureId);
          }
          break;
        case "F2":
          if (s.selectedFeatureId && !s.editing && !s.sketch && !s.dialog) {
            e.preventDefault();
            setRenaming(s.selectedFeatureId);
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

export function App() {
  const dialog = useStore((s) => s.dialog);
  const deleteAsk = useStore((s) => s.deleteAsk !== null);
  const libraryOpen = useStore((s) => s.library !== null);
  const mountainOpen = useMountain((s) => s.open);
  const puzzleKind = useMountain((s) => s.kind);
  const sketching = useStore((s) => s.sketch !== null);
  const assembly = useStore(activeAssembly);
  const drawing = useStore(activeDrawing);

  useEffect(() => connectKernel(), []);
  // The link with JuraCUT: designs sent either way between the two apps' tabs.
  useEffect(() => startLink(), []);
  // Ctrl/⌘ + C and V copy and paste features (as in Onshape).
  useEffect(() => startFeatureClipboard(), []);
  useShortcuts();
  // Long press = right-click, double-tap = double-click on a touch screen (the lists, tabs and panels).
  useEffect(() => installTouchCompat(document), []);

  // Drop a .juracad (or older .partsmith) file anywhere on the window to open it.
  useEffect(() => {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      e.preventDefault();
      void openFile(file);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }, []);

  return (
    <div className="app">
      <TopBar />
      <ToolbarScroller>{drawing ? <DrawingToolbar /> : assembly ? <AssemblyToolbar /> : sketching ? <SketchToolbar /> : <Toolbar />}</ToolbarScroller>
      <div className="workspace">
        {drawing ? <DrawingPanel drawing={drawing} /> : assembly ? <AssemblyPanel assembly={assembly} /> : <FeaturePanel />}
        <main className="viewport-area">
          <Viewport />
          {drawing && <DrawingSheet drawing={drawing} />}
          {assembly ? (
            <>
              <InsertPanel />
              <InstancePanel />
              <PatternPanel />
              <ExplodePanel />
              <MateDialog />
              <AsmCutPanel />
            </>
          ) : (
            <>
              <SketchOverlay />
              <ContextBar />
              <FeatureDialog />
              <SketchPanel />
              <div className="readout-stack">
                <MassPanel />
                <MeasurePanel />
                <MassButton />
              </div>
            </>
          )}
          <EngineStatus />
          <TouchBar />
          <VersionBanner />
          {!drawing && !assembly && <ComparePanel />}
          {!drawing && (
            <>
              <EmptyHint />
              <SelectionInfo />
              <SectionPanel />
              <PrintBedPanel />
              <PrintPanel />
              <LaserPanel />
            </>
          )}
        </main>
      </div>
      <BottomTabs />
      {dialog === "check" && <CheckDialog />}
      {dialog === "export" && <ExportDialog />}
      {dialog === "picture" && <PictureDialog />}
      {dialog === "help" && <HelpDialog />}
      {dialog === "flatPattern" && <FlatPatternDialog />}
      {dialog === "whatsNew" && <WhatsNewDialog />}
      {dialog === "variables" && <VariablesDialog />}
      {dialog === "configurations" && <ConfigurationsDialog />}
      {dialog === "versions" && <VersionsDialog />}
      {dialog === "cutList" && <CutListDialog />}
      {deleteAsk && <DeleteDialog />}
      <PasteDialog />
      <SelectOtherMenu />
      <SketchContextMenu />
      {libraryOpen && <LibraryDialog />}
      {mountainOpen && (puzzleKind === "island" ? <IslandPuzzleDialog /> : <MountainPuzzleDialog />)}
      <ToastView />
    </div>
  );
}
