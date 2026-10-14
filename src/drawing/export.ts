/**
 * Drawing files: SVG (opens in browsers and drawing programs) and PDF (for
 * printing and sending), both from the sheet's list of shapes, at true size
 * in millimetres.
 */
import { LINE_STYLES, type Prim } from "./sheet";

const n = (v: number) => String(Math.round(v * 1000) / 1000);
const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** An SVG file of the sheet, sized in millimetres. */
export function sheetSvg(prims: Prim[], size: [number, number], title = "PartSmith drawing"): string {
  const [W, H] = size;
  const body = prims.map((p) => {
    if (p.kind === "path") {
      const st = LINE_STYLES[p.style];
      const pts: string[] = [];
      for (let i = 0; i < p.points.length; i += 2) pts.push(`${n(p.points[i])},${n(H - p.points[i + 1])}`);
      const tag = p.closed ? "polygon" : "polyline";
      const dash = st.dash ? ` stroke-dasharray="${st.dash.join(" ")}"` : "";
      return `<${tag} points="${pts.join(" ")}" fill="${p.fill ? "#000" : "none"}" stroke="#000" stroke-width="${st.width}"${dash} stroke-linecap="round" stroke-linejoin="round"/>`;
    }
    const weight = p.bold ? ' font-weight="bold"' : "";
    const turn = p.rotate ? ` transform="rotate(${n(-p.rotate)} ${n(p.x)} ${n(H - p.y)})"` : "";
    return `<text x="${n(p.x)}" y="${n(H - p.y)}" font-size="${n(p.size)}" font-family="Helvetica, Arial, sans-serif" text-anchor="${p.anchor}"${weight}${turn}>${xml(p.text)}</text>`;
  });
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}mm" height="${H}mm" viewBox="0 0 ${W} ${H}">`,
    `<title>${xml(title)}</title>`,
    `<rect width="${W}" height="${H}" fill="#fff"/>`,
    ...body,
    `</svg>`,
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// PDF

const PT = 72 / 25.4;

/** Text as PDF bytes in WinAnsi (Latin-1-like) encoding, with brackets and backslashes escaped. */
function pdfString(s: string): string {
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const win = WIN_ANSI[ch];
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (code >= 32 && code < 127) out += ch;
    else if (win !== undefined) out += `\\${win.toString(8).padStart(3, "0")}`;
    else if (code >= 160 && code <= 255) out += `\\${code.toString(8).padStart(3, "0")}`;
    else out += "?";
  }
  return out;
}
const WIN_ANSI: Record<string, number> = { "€": 0x80, "–": 0x96, "—": 0x97, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95 };

/** Rough width of Helvetica text (for centring and right-aligning). */
export function textWidth(text: string, size: number): number {
  let w = 0;
  for (const ch of text) w += /[iljtfI.,:;'|!]/.test(ch) ? 0.28 : /[mwMW]/.test(ch) ? 0.85 : /[A-Z0-9]/.test(ch) ? 0.66 : 0.54;
  return w * size;
}

/** A one-page PDF file of the sheet. */
export function sheetPdf(prims: Prim[], size: [number, number], title = "PartSmith drawing"): Uint8Array {
  const [W, H] = size;
  const ops: string[] = ["1 J 1 j"];
  for (const p of prims) {
    if (p.kind === "path") {
      const st = LINE_STYLES[p.style];
      ops.push(`${n(st.width * PT)} w ${st.dash ? `[${st.dash.map((d) => n(d * PT)).join(" ")}] 0 d` : "[] 0 d"}`);
      const parts: string[] = [];
      for (let i = 0; i < p.points.length; i += 2) parts.push(`${n(p.points[i] * PT)} ${n(p.points[i + 1] * PT)} ${i === 0 ? "m" : "l"}`);
      ops.push(parts.join(" ") + (p.fill ? " b" : p.closed ? " s" : " S"));
    } else {
      const w = textWidth(p.text, p.size);
      const shift = p.anchor === "middle" ? -w / 2 : p.anchor === "end" ? -w : 0;
      const a = ((p.rotate ?? 0) * Math.PI) / 180;
      const c = Math.cos(a);
      const s = Math.sin(a);
      // Start of the text, moved back along its own direction to centre or right-align it.
      const x = p.x + shift * c;
      const y = p.y + shift * s;
      ops.push(`BT /${p.bold ? "F2" : "F1"} ${n(p.size * PT)} Tf ${n(c)} ${n(s)} ${n(-s)} ${n(c)} ${n(x * PT)} ${n(y * PT)} Tm (${pdfString(p.text)}) Tj ET`);
    }
  }
  const content = ops.join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(W * PT)} ${n(H * PT)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Title (${pdfString(title)}) /Producer (PartSmith) >>`,
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${objects.length} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  // Every character above is plain ASCII (other letters were escaped), so one byte each.
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}

// ---------------------------------------------------------------------------
// DXF (for CAD and laser/CNC programs)

/** An AutoCAD R12 DXF file of the sheet (millimetres): lines on layers VISIBLE, HIDDEN, CENTRE and THIN, and text. */
export function sheetDxf(prims: Prim[]): string {
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), typeof value === "number" ? n(value) : value);
  g(0, "SECTION"), g(2, "HEADER"), g(9, "$ACADVER"), g(1, "AC1009"), g(9, "$INSUNITS"), g(70, 4), g(0, "ENDSEC");
  g(0, "SECTION"), g(2, "TABLES");
  g(0, "TABLE"), g(2, "LTYPE"), g(70, 3);
  g(0, "LTYPE"), g(2, "CONTINUOUS"), g(70, 0), g(3, "Solid line"), g(72, 65), g(73, 0), g(40, 0);
  g(0, "LTYPE"), g(2, "DASHED"), g(70, 0), g(3, "Dashed __ __ __"), g(72, 65), g(73, 2), g(40, 4.5), g(49, 3), g(49, -1.5);
  g(0, "LTYPE"), g(2, "CENTER"), g(70, 0), g(3, "Center ____ _ ____ _"), g(72, 65), g(73, 4), g(40, 10), g(49, 6), g(49, -1.5), g(49, 1), g(49, -1.5);
  g(0, "ENDTAB");
  g(0, "TABLE"), g(2, "LAYER"), g(70, 5);
  for (const [name, ltype, colour] of [
    ["BORDER", "CONTINUOUS", 7],
    ["VISIBLE", "CONTINUOUS", 7],
    ["HIDDEN", "DASHED", 8],
    ["THIN", "CONTINUOUS", 3],
    ["CENTRE", "CENTER", 1],
  ] as const) {
    g(0, "LAYER"), g(2, name), g(70, 0), g(62, colour), g(6, ltype);
  }
  g(0, "ENDTAB"), g(0, "ENDSEC");
  g(0, "SECTION"), g(2, "ENTITIES");
  const layer = (style: string) => (style === "border" ? "BORDER" : style === "visible" ? "VISIBLE" : style === "hidden" ? "HIDDEN" : style === "centre" ? "CENTRE" : "THIN");
  for (const p of prims) {
    if (p.kind === "path") {
      const pts = p.points;
      const count = pts.length / 2;
      const segs = p.closed ? count : count - 1;
      for (let i = 0; i < segs; i++) {
        const j = (i + 1) % count;
        g(0, "LINE"), g(8, layer(p.style)), g(10, pts[2 * i]), g(20, pts[2 * i + 1]), g(30, 0), g(11, pts[2 * j]), g(21, pts[2 * j + 1]), g(31, 0);
      }
    } else {
      const align = p.anchor === "middle" ? 1 : p.anchor === "end" ? 2 : 0;
      g(0, "TEXT"), g(8, "THIN"), g(10, p.x), g(20, p.y), g(30, 0), g(40, p.size), g(1, p.text.replace(/Ø/g, "%%c").replace(/°/g, "%%d").replace(/±/g, "%%p"));
      if (p.rotate) g(50, p.rotate);
      if (align) {
        g(72, align), g(11, p.x), g(21, p.y), g(31, 0);
      }
    }
  }
  g(0, "ENDSEC"), g(0, "EOF");
  return out.join("\n") + "\n";
}
