import { useEffect } from "react";

import { connectKernel } from "../kernel/connect";
import { activeAssembly, activeDrawing, activeFeatures, studioParts, useStore } from "../model/store";
import { DrawingPanel, DrawingSheet, DrawingToolbar } from "./DrawingUI";
import { AssemblyPanel, AssemblyToolbar, ExplodePanel, InsertPanel, InstancePanel, MateDialog, PatternPanel } from "./AssemblyUI";
import { Viewport, viewportApi } from "../viewport/Viewport";
import type { StandardView } from "../viewport/ViewCube";
import { CheckDialog } from "./CheckDialog";
import { ExportDialog } from "./ExportDialog";
import { FeatureDialog } from "./FeatureDialog";
import { FeaturePanel } from "./FeaturePanel";
import { HelpDialog } from "./HelpDialog";
import { VariablesDialog } from "./VariablesDialog";
import { ConfigurationsDialog } from "./ConfigurationsDialog";
import { MeasurePanel } from "./MeasurePanel";
import { SectionPanel } from "./SectionPanel";
import { openFile, openFromFile, saveToFile } from "./fileActions";
import { BottomTabs, EmptyHint, EngineStatus, SelectionInfo, ToastView } from "./Overlays";
import { SketchOverlay } from "./SketchOverlay";
import { SketchPanel } from "./SketchPanel";
import { SketchToolbar } from "./SketchToolbar";
import { ToolbarScroller } from "./ToolbarScroller";
import { deleteSketchSelection, setSketchTool, sketchEscape, toggleSketchConstruction, applySketchRelation } from "./sketchActions";
import { startSketchFromSelection, Toolbar } from "./Toolbar";
import { TopBar } from "./TopBar";

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

/** Keyboard shortcuts while a sketch is open. Returns true if the key was used. */
function sketchShortcut(e: KeyboardEvent): boolean {
  const s = useStore.getState();
  if (!s.sketch) return false;
  const mod = e.ctrlKey || e.metaKey;
  if (isTyping(e.target)) return false;
  if (mod) {
    const key = e.key.toLowerCase();
    if (key === "z" && !e.shiftKey) s.sketchUndo();
    else if (key === "y" || (key === "z" && e.shiftKey)) s.sketchRedo();
    else return false;
    return true;
  }
  if (e.altKey || s.dialog) return false;
  if (e.key === "Escape") {
    sketchEscape();
    return true;
  }
  if (e.key === "Delete" || e.key === "Backspace") return deleteSketchSelection() || true;
  if (e.shiftKey) return false;
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
        if (s.dialog) return;
        if (e.key.toLowerCase() === "s") void saveToFile(e.shiftKey);
        else void openFromFile();
        return;
      }
      if (sketchShortcut(e)) {
        e.preventDefault();
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
          if (!viewportApi.current?.viewNormalToSelection()) s.showToast("Select a face or plane first, then press N.");
          break;
        case "?":
          s.openDialog("help");
          break;
        case "Escape":
          if (!s.editing) {
            s.setSelection([]);
            s.selectPlane(null);
          }
          break;
        case "Delete":
        case "Backspace":
          if (s.selectedFeatureId && !s.editing) {
            e.preventDefault();
            s.deleteFeature(s.selectedFeatureId);
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
  const sketching = useStore((s) => s.sketch !== null);
  const assembly = useStore(activeAssembly);
  const drawing = useStore(activeDrawing);

  useEffect(() => connectKernel(), []);
  useShortcuts();

  // Drop a .partsmith file anywhere on the window to open it.
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
            </>
          ) : (
            <>
              <SketchOverlay />
              <FeatureDialog />
              <SketchPanel />
              <MeasurePanel />
            </>
          )}
          <EngineStatus />
          {!drawing && (
            <>
              <EmptyHint />
              <SelectionInfo />
              <SectionPanel />
            </>
          )}
        </main>
      </div>
      <BottomTabs />
      {dialog === "check" && <CheckDialog />}
      {dialog === "export" && <ExportDialog />}
      {dialog === "help" && <HelpDialog />}
      {dialog === "variables" && <VariablesDialog />}
      {dialog === "configurations" && <ConfigurationsDialog />}
      <ToastView />
    </div>
  );
}
