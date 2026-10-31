// The tutor's book side (docs/TUTOR.md): cut a parsed book into pieces for
// search, and turn an answer with citations into HTML with [1] [2] marks.
// No DOM or network here, so the same code runs in Node for tests.

import { chapterAt } from "./highlights.js";

const TARGET = 200; // words: close a piece at the next paragraph end after this
const MAX = 280; // words: close at the next sentence end after this (gte-small reads ~350 words)
const MIN_CHAPTER = 40; // words: a new chapter starts a new piece unless this one is tiny

// Pieces follow the book's sentences and paragraphs, so a piece never stops
// mid-sentence, and every piece knows its exact word range, page and chapter.
export function chunkDocument(doc, chapters = []) {
  const paraEnd = new Set(doc.paragraphs.map((p) => p.last));
  const out = [];
  let first = -1;
  let last = -1;
  const close = () => {
    if (first < 0) return;
    const words = doc.words.slice(first, last + 1);
    const text = words.map((w) => w.display).join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      out.push({
        chunk_no: out.length,
        start_word: first,
        end_word: last,
        page: words[0].page + 1,
        page_end: words[words.length - 1].page + 1,
        chapter: chapterAt(chapters, first),
        text,
      });
    }
    first = -1;
  };
  for (const s of doc.sentences) {
    if (first >= 0 && last - first + 1 >= MIN_CHAPTER && chapterAt(chapters, s.first) !== chapterAt(chapters, first)) close();
    if (first < 0) first = s.first;
    last = s.last;
    const size = last - first + 1;
    if ((size >= TARGET && paraEnd.has(last)) || size >= MAX) close();
  }
  close();
  return out;
}

// ---- answers -----------------------------------------------------------

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// parts = [{ text, cites: [n] }]. Marks go right after the words they back up.
// A long part with no source gets a dotted underline: the tutor said it, but
// no passage was tied to it (lock 3).
export function answerHtml(parts) {
  const MARK = (n) => `\u0001${n}\u0002`;
  let raw = "";
  for (const p of parts || []) {
    const t = p.text || "";
    const unsourced = !p.cites?.length && t.trim().length > 140 && !t.includes("\n") && !/^\s*check yourself/i.test(t);
    raw += (unsourced ? `\u0003${t}\u0004` : t) + (p.cites || []).map(MARK).join("");
  }
  return markdownLite(raw);
}

export function markdownLite(raw) {
  const inline = (s) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*(?!\s)(.+?)\*(?=[\s).,;:!?]|$)/g, "$1<em>$2</em>")
      .replace(/\u0003/g, '<span class="unsourced" title="No source in your book for this part">')
      .replace(/\u0004/g, "</span>")
      .replace(/\u0001(\d+)\u0002/g, '<button class="cite" data-n="$1" aria-label="Source $1">$1</button>');
  const blocks = raw.trim().split(/\n{2,}/);
  return blocks
    .map((b) => {
      const lines = b.split("\n");
      if (lines.every((l) => /^\s*\d+[.)]\s/.test(l))) return `<ol>${lines.map((l) => `<li>${inline(l.replace(/^\s*\d+[.)]\s/, ""))}</li>`).join("")}</ol>`;
      if (lines.every((l) => /^\s*[-•*]\s/.test(l))) return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-•*]\s/, ""))}</li>`).join("")}</ul>`;
      if (/^#{1,4}\s/.test(b)) return `<p class="h">${inline(b.replace(/^#{1,4}\s/, ""))}</p>`;
      if (/^\s*check yourself:?/i.test(b)) return `<p class="check">${inline(b)}</p>`;
      return `<p>${lines.map(inline).join("<br>")}</p>`;
    })
    .join("");
}

export function sourcePath(s) {
  const page = s.page ? `p. ${s.page}${s.page_end && s.page_end !== s.page ? `–${s.page_end}` : ""}` : "";
  return [s.title, s.chapter, page].filter(Boolean).join(" › ");
}
