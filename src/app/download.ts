/** Save bytes as a file via the browser's normal download. */
export function downloadFile(data: ArrayBuffer | Blob, filename: string, type = "application/octet-stream"): void {
  const blob = data instanceof Blob ? data : new Blob([data], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Make a name safe to use as a file name on Windows and macOS. */
export function safeFileName(name: string, fallback = "partsmith"): string {
  const cleaned = name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return cleaned || fallback;
}
