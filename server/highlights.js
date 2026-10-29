// Highlights for the local (PC-only) mode. Same row shape as the Supabase
// table ra_highlights, so the app treats both the same way.
//
//   data/highlights.json          [ { id, document_id, start_word, end_word, ... } ]
//   data/highlight-palette.json   [ { id, hex, label } ]  (colors + meanings)

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const FIELDS = ["document_id", "start_word", "end_word", "text", "prefix", "suffix", "color", "note", "chapter", "page", "paragraph"];
const EDITABLE = ["color", "note", "start_word", "end_word", "text", "prefix", "suffix", "chapter", "page", "paragraph"];

export function createHighlights(dataDir) {
  const file = path.join(dataDir, "highlights.json");
  const paletteFile = path.join(dataDir, "highlight-palette.json");

  async function read(f, fallback) {
    try {
      return JSON.parse(await readFile(f, "utf8"));
    } catch {
      return fallback;
    }
  }
  async function write(f, value) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(`${f}.tmp`, JSON.stringify(value, null, 2));
    await rename(`${f}.tmp`, f);
  }

  return {
    async list(documentId) {
      const all = await read(file, []);
      return documentId ? all.filter((h) => h.document_id === documentId) : all;
    },
    async add(body) {
      const all = await read(file, []);
      const now = new Date().toISOString();
      const row = { id: randomUUID(), created_at: now, updated_at: now };
      for (const k of FIELDS) if (k in body) row[k] = body[k];
      if (!row.document_id || !Number.isInteger(row.start_word) || !Number.isInteger(row.end_word) || row.end_word < row.start_word) {
        throw new Error("bad highlight");
      }
      all.push(row);
      await write(file, all);
      return row;
    },
    async update(id, patch) {
      const all = await read(file, []);
      const row = all.find((h) => h.id === id);
      if (!row) return null;
      for (const k of EDITABLE) if (k in patch) row[k] = patch[k];
      row.updated_at = new Date().toISOString();
      await write(file, all);
      return row;
    },
    async remove(id) {
      const all = await read(file, []);
      const keep = all.filter((h) => h.id !== id);
      if (keep.length === all.length) return false;
      await write(file, keep);
      return true;
    },
    // A deleted book takes its highlights with it (like ON DELETE CASCADE).
    async removeForDocument(documentId) {
      const all = await read(file, []);
      await write(file, all.filter((h) => h.document_id !== documentId));
    },
    getPalette: () => read(paletteFile, null),
    savePalette: (palette) => write(paletteFile, palette),
  };
}
