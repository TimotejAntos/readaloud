// PDF.js loader. Kept apart from document.js so that file stays plain logic.

import "./stream-polyfill.js"; // must load before PDF.js
import * as pdfjsLib from "/vendor/pdfjs/pdf.mjs";

pdfjsLib.GlobalWorkerOptions.workerSrc = "/js/pdf-worker.mjs";

// source = a URL, or the PDF bytes (ArrayBuffer / Uint8Array).
export async function openPdf(source) {
  const from = typeof source === "string" ? { url: source } : { data: source instanceof Uint8Array ? source : new Uint8Array(source) };
  return pdfjsLib.getDocument({
    ...from,
    cMapUrl: "/vendor/pdfjs-cmaps/",
    cMapPacked: true,
    standardFontDataUrl: "/vendor/pdfjs-fonts/",
  }).promise;
}
