// The library: PDFs live as plain files on disk, next to one index file.
//
//   data/library/index.json      list of documents + reading position
//   data/library/<id>.pdf        the uploaded file
//   data/trash/<id>.pdf          "deleted" files (kept, so nothing is lost)
//
// Plain files keep the MVP fully offline. Supabase sync can be added later by
// swapping this module for one that talks to Supabase Storage + a table.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export function createLibrary(dataDir) {
  const libDir = path.join(dataDir, "library");
  const trashDir = path.join(dataDir, "trash");
  const indexFile = path.join(libDir, "index.json");

  async function readIndex() {
    try {
      return JSON.parse(await readFile(indexFile, "utf8"));
    } catch {
      return [];
    }
  }

  // Write to a temp file first, then rename: a crash mid-write never leaves a
  // half-written index behind.
  async function writeIndex(items) {
    await mkdir(libDir, { recursive: true });
    const tmp = `${indexFile}.tmp`;
    await writeFile(tmp, JSON.stringify(items, null, 2));
    await rename(tmp, indexFile);
  }

  return {
    async list() {
      return (await readIndex()).sort((a, b) => (b.openedAt || b.addedAt).localeCompare(a.openedAt || a.addedAt));
    },

    async add(fileName, bytes) {
      if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new Error("That file is not a PDF.");
      await mkdir(libDir, { recursive: true });
      const id = randomUUID();
      await writeFile(path.join(libDir, `${id}.pdf`), bytes);
      const item = {
        id,
        title: fileName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled",
        fileName,
        bytes: bytes.length,
        addedAt: new Date().toISOString(),
        openedAt: null,
        pages: null,
        words: null,
        position: { word: 0 },
      };
      const items = await readIndex();
      items.push(item);
      await writeIndex(items);
      return item;
    },

    filePath(id) {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("bad id");
      return path.join(libDir, `${id}.pdf`);
    },

    async update(id, patch) {
      const items = await readIndex();
      const item = items.find((i) => i.id === id);
      if (!item) return null;
      for (const k of ["title", "position", "pages", "words", "openedAt"]) if (k in patch) item[k] = patch[k];
      await writeIndex(items);
      return item;
    },

    async remove(id) {
      const items = await readIndex();
      const keep = items.filter((i) => i.id !== id);
      if (keep.length === items.length) return false;
      await mkdir(trashDir, { recursive: true });
      await rename(this.filePath(id), path.join(trashDir, `${id}.pdf`)).catch(() => {});
      await writeIndex(keep);
      return true;
    },
  };
}
