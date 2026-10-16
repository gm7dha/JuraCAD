import { useMemo } from "react";

import { sheetDxf, sheetSvg } from "../drawing/export";
import { flatPrims, flatSize } from "../sheetmetal/flatExport";
import { activeFeatures, studioParts, useDocument, useLengthUnit, useStore } from "../model/store";
import { showLength } from "../model/units";
import { downloadFile, safeFileName } from "./download";
import { Modal } from "./Modal";
import type { PartMesh } from "../kernel/protocol";

/** The sheet metal part the flat pattern is for: the one selected, or the only one there is. */
export function flatPatternPart(parts: PartMesh[], selected: string[]): PartMesh | undefined {
  const sheets = parts.filter((p) => p.flat);
  return sheets.find((p) => selected.includes(p.id)) ?? (sheets.length === 1 ? sheets[0] : undefined);
}

/** A sheet metal part laid out flat, to check and save for laser cutting. */
export function FlatPatternDialog() {
  const parts = useStore(studioParts);
  const selected = useStore((s) => s.selectedParts);
  const features = useStore(activeFeatures);
  const doc = useDocument();
  const unit = useLengthUnit();
  const part = flatPatternPart(parts, selected);
  const close = () => useStore.getState().openDialog(null);
  const drawn = useMemo(() => {
    if (!part?.flat) return null;
    const { prims, size } = flatPrims(part.flat);
    return { prims, size, svg: sheetSvg(prims, size, `${part.name} flat pattern`) };
  }, [part]);

  if (!part?.flat || !drawn) {
    const many = parts.filter((p) => p.flat).length > 1;
    return (
      <Modal title="Flat pattern" onClose={close}>
        <p>
          {many
            ? "Select the sheet metal part (in the Parts list) to see its flat pattern."
            : "There's no sheet metal part here yet. Make one with Sheet metal (from a closed sketch), then bend flanges off it."}
        </p>
      </Modal>
    );
  }
  const flat = part.flat;
  const { width, height } = flatSize(flat);
  const mm = (v: number) => showLength(String(Math.round(v * 100) / 100), unit);
  const base = safeFileName(`${doc.name} ${part.name} flat`, "flat pattern");
  const skipped = flat.notShown.map((id) => features.find((f) => f.id === id)?.name).filter(Boolean);

  return (
    <Modal
      title={`${part.name} — flat pattern`}
      onClose={close}
      width={720}
      footer={
        <>
          <button type="button" className="text-button" onClick={() => downloadFile(new Blob([drawn.svg], { type: "image/svg+xml" }), `${base}.svg`)}>
            Save SVG
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => downloadFile(new Blob([sheetDxf(drawn.prims)], { type: "application/dxf" }), `${base}.dxf`)}
            title="For laser cutters and CAD programs (millimetres): the outline on layer VISIBLE, bend lines on layer CENTRE"
          >
            Save DXF
          </button>
        </>
      }
    >
      <div className="flat-pattern-view">
        <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawn.svg)}`} alt={`Flat pattern of ${part.name}`} />
      </div>
      <p className="small">
        <strong>
          {mm(width)} × {mm(height)} {unit}
        </strong>{" "}
        flat, {mm(flat.thickness)} {unit} thick, {flat.bendLines.length} bend{flat.bendLines.length === 1 ? "" : "s"} (dashed: bend lines, inside radius {mm(flat.radius)} {unit},
        K-factor {flat.k}).
      </p>
      {skipped.length > 0 && (
        <p className="dialog-hint">
          Not shown yet: changes made to the part after it was a sheet ({skipped.join(", ")}). Draw holes and cut-outs in the sheet's sketch to have them in the
          flat pattern.
        </p>
      )}
    </Modal>
  );
}
