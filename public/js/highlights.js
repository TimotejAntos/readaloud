// Highlights: what you marked, in which color, and where it sits in the book.
//
// A highlight is a word range (start_word..end_word) in the parsed document,
// so "Open here" can land on the exact word. It also keeps:
//   - text + a few words before/after, to find its place again if a book is
//     ever parsed anew (then the word numbers may shift),
//   - the human path: chapter › page › paragraph, saved when it was made.
//
// Two stores with one interface: the local server (PC-only mode) and
// Supabase (cloud mode, synced live between devices).

import * as cloud from "./cloud.js";

export const DEFAULT_PALETTE = [
  { id: "yellow", hex: "#f5c518", label: "Key idea" },
  { id: "orange", hex: "#ff9f43", label: "Try this" },
  { id: "red", hex: "#ff6b6b", label: "I disagree" },
  { id: "pink", hex: "#f472b6", label: "Question" },
  { id: "purple", hex: "#a78bfa", label: "Don't get it" },
  { id: "blue", hex: "#60a5fa", label: "Love this" },
  { id: "teal", hex: "#2dd4bf", label: "Quote to share" },
  { id: "green", hex: "#84cc16", label: "Action step" },
];
export const MAX_CUSTOM = 8;
const CONTEXT_WORDS = 8;

// A meaning is 1 to 3 words, at most 24 characters.
export function checkLabel(raw) {
  const value = String(raw || "").replace(/\s+/g, " ").trim();
  const words = value ? value.split(" ").length : 0;
  if (!words) return { ok: false, value, error: "Give it a meaning (1–3 words)." };
  if (words > 3) return { ok: false, value, error: "Keep it to 3 words or fewer." };
  if (value.length > 24) return { ok: false, value, error: "Keep it under 24 letters." };
  return { ok: true, value };
}

export function colorOf(palette, id) {
  return palette.find((c) => c.id === id) || { id, hex: /^#[0-9a-f]{6}$/i.test(id) ? id : "#f5c518", label: "Custom" };
}

export function slug(label) {
  return label.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

// ---------------------------------------------------------------- store

export function createHighlightStore(mode) {
  const rows = new Map(); // id -> row
  const listeners = new Set();
  let palette = loadCachedPalette();
  let loaded = false;

  const api =
    mode === "cloud"
      ? {
          list: () => cloud.listHighlights(),
          add: (row) => cloud.addHighlight(row),
          update: (id, patch) => cloud.updateHighlight(id, patch),
          remove: (id) => cloud.removeHighlight(id),
          getPalette: () => cloud.getPalette(),
          savePalette: (p) => cloud.savePalette(p),
        }
      : {
          list: () => json("/api/highlights"),
          add: (row) => json("/api/highlights", "POST", row),
          update: (id, patch) => json(`/api/highlights/${id}`, "PATCH", patch),
          remove: (id) => json(`/api/highlights/${id}`, "DELETE"),
          getPalette: async () => {
            const p = await json("/api/highlight-palette");
            return p?.length ? p : null;
          },
          savePalette: (p) => json("/api/highlight-palette", "PUT", p),
        };

  const changed = (detail) => listeners.forEach((fn) => fn(detail));

  if (mode === "cloud") {
    // Another device added, changed or removed a highlight.
    cloud.on("highlight", (ev) => {
      if (ev.type === "delete") {
        if (rows.delete(ev.id)) changed({ type: "delete", id: ev.id });
      } else {
        rows.set(ev.row.id, ev.row);
        changed({ type: "upsert", row: ev.row });
      }
    });
    cloud.on("palette", (p) => {
      palette = p;
      cachePalette(p);
      changed({ type: "palette" });
    });
  }

  return {
    get palette() {
      return palette;
    },
    on(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    async load() {
      const [list, saved] = await Promise.all([api.list(), api.getPalette().catch(() => null)]);
      rows.clear();
      for (const r of list) rows.set(r.id, r);
      if (saved) {
        palette = saved;
        cachePalette(saved);
      }
      loaded = true;
      changed({ type: "load" });
    },
    get loaded() {
      return loaded;
    },
    all: () => [...rows.values()],
    forDocument: (id) => [...rows.values()].filter((r) => r.document_id === id).sort((a, b) => a.start_word - b.start_word),
    async add(row) {
      const saved = await api.add(row);
      rows.set(saved.id, saved);
      changed({ type: "upsert", row: saved });
      return saved;
    },
    async update(id, patch) {
      const saved = await api.update(id, patch);
      rows.set(saved.id, saved);
      changed({ type: "upsert", row: saved });
      return saved;
    },
    async remove(id) {
      await api.remove(id);
      rows.delete(id);
      changed({ type: "delete", id });
    },
    async savePalette(p) {
      await api.savePalette(p);
      palette = p;
      cachePalette(p);
      changed({ type: "palette" });
    },
  };
}

async function json(url, method = "GET", body) {
  const r = await fetch(url, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}

function loadCachedPalette() {
  try {
    const p = JSON.parse(localStorage.getItem("readaloud.palette") || "null");
    if (Array.isArray(p) && p.length) return p;
  } catch {}
  return DEFAULT_PALETTE;
}
function cachePalette(p) {
  try {
    localStorage.setItem("readaloud.palette", JSON.stringify(p));
  } catch {}
}

// ---------------------------------------------------------------- the path

// Chapters from the PDF's own table of contents (bookmarks). Books without
// one fall back to the headings the parser found. -> [{ title, first }]
export async function buildChapters(pdf, doc) {
  const out = [];
  try {
    const outline = await pdf.getOutline();
    const walk = async (items, depth, parent) => {
      for (const it of items || []) {
        const page = await destPage(pdf, it.dest);
        const title = (it.title || "").replace(/\s+/g, " ").trim();
        if (page != null && title) {
          const first = firstWordFrom(doc, page);
          if (first != null) out.push({ title: depth > 0 && parent ? `${parent} › ${title}` : title, first, depth });
        }
        if (depth < 1 && it.items?.length) await walk(it.items, depth + 1, title);
      }
    };
    await walk(outline, 0, "");
  } catch {}
  if (out.length < 2) {
    out.length = 0;
    for (const p of doc.paragraphs) {
      if (!p.heading) continue;
      const title = doc.words.slice(p.first, p.last + 1).map((w) => w.display).join(" ");
      out.push({ title: title.length > 80 ? `${title.slice(0, 77)}…` : title, first: p.first, depth: 0 });
    }
  }
  return out.sort((a, b) => a.first - b.first);
}

async function destPage(pdf, dest) {
  try {
    const d = typeof dest === "string" ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(d) || !d[0]) return null;
    return typeof d[0] === "number" ? d[0] : await pdf.getPageIndex(d[0]);
  } catch {
    return null;
  }
}

function firstWordFrom(doc, pageIndex) {
  for (let p = pageIndex; p < doc.pages.length; p++) if (!doc.pages[p].empty) return doc.pages[p].first;
  return null;
}

export function chapterAt(chapters, word) {
  let found = "";
  for (const c of chapters) {
    if (c.first <= word) found = c.title;
    else break;
  }
  return found;
}

// Everything a new highlight needs to know about where it is.
export function describeRange(doc, chapters, start, end) {
  const words = doc.words;
  const take = (a, b) => words.slice(Math.max(0, a), Math.max(0, b)).map((w) => w.display).join(" ");
  const page = words[start].page;
  const onPage = doc.paragraphs.filter((p) => p.page === page);
  const paragraph = onPage.findIndex((p) => p.first <= start && start <= p.last) + 1 || null;
  return {
    start_word: start,
    end_word: end,
    text: take(start, end + 1),
    prefix: take(start - CONTEXT_WORDS, start),
    suffix: take(end + 1, end + 1 + CONTEXT_WORDS),
    chapter: chapterAt(chapters, start),
    page: page + 1,
    paragraph,
  };
}

// Is the highlight still on the same words? If the book was parsed anew and
// the words moved, find the text again (closest match to the old place).
export function anchor(doc, h) {
  const want = h.text.split(" ");
  const fits = (s) => want.every((t, k) => doc.words[s + k]?.display === t);
  if (h.start_word < doc.words.length && fits(h.start_word)) return { start: h.start_word, end: h.start_word + want.length - 1 };
  let best = -1;
  for (let s = 0; s + want.length <= doc.words.length; s++) {
    if (doc.words[s].display === want[0] && fits(s) && (best < 0 || Math.abs(s - h.start_word) < Math.abs(best - h.start_word))) best = s;
  }
  return best < 0 ? null : { start: best, end: best + want.length - 1 };
}

export function pathText(h) {
  return [h.chapter, h.page ? `p. ${h.page}` : "", h.paragraph ? `¶ ${h.paragraph}` : ""].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------- export

export function toMarkdown(rows, titleOf, palette, linkOf) {
  const byDoc = new Map();
  for (const h of rows) {
    if (!byDoc.has(h.document_id)) byDoc.set(h.document_id, []);
    byDoc.get(h.document_id).push(h);
  }
  const out = ["# My highlights", "", `Exported from ReadAloud on ${new Date().toLocaleDateString()}.`, ""];
  for (const [docId, list] of byDoc) {
    out.push(`## ${titleOf(docId)}`, "");
    let chapter = null;
    for (const h of list.sort((a, b) => a.start_word - b.start_word)) {
      if (h.chapter !== chapter) {
        chapter = h.chapter;
        if (chapter) out.push(`### ${chapter}`, "");
      }
      const c = colorOf(palette, h.color);
      out.push(`> ${h.text}`, "");
      const where = [h.page ? `p. ${h.page}` : "", h.paragraph ? `¶ ${h.paragraph}` : ""].filter(Boolean).join(", ");
      out.push(`— ${where} · #${slug(c.label) || "highlight"} · [open](${linkOf(h)})`, "");
      if (h.note) out.push(`**Note:** ${h.note}`, "");
    }
  }
  return out.join("\n");
}
