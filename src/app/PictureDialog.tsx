import { useState } from "react";

import { activeAssembly, useDocument, useStore } from "../model/store";
import { pictureSize } from "../viewport/pictureSize";
import type { PictureBackground } from "../viewport/studio";
import { viewportApi } from "../viewport/Viewport";
import { downloadFile, safeFileName } from "./download";
import { Icons } from "./icons";
import { Modal } from "./Modal";

const SIZES: { scale: number; label: string; hint: string }[] = [
  { scale: 1, label: "Same as the screen", hint: "As sharp as your screen shows it — for a message or a forum post" },
  { scale: 2, label: "Twice as big", hint: "Crisp on any screen" },
  { scale: 4, label: "Four times as big", hint: "For printing or a poster" },
];

const BACKGROUNDS: { value: PictureBackground; label: string; hint: string }[] = [
  { value: "light", label: "Plain light", hint: "White fading to soft grey" },
  { value: "dark", label: "Plain dark", hint: "Dark grey, makes bright colours stand out" },
  { value: "none", label: "See-through", hint: "No background, to put the parts on your own" },
];

/** Save picture: a PNG of the 3D view as it is, with studio lighting and a soft shadow. */
export function PictureDialog() {
  const doc = useDocument();
  const asm = useStore(activeAssembly);
  const openDialog = useStore((s) => s.openDialog);
  const showToast = useStore((s) => s.showToast);
  const [scale, setScale] = useState(2);
  const [background, setBackground] = useState<PictureBackground>("light");
  const [edges, setEdges] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState(() => safeFileName(asm ? `${doc.name} ${asm.name}` : doc.name));
  const close = () => openDialog(null);
  const view = viewportApi.current;
  const screen = view?.canvas.getBoundingClientRect();

  const save = async () => {
    const v = viewportApi.current;
    if (!v) return setError("The 3D view isn't ready yet. Try again in a moment.");
    setError(null);
    setWorking(true);
    // Let "Making the picture…" show before the drawing (which holds up the page for a moment) starts.
    await new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())));
    try {
      const png = await v.savePicture({ scale, background, edges });
      const name = `${safeFileName(fileName, "juracad")}.png`;
      downloadFile(png, name, "image/png");
      showToast(`Saved ${name}`, "success");
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWorking(false);
    }
  };

  return (
    <Modal
      title="Save a picture"
      onClose={close}
      footer={
        <>
          <button className="text-button" onClick={close}>
            Cancel
          </button>
          <button className="primary-button" onClick={() => void save()} disabled={working}>
            <Icons.Picture size={18} /> {working ? "Making the picture…" : "Save picture"}
          </button>
        </>
      }
    >
      <div className="form-grid">
        <span className="form-label">Size</span>
        <div className="quality-options" role="radiogroup" aria-label="Size">
          {SIZES.map((o) => {
            const dpr = Math.min(window.devicePixelRatio || 1, 3);
            const px = screen ? pictureSize(screen.width * dpr, screen.height * dpr, o.scale) : null;
            return (
              <label key={o.scale} className={`quality-option${scale === o.scale ? " selected" : ""}`}>
                <input type="radio" name="picture-size" checked={scale === o.scale} onChange={() => setScale(o.scale)} disabled={working} />
                <span className="quality-label">{o.label}</span>
                <span className="quality-hint">
                  {o.hint}
                  {px ? ` (${px.width} × ${px.height} pixels)` : ""}
                </span>
              </label>
            );
          })}
        </div>

        <span className="form-label">Background</span>
        <div className="quality-options" role="radiogroup" aria-label="Background">
          {BACKGROUNDS.map((o) => (
            <label key={o.value} className={`quality-option${background === o.value ? " selected" : ""}`}>
              <input type="radio" name="picture-background" checked={background === o.value} onChange={() => setBackground(o.value)} disabled={working} />
              <span className="quality-label">{o.label}</span>
              <span className="quality-hint">{o.hint}</span>
            </label>
          ))}
        </div>

        <span className="form-label">Edges</span>
        <label className="check-row">
          <input type="checkbox" checked={edges} onChange={(e) => setEdges(e.target.checked)} disabled={working} />
          Draw the parts' edges as thin dark lines
        </label>

        <label htmlFor="picture-name">File name</label>
        <div className="param-input">
          <input id="picture-name" value={fileName} onChange={(e) => setFileName(e.target.value)} disabled={working} />
          <span className="unit">.png</span>
        </div>
      </div>
      <p className="muted small">
        The picture shows the view as it is now — turn and zoom it first. Planes, sketches, the grid and highlights are left out; finishes
        (colour menu in the Parts list) get studio lighting and a soft shadow underneath.
      </p>
      {error && <p className="dialog-error">{error}</p>}
    </Modal>
  );
}
