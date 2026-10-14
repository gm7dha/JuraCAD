import { useEffect, useState } from "react";

import { activeAssembly, activeDrawing, useDocument, useStore } from "../model/store";
import { exportDrawing } from "./DrawingUI";
import { allFeatures } from "../model/studios";
import { Icons } from "./icons";
import { forgetFile, openFromFile, saveToFile } from "./fileActions";
import { browserKind, installApp, installSteps, isInstalledApp, useCanInstall } from "./install";
import { Modal } from "./Modal";
import { SHORT_VERSION } from "../version";
import { detectPlatform, shortcut } from "./platform";

export function TopBar() {
  const doc = useDocument();
  const renameDocument = useStore((s) => s.renameDocument);
  const openDialog = useStore((s) => s.openDialog);
  const newDocument = useStore((s) => s.newDocument);
  const hasParts = useStore((s) => s.parts.length > 0);
  const inAssembly = useStore((s) => activeAssembly(s) !== null);
  const inDrawing = useStore((s) => activeDrawing(s) !== null);
  const fileName = useStore((s) => s.fileName);
  const unsaved = useStore((s) => s.savedDoc !== s.history.present && allFeatures(s.history.present).length > 0);
  const platform = detectPlatform();
  const canInstall = useCanInstall();
  const [installHelp, setInstallHelp] = useState(false);
  const installed = isInstalledApp();
  const [name, setName] = useState(doc.name);

  useEffect(() => setName(doc.name), [doc.name]);

  return (
    <header className="topbar">
      <div className="brand" title="PartSmith">
        <img src={`${import.meta.env.BASE_URL}favicon.svg`} alt="" width={24} height={24} />
        <span>PartSmith</span>
      </div>
      <input
        className="doc-name"
        value={name}
        aria-label="Document name"
        title="Click to rename"
        onChange={(e) => setName(e.target.value)}
        onBlur={() => (name.trim() ? renameDocument(name) : setName(doc.name))}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            setName(doc.name);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <span
        className={`save-state${unsaved ? " unsaved" : ""}`}
        title={
          unsaved
            ? "Your work is kept in this browser, but has changes not yet saved to a file. Click Save to keep a copy on your computer."
            : `Saved to ${fileName}`
        }
      >
        {unsaved ? (fileName ? "Unsaved changes" : "Not saved to a file") : fileName ? `Saved · ${fileName}` : ""}
      </span>
      <span className="phase-badge" title="Your PartSmith version. See Help (?) for what's new.">
        {SHORT_VERSION} preview
      </span>
      <div className="topbar-spacer" />
      {!installed && (
        <button className="text-button" onClick={() => (canInstall ? void installApp() : setInstallHelp(true))} title="Install PartSmith as an app on this computer — it then opens in its own window and works offline">
          <Icons.Export size={18} style={{ transform: "rotate(180deg)" }} /> <span className="button-label">Install</span>
        </button>
      )}
      <button
        className="text-button"
        onClick={() => {
          if (allFeatures(doc).length === 0 || window.confirm("Start a new, empty design? (You can undo this.)")) {
            newDocument();
            forgetFile();
          }
        }}
        title="Start a new empty part"
      >
        <Icons.New size={18} /> <span className="button-label">New</span>
      </button>
      <button className="text-button" onClick={() => void openFromFile()} title={`Open a .partsmith file (${shortcut(platform, "O")})`}>
        <Icons.Open size={18} /> <span className="button-label">Open</span>
      </button>
      <button
        className="text-button"
        onClick={() => void saveToFile()}
        title={`Save to a .partsmith file on your computer (${shortcut(platform, "S")}). ${shortcut(platform, "S", { shift: true })} saves a copy under a new name.`}
      >
        <Icons.Save size={18} /> <span className="button-label">Save</span>
      </button>
      <button className="text-button" onClick={() => openDialog("check")} disabled={!hasParts || inDrawing} title={inAssembly ? "Check the assembly: do any parts clash, and are all the mates working?" : "Check the model is a sound, closed solid before you export it"}>
        <Icons.Check size={18} /> <span className="button-label">Check model</span>
      </button>
      <button
        className="primary-button"
        onClick={() => (inDrawing ? exportDrawing("pdf") : openDialog("export"))}
        disabled={!hasParts}
        title={inDrawing ? "Save this drawing as a PDF (the toolbar also offers SVG)" : "Download a STEP or STL file to send to a manufacturer or 3D printer"}
      >
        <Icons.Export size={18} /> <span className="button-label">Export</span>
      </button>
      <button className="icon-button" onClick={() => openDialog("help")} aria-label="Help and shortcuts" title="Help and shortcuts (?)">
        <Icons.Help />
      </button>
      {installHelp && (
        <Modal title="Install PartSmith as an app" onClose={() => setInstallHelp(false)} width={480}>
          <p>Installed, PartSmith opens in its own window, has its own icon, and works without an internet connection.</p>
          <ol className="install-steps">
            {installSteps(browserKind()).map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </Modal>
      )}
    </header>
  );
}
