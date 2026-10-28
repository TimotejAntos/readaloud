// Turn a PDF into something we can read aloud.
//
// A PDF has no "words" or "sentences". It only has text pieces (items) drawn at
// x/y positions. So we rebuild the reading structure ourselves:
//
//   items  ->  words (with boxes on the page)  ->  paragraphs  ->  sentences
//
// Every word keeps its page boxes, so the reader can draw the highlight on the
// original page, and every sentence knows its first/last word, so the player
// can map audio timings back to words.
//
// This file does not load PDF.js itself (see pdf.js), so the same code also
// runs in Node for scripts.

export async function buildDocument(pdf, onProgress = () => {}) {
  const words = []; // { display, spoken, page, rects: [{ p, x, y, w, h }] }
  const paragraphs = []; // { page, first, last, heading }
  const pages = []; // { width, height, first, last, empty }

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const vp = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const firstWord = words.length;
    readPage(content.items, vp, p - 1, words, paragraphs);
    pages.push({ width: vp.width, height: vp.height, first: firstWord, last: words.length - 1, empty: words.length === firstWord });
    page.cleanup();
    onProgress(p, pdf.numPages);
  }

  const sentences = splitSentences(words, paragraphs);
  return { pages, words, paragraphs, sentences, numPages: pdf.numPages };
}

// ---- page -> words ------------------------------------------------------

function readPage(items, vp, pageIndex, words, paragraphs) {
  // 1. Place every text item on the page (top-left origin, PDF points).
  const placed = [];
  for (const it of items) {
    if (typeof it.str !== "string") continue; // marked-content markers
    const tx = transform(vp.transform, it.transform);
    const fontH = Math.hypot(tx[2], tx[3]) || it.height || 10;
    placed.push({ str: it.str, eol: it.hasEOL, x: tx[4], base: tx[5], h: fontH, w: it.width });
  }
  if (!placed.length) return;

  // 2. Stream the characters in reading order, inserting spaces, line breaks
  //    and paragraph breaks from the geometry.
  const chars = []; // { c, item }   item = null for inserted whitespace
  let prev = null;
  const lineHeights = [];
  for (const it of placed) {
    // Empty items only carry an "end of line" flag; their position is junk.
    if (!it.str) {
      if (it.eol && prev) prev = { ...prev, eol: true };
      continue;
    }
    if (prev) {
      const sameLine = Math.abs(it.base - prev.base) < Math.max(it.h, prev.h) * 0.5;
      if (!sameLine) {
        // A paragraph break is a line step clearly bigger than the normal one.
        // Learn the normal step only from ordinary line breaks.
        const gap = it.base - prev.base;
        const typical = lineHeights.length >= 2 ? median(lineHeights) : Math.max(it.h, prev.h) * 1.3;
        const newPara = gap > typical * 1.4 || gap < 0 || Math.abs(it.h - prev.h) > prev.h * 0.25;
        if (!newPara) lineHeights.push(gap);
        chars.push({ c: newPara ? " " : "\n", item: null });
      } else if (!prev.eol) {
        const gapX = it.x - (prev.x + prev.w);
        if (gapX > it.h * 0.15 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) chars.push({ c: " ", item: null });
      }
    }
    for (let i = 0; i < it.str.length; i++) chars.push({ c: it.str[i], item: it, i });
    prev = it;
  }

  // 3. Cut the stream into words; give each word its box(es) on the page.
  const firstWordOnPage = words.length;
  let paraStart = words.length;
  let paraHeight = 0;
  let cur = null;
  let brokeLine = false;
  const flushPara = () => {
    if (words.length > paraStart) {
      paragraphs.push({ page: pageIndex, first: paraStart, last: words.length - 1, heading: false, h: paraHeight });
    }
    paraStart = words.length;
    paraHeight = 0;
  };
  const flushWord = () => {
    if (!cur) return;
    const w = finishWord(cur, pageIndex);
    const last = words[words.length - 1];
    // Re-join words hyphenated at a line end: "inter-" + "national".
    if (brokeLine && last && words.length > paraStart && /\p{L}-$/u.test(last.display) && /^\p{Ll}/u.test(w.display)) {
      last.display = last.display.slice(0, -1) + w.display;
      last.spoken = last.display;
      last.rects.push(...w.rects);
    } else {
      words.push(w);
    }
    paraHeight = Math.max(paraHeight, cur.maxH);
    cur = null;
    brokeLine = false;
  };

  for (const ch of chars) {
    if (ch.c === " ") {
      flushWord();
      flushPara();
    } else if (/\s/.test(ch.c)) {
      flushWord();
      if (ch.c === "\n") brokeLine = true;
    } else {
      if (!cur) cur = { text: "", parts: new Map(), maxH: 0 };
      cur.text += ch.c;
      if (ch.item) {
        const part = cur.parts.get(ch.item) || { item: ch.item, from: ch.i, to: ch.i };
        part.to = ch.i;
        cur.parts.set(ch.item, part);
        cur.maxH = Math.max(cur.maxH, ch.item.h);
      }
    }
  }
  flushWord();
  flushPara();

  // Short paragraphs in a bigger font than most words are headings: read them
  // as their own sentence, show them bold in the text view.
  const bodyH = median(words.slice(firstWordOnPage).map((w) => w.h)) || 0;
  for (const para of paragraphs) {
    if (para.page !== pageIndex) continue;
    const n = para.last - para.first + 1;
    para.heading = n <= 14 && para.h > bodyH * 1.15 && !/[.,;]$/.test(words[para.last].display);
  }
}

function finishWord(cur, pageIndex) {
  const rects = [];
  for (const { item, from, to } of cur.parts.values()) {
    // Character boxes are not in the PDF; split the item width evenly.
    const per = item.str.length ? item.w / item.str.length : 0;
    rects.push({ p: pageIndex, x: item.x + per * from, y: item.base - item.h * 0.86, w: per * (to - from + 1), h: item.h * 1.12 });
  }
  return { display: cur.text, spoken: cur.text, page: pageIndex, rects, h: cur.maxH };
}

// ---- words -> sentences -------------------------------------------------

const segmenter = typeof Intl !== "undefined" && Intl.Segmenter ? new Intl.Segmenter("en", { granularity: "sentence" }) : null;

function splitSentences(words, paragraphs) {
  const sentences = [];
  for (const para of paragraphs) {
    // Sentence boundaries inside one paragraph, found on the joined text.
    const starts = [];
    let text = "";
    for (let i = para.first; i <= para.last; i++) {
      starts.push(text.length);
      text += (i > para.first ? " " : "") + words[i].spoken;
      if (i > para.first) starts[starts.length - 1] += 1;
    }
    const cuts = new Set();
    if (segmenter && !para.heading) {
      for (const seg of segmenter.segment(text)) if (seg.index > 0) cuts.add(seg.index);
    }
    let first = para.first;
    for (let i = para.first + 1; i <= para.last + 1; i++) {
      if (i <= para.last && !cuts.has(starts[i - para.first])) continue;
      pushSentence(sentences, words, first, i - 1);
      first = i;
    }
  }
  return sentences;
}

// Keep each spoken piece short: shorter audio comes back faster and the first
// word plays sooner. Prefer to cut after a comma or semicolon.
function pushSentence(out, words, first, last) {
  const MAX = 38;
  while (last - first + 1 > MAX) {
    let cut = -1;
    for (let i = first + MAX - 1; i >= first + 12; i--) {
      if (/[,;:—–)]$/.test(words[i].spoken)) {
        cut = i;
        break;
      }
    }
    if (cut < 0) cut = first + 30;
    out.push(makeSentence(words, first, cut));
    first = cut + 1;
  }
  out.push(makeSentence(words, first, last));
}

function makeSentence(words, first, last) {
  const parts = [];
  for (let i = first; i <= last; i++) parts.push(words[i].spoken);
  return { first, last, text: parts.join(" ") };
}

// Multiply two PDF matrices [a b c d e f] (same as pdfjsLib.Util.transform).
function transform(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

// The parsed document is saved once to Storage (docs/…json) so the next open,
// on any device, skips the slow PDF pass. Numbers are rounded to keep it small.
export function packDocument(doc) {
  const r = (n) => Math.round(n * 10) / 10;
  return {
    v: 1,
    numPages: doc.numPages,
    pages: doc.pages.map((p) => [r(p.width), r(p.height), p.first, p.last, p.empty ? 1 : 0]),
    paragraphs: doc.paragraphs.map((p) => [p.page, p.first, p.last, p.heading ? 1 : 0]),
    sentences: doc.sentences.map((s) => [s.first, s.last]),
    words: doc.words.map((w) => [w.display, w.spoken === w.display ? 0 : w.spoken, w.page, w.rects.map((b) => [b.p, r(b.x), r(b.y), r(b.w), r(b.h)])]),
  };
}

export function unpackDocument(packed) {
  if (packed?.v !== 1) throw new Error("unknown document format");
  const words = packed.words.map(([display, spoken, page, rects]) => ({
    display,
    spoken: spoken || display,
    page,
    rects: rects.map(([p, x, y, w, h]) => ({ p, x, y, w, h })),
  }));
  return {
    numPages: packed.numPages,
    pages: packed.pages.map(([width, height, first, last, empty]) => ({ width, height, first, last, empty: !!empty })),
    paragraphs: packed.paragraphs.map(([page, first, last, heading]) => ({ page, first, last, heading: !!heading })),
    sentences: packed.sentences.map(([first, last]) => ({ first, last, text: words.slice(first, last + 1).map((w) => w.spoken).join(" ") })),
    words,
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) / 2)];
}
