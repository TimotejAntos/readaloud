// ReadAloud local server. No framework: Node's own http module.
//
//   /                      the web app (public/)
//   /vendor/pdfjs/*        PDF.js, served straight from node_modules
//   /api/library ...       upload, list, open, rename, delete PDFs
//   /api/tts               text -> { audioData, audioFormat, speechMarks }
//   /api/voices, /api/status

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrary } from "./library.js";
import * as tts from "./tts.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT) || 5520;
// READALOUD_DATA lets tests use a throwaway folder instead of the real library.
const DATA = process.env.READALOUD_DATA ? path.resolve(process.env.READALOUD_DATA) : path.join(ROOT, "data");
const library = createLibrary(DATA);
tts.setCacheDir(path.join(DATA, "audio-cache"));

const STATIC = [
  { prefix: "/vendor/pdfjs/", dir: path.join(ROOT, "node_modules", "pdfjs-dist", "legacy", "build") }, // legacy build: has the polyfills Safari needs
  { prefix: "/vendor/pdfjs-fonts/", dir: path.join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts") },
  { prefix: "/vendor/pdfjs-cmaps/", dir: path.join(ROOT, "node_modules", "pdfjs-dist", "cmaps") },
  { prefix: "/vendor/supabase/", dir: path.join(ROOT, "node_modules", "@supabase", "supabase-js", "dist", "umd") },
  { prefix: "/", dir: path.join(ROOT, "public") },
];
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".pdf": "application/pdf",
  ".bcmap": "application/octet-stream",
  ".pfb": "application/octet-stream",
  ".ttf": "font/ttf",
};

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store" });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

function readBody(req, limit = 200 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("File is too big."));
        req.destroy();
      } else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });
}

async function serveFile(res, file) {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) return false;
  res.writeHead(200, {
    "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream",
    "content-length": info.size,
    "cache-control": "no-cache",
  });
  createReadStream(file).pipe(res);
  return true;
}

async function api(req, res, url) {
  const parts = url.pathname.split("/").filter(Boolean); // ["api", ...]

  if (parts[1] === "status") return send(res, 200, tts.status());
  if (parts[1] === "voices") return send(res, 200, tts.VOICES);

  if (parts[1] === "tts" && req.method === "POST") {
    const { text, voice } = JSON.parse((await readBody(req, 1e6)).toString("utf8"));
    // If the browser gives up on this request (the reader jumped elsewhere),
    // skip it instead of generating audio nobody will hear.
    let gone = false;
    res.on("close", () => (gone = !res.writableFinished));
    const out = await tts.synthesize(String(text || ""), String(voice || ""), { isCancelled: () => gone });
    if (!out) return gone ? undefined : send(res, 500, { error: "cancelled" });
    return send(res, 200, out);
  }

  if (parts[1] === "library") {
    const id = parts[2];
    if (!id && req.method === "GET") return send(res, 200, await library.list());
    if (!id && req.method === "POST") {
      const name = decodeURIComponent(req.headers["x-file-name"] || "document.pdf");
      const item = await library.add(name, await readBody(req));
      return send(res, 201, item);
    }
    if (id && parts[3] === "file" && req.method === "GET") {
      if (await serveFile(res, library.filePath(id))) return;
      return send(res, 404, { error: "not found" });
    }
    if (id && req.method === "PATCH") {
      const item = await library.update(id, JSON.parse((await readBody(req, 1e6)).toString("utf8")));
      return item ? send(res, 200, item) : send(res, 404, { error: "not found" });
    }
    if (id && req.method === "DELETE") {
      return (await library.remove(id)) ? send(res, 200, { ok: true }) : send(res, 404, { error: "not found" });
    }
  }
  return send(res, 404, { error: "unknown api route" });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);

    for (const { prefix, dir } of STATIC) {
      if (!url.pathname.startsWith(prefix)) continue;
      let rel = decodeURIComponent(url.pathname.slice(prefix.length)) || "index.html";
      const file = path.join(dir, rel);
      if (!file.startsWith(dir)) break; // no ../ escapes
      if (await serveFile(res, file)) return;
    }
    send(res, 404, "Not found", "text/plain");
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`ReadAloud running at http://localhost:${PORT}`);
  // Start loading the voice now so the first Play is quick.
  tts.loadModel().catch(() => {});
  // Cloud PC voice for the phone app. Same Kokoro model and queue as /api/tts.
  // Stays off (local mode only) until pc-worker/.env has a key.
  if (process.env.READALOUD_NO_WORKER !== "1") {
    import("../pc-worker/worker.js").then((w) => w.startWorker({ quietIfNoKey: true })).catch((err) => console.error("[pc-worker] could not start:", err.message));
  }
});
