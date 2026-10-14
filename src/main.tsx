import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./app/App";
import { viewportApi } from "./viewport/Viewport";
import "./app/styles.css";
import { useStore } from "./model/store";
import { initTheme } from "./app/theme";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// Keep a copy of the app on this computer so it works offline (live site only).
if (import.meta.env.PROD && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
      // Offline use just isn't available; everything else works.
    });
  });
}

// The browser smoke test (opened with ?smoke) reaches the 3D view to find where to click.
if (new URLSearchParams(window.location.search).has("smoke")) {
  (window as unknown as { partsmithViewport: typeof viewportApi }).partsmithViewport = viewportApi;
  (window as unknown as { partsmithStore: typeof useStore }).partsmithStore = useStore;
}

// Light or dark, before the first paint.
initTheme();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
