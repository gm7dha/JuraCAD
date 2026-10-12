import { useEffect } from "react";

import { connectKernel } from "../kernel/connect";
import { useStore } from "../model/store";
import { Viewport, viewportApi } from "../viewport/Viewport";
import type { StandardView } from "../viewport/ViewCube";
import { CheckDialog } from "./CheckDialog";
import { ExportDialog } from "./ExportDialog";
import { FeatureDialog } from "./FeatureDialog";
import { FeaturePanel } from "./FeaturePanel";
import { HelpDialog } from "./HelpDialog";
import { BottomTabs, EmptyHint, EngineStatus, SelectionInfo, ToastView } from "./Overlays";
import { Toolbar } from "./Toolbar";
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

/** Onshape-style keyboard shortcuts. */
function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      const mod = e.ctrlKey || e.metaKey;

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
      }
      if (mod || e.altKey || isTyping(e.target) || s.dialog) return;

      if (e.shiftKey && SHIFT_VIEWS[e.code]) {
        e.preventDefault();
        viewportApi.current?.setView(SHIFT_VIEWS[e.code]);
        return;
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

  useEffect(() => connectKernel(), []);
  useShortcuts();

  return (
    <div className="app">
      <TopBar />
      <Toolbar />
      <div className="workspace">
        <FeaturePanel />
        <main className="viewport-area">
          <Viewport />
          <FeatureDialog />
          <EngineStatus />
          <EmptyHint />
          <SelectionInfo />
        </main>
      </div>
      <BottomTabs />
      {dialog === "check" && <CheckDialog />}
      {dialog === "export" && <ExportDialog />}
      {dialog === "help" && <HelpDialog />}
      <ToastView />
    </div>
  );
}
