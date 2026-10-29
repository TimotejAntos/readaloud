// Two ways to look at the same document, both with live highlights:
//
//   Original view - the real PDF pages, with highlight boxes drawn on top.
//   Text view     - clean reflowed text you can restyle (font, size, theme).
//
// Each page is a stack of layers, bottom to top:
//   1. text (the PDF picture, or the word spans)
//   2. saved highlights - your colors
//   3. reading sentence - soft band on the sentence the voice is on
//   4. spoken word      - a thick underline, so your colors stay visible
//   5. selection        - blue while you pick words to highlight

export class Reader {
  constructor({ scroller, pdf, doc, onWordClick, onUserScroll, onSelect, onHighlightTap }) {
    this.scroller = scroller;
    this.pdf = pdf;
    this.doc = doc;
    this.onWordClick = onWordClick;
    this.onUserScroll = onUserScroll;
    this.onSelect = onSelect || (() => {});
    this.onHighlightTap = onHighlightTap || (() => {});
    this.view = "original";
    this.word = -1;
    this.sentence = -1;
    this.highlight = "both"; // both | word | sentence | off
    this.saved = []; // [{ id, start, end, hex }]
    this.palette = [];
    this.selection = null; // { start, end }

    // Only scrolling done by a person turns autoscroll off.
    for (const ev of ["wheel", "touchmove", "mousedown"]) {
      scroller.addEventListener(ev, (e) => {
        if (ev === "mousedown" && e.target !== scroller) return; // scrollbar drags only
        this.onUserScroll();
      }, { passive: true });
    }

    // Text view: the browser's own selection (drag, or press-and-hold on a phone).
    this.onSelectionChange = () => {
      clearTimeout(this.selTimer);
      this.selTimer = setTimeout(() => this.readNativeSelection(), 280);
    };
    document.addEventListener("selectionchange", this.onSelectionChange);
  }

  dispose() {
    document.removeEventListener("selectionchange", this.onSelectionChange);
    this.observer?.disconnect();
  }

  setView(view) {
    this.view = view;
    this.selection = null;
    this.scroller.innerHTML = "";
    this.scroller.dataset.view = view;
    if (view === "text") this.buildText();
    else this.buildOriginal();
    this.paintSaved();
    this.paint(true);
  }

  // ---- text view ----

  buildText() {
    const { words, paragraphs } = this.doc;
    const col = el("article", "text-col");
    this.wordEls = new Array(words.length);
    this.spaceEls = new Array(words.length); // space after word i
    let lastPage = -1;
    const frag = document.createDocumentFragment();
    for (const para of paragraphs) {
      if (para.page !== lastPage) {
        lastPage = para.page;
        frag.append(el("div", "page-mark", `Page ${para.page + 1}`));
      }
      const p = el(para.heading ? "h2" : "p", "para");
      for (let i = para.first; i <= para.last; i++) {
        const span = el("span", "w", words[i].display);
        span.dataset.i = i;
        this.wordEls[i] = span;
        p.append(span);
        if (i < para.last) {
          const sp = el("span", "sp", " ");
          sp.dataset.s = i;
          this.spaceEls[i] = sp;
          p.append(sp);
        } else p.append(" ");
      }
      frag.append(p);
    }
    if (!paragraphs.length) frag.append(el("p", "empty-note", "This PDF has no selectable text. It is probably a scan. Scans need OCR, which is not in this MVP yet."));
    col.append(frag);
    col.addEventListener("click", (e) => {
      if (!window.getSelection()?.isCollapsed) return; // the end of a drag-select, not a tap
      const i = e.target?.dataset?.i;
      if (i == null) return;
      const h = this.highlightAt(Number(i));
      if (h) this.onHighlightTap(h.id, Number(i));
      else this.onWordClick(Number(i));
    });
    this.scroller.append(col);
  }

  readNativeSelection() {
    if (this.view !== "text") return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!this.scroller.contains(range.commonAncestorContainer)) return;
    const start = this.edgeWord(range.startContainer, "start");
    const end = this.edgeWord(range.endContainer, "end");
    if (start == null || end == null || end < start) return;
    this.setSelection(start, end, false);
    this.onSelect(start, end);
  }

  // Which word does a selection edge sit in?
  edgeWord(node, side) {
    const n = node.nodeType === 3 ? node.parentElement : node;
    const w = n?.closest?.(".w");
    if (w) return Number(w.dataset.i);
    const sp = n?.closest?.(".sp");
    if (sp) return Number(sp.dataset.s) + (side === "start" ? 1 : 0);
    // Edge on a paragraph or page mark: take the nearest word inside it.
    const words = n?.querySelectorAll?.(".w");
    if (words?.length) return Number((side === "start" ? words[0] : words[words.length - 1]).dataset.i);
    return null;
  }

  // ---- original view ----

  buildOriginal() {
    const wrap = el("div", "pages");
    this.pageEls = [];
    const avail = Math.min(this.scroller.clientWidth - 32, 980);
    this.doc.pages.forEach((pg, idx) => {
      const scale = avail / pg.width;
      const box = el("div", "page");
      box.style.width = `${pg.width * scale}px`;
      box.style.height = `${pg.height * scale}px`;
      box.dataset.page = idx;
      const canvas = document.createElement("canvas");
      const savedLayer = el("div", "hl-layer saved-layer");
      const hl = el("div", "hl-layer");
      box.append(canvas, savedLayer, hl);
      if (pg.empty) box.append(el("div", "page-note", "No text on this page (scan)"));
      wrap.append(box);
      this.pageEls.push({ box, canvas, hl, savedLayer, scale, rendered: false });
      this.wirePage(box, idx);
    });
    this.scroller.append(wrap);

    // Draw pages only when they come near the screen.
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.renderPage(Number(en.target.dataset.page));
    }, { root: this.scroller, rootMargin: "800px 0px" });
    for (const pe of this.pageEls) this.observer.observe(pe.box);
  }

  // Tap = jump there. Mouse drag = select words. Press and hold (phone) =
  // select the sentence; the highlight menu can then grow or shrink it.
  wirePage(box, idx) {
    let down = null;
    let holdTimer = null;
    box.addEventListener("pointerdown", (e) => {
      const w = this.wordAt(idx, e.clientX, e.clientY);
      down = { x: e.clientX, y: e.clientY, w, dragging: false, held: false, mouse: e.pointerType === "mouse" };
      if (!down.mouse && w >= 0) {
        holdTimer = setTimeout(() => {
          if (!down) return;
          down.held = true;
          const s = this.doc.sentences[sentenceOf(this.doc, w)];
          this.setSelection(s.first, s.last);
          this.onSelect(s.first, s.last);
        }, 450);
      }
    });
    box.addEventListener("pointermove", (e) => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (!down.mouse) {
        if (moved > 10) {
          clearTimeout(holdTimer);
          down.moved = true; // a scroll, not a tap
        }
        return;
      }
      if (e.buttons !== 1 || down.w < 0) return;
      if (moved > 6) down.dragging = true;
      if (!down.dragging) return;
      const w = this.wordAt(idx, e.clientX, e.clientY);
      if (w >= 0) this.setSelection(Math.min(down.w, w), Math.max(down.w, w));
    });
    const up = () => {
      clearTimeout(holdTimer);
      if (!down) return;
      const d = down;
      down = null;
      if (d.dragging && this.selection) return this.onSelect(this.selection.start, this.selection.end);
      if (d.held || d.moved || d.w < 0) return;
      const h = this.highlightAt(d.w);
      if (h) this.onHighlightTap(h.id, d.w);
      else this.onWordClick(d.w);
    };
    box.addEventListener("pointerup", up);
    box.addEventListener("pointercancel", () => {
      clearTimeout(holdTimer);
      down = null;
    });
    box.addEventListener("contextmenu", (e) => e.preventDefault()); // no "Save image" menu on press-and-hold
  }

  async renderPage(idx) {
    const pe = this.pageEls[idx];
    if (pe.rendered) return;
    pe.rendered = true;
    const page = await this.pdf.getPage(idx + 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const vp = page.getViewport({ scale: pe.scale * dpr });
    pe.canvas.width = vp.width;
    pe.canvas.height = vp.height;
    pe.canvas.style.width = "100%";
    pe.canvas.style.height = "100%";
    await page.render({ canvasContext: pe.canvas.getContext("2d"), viewport: vp }).promise;
  }

  wordAt(idx, clientX, clientY) {
    const pe = this.pageEls[idx];
    const r = pe.box.getBoundingClientRect();
    const x = (clientX - r.left) / pe.scale;
    const y = (clientY - r.top) / pe.scale;
    const pg = this.doc.pages[idx];
    let best = -1;
    let bestD = Infinity;
    for (let i = pg.first; i <= pg.last; i++) {
      for (const b of this.doc.words[i].rects) {
        if (b.p !== idx) continue;
        const dx = Math.max(b.x - x, 0, x - (b.x + b.w));
        const dy = Math.max(b.y - y, 0, y - (b.y + b.h));
        const d = dx * dx + dy * dy * 4;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
    }
    return best >= 0 && bestD < 400 ? best : -1;
  }

  // ---- layer 2: saved highlights ----

  setHighlights(list) {
    this.saved = list;
    this.paintSaved();
  }

  highlightAt(word) {
    // The newest one wins where two overlap.
    for (let k = this.saved.length - 1; k >= 0; k--) {
      const h = this.saved[k];
      if (h.start <= word && word <= h.end) return h;
    }
    return null;
  }

  paintSaved() {
    if (this.view === "text") {
      if (!this.wordEls) return;
      for (const i of this.paintedWords || []) {
        const w = this.wordEls[i];
        if (w) {
          w.classList.remove("hl");
          w.style.removeProperty("--hlc");
        }
        const sp = this.spaceEls[i];
        if (sp) {
          sp.classList.remove("hl");
          sp.style.removeProperty("--hlc");
        }
      }
      this.paintedWords = [];
      for (const h of this.saved) {
        for (let i = h.start; i <= h.end; i++) {
          const w = this.wordEls[i];
          if (!w) continue;
          w.classList.add("hl");
          w.style.setProperty("--hlc", h.hex);
          if (i < h.end && this.spaceEls[i]) {
            this.spaceEls[i].classList.add("hl");
            this.spaceEls[i].style.setProperty("--hlc", h.hex);
          }
          this.paintedWords.push(i);
        }
      }
    } else {
      if (!this.pageEls) return;
      for (const pe of this.pageEls) pe.savedLayer.replaceChildren();
      for (const h of this.saved) {
        for (const b of mergeLines(this.doc.words, h.start, h.end)) {
          const n = this.addBox(b, "hl-saved", false, "savedLayer");
          if (n) n.style.setProperty("--hlc", h.hex);
        }
      }
    }
  }

  // ---- layer 5: selection ----

  setSelection(start, end, mirrorNative = true) {
    this.clearSelectionMarks();
    this.selection = { start, end };
    if (this.view === "text") {
      // The browser shows its own selection while you drag; we only mark
      // the words when the range was set by code (the grow/shrink buttons).
      if (!mirrorNative) return;
      window.getSelection()?.removeAllRanges();
      for (let i = start; i <= end; i++) {
        this.wordEls[i]?.classList.add("sel");
        if (i < end) this.spaceEls[i]?.classList.add("sel");
      }
    } else {
      for (const b of mergeLines(this.doc.words, start, end)) this.addBox(b, "hl-sel");
    }
  }

  clearSelection() {
    this.clearSelectionMarks();
    this.selection = null;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && this.scroller.contains(sel.anchorNode)) sel.removeAllRanges();
  }

  clearSelectionMarks() {
    this.scroller.querySelectorAll(".sel").forEach((n) => n.classList.remove("sel"));
    this.scroller.querySelectorAll(".hl-sel").forEach((n) => n.remove());
  }

  // "Open here": show a range and make it blink once.
  flash(start, end) {
    this.scrollToWord(start);
    if (this.view === "text") {
      const els = [];
      for (let i = start; i <= end; i++) els.push(this.wordEls[i], this.spaceEls[i]);
      els.filter(Boolean).forEach((n) => n.classList.add("flash"));
      setTimeout(() => els.filter(Boolean).forEach((n) => n.classList.remove("flash")), 1800);
    } else {
      const boxes = mergeLines(this.doc.words, start, end).map((b) => this.addBox(b, "hl-flash")).filter(Boolean);
      setTimeout(() => boxes.forEach((n) => n.remove()), 1800);
    }
  }

  scrollToWord(i) {
    let t;
    if (this.view === "text") t = this.wordEls[i];
    else {
      const b = this.doc.words[i]?.rects[0];
      const pe = b && this.pageEls[b.p];
      if (pe) {
        const r = pe.box.getBoundingClientRect();
        const v = this.scroller.getBoundingClientRect();
        this.scroller.scrollBy({ top: r.top - v.top + b.y * pe.scale - v.height * 0.35 });
        return;
      }
    }
    if (!t) return;
    const r = t.getBoundingClientRect();
    const v = this.scroller.getBoundingClientRect();
    this.scroller.scrollBy({ top: r.top - v.top - v.height * 0.35 });
  }

  // ---- layers 3 + 4: what the voice is reading ----

  setActive(word, sentence) {
    const sentenceChanged = sentence !== this.sentence;
    this.word = word;
    this.sentence = sentence;
    this.paint(sentenceChanged);
  }

  paint(sentenceChanged) {
    if (this.word < 0) return;
    const showWord = this.highlight === "both" || this.highlight === "word";
    const showSentence = this.highlight === "both" || this.highlight === "sentence";
    const s = this.doc.sentences[this.sentence];
    if (this.view === "text") {
      if (sentenceChanged || !showWord) {
        this.scroller.querySelectorAll(".w.sent").forEach((n) => n.classList.remove("sent"));
        if (showSentence && s) for (let i = s.first; i <= s.last; i++) this.wordEls[i]?.classList.add("sent");
      }
      this.scroller.querySelector(".w.cur")?.classList.remove("cur");
      const cur = this.wordEls[this.word];
      if (showWord) cur?.classList.add("cur");
      this.target = cur;
    } else {
      if (sentenceChanged) {
        for (const pe of this.pageEls) pe.hl.querySelectorAll(".hl-sent").forEach((n) => n.remove());
        if (showSentence && s) {
          for (const box of mergeLines(this.doc.words, s.first, s.last)) this.addBox(box, "hl-sent");
        }
      }
      for (const pe of this.pageEls) pe.hl.querySelector(".hl-word")?.remove();
      let first = null;
      for (const b of this.doc.words[this.word]?.rects || []) {
        const n = this.addBox(b, "hl-word", !showWord);
        first ||= n;
      }
      this.target = first;
    }
  }

  addBox(b, cls, hidden = false, layer = "hl") {
    const pe = this.pageEls?.[b.p];
    if (!pe) return null;
    const pad = cls === "hl-word" ? 1.5 : 1;
    const n = el("div", cls);
    n.style.left = `${(b.x - pad) * pe.scale}px`;
    n.style.top = `${(b.y - pad) * pe.scale}px`;
    n.style.width = `${(b.w + pad * 2) * pe.scale}px`;
    n.style.height = `${(b.h + pad * 2) * pe.scale}px`;
    if (hidden) n.style.visibility = "hidden";
    pe[layer].append(n);
    return n;
  }

  // Keep the spoken word in the middle third of the screen.
  follow(smooth = true) {
    const t = this.target;
    if (!t) return;
    const r = t.getBoundingClientRect();
    const v = this.scroller.getBoundingClientRect();
    if (r.top < v.top + v.height * 0.2 || r.bottom > v.top + v.height * 0.7) {
      this.scroller.scrollBy({ top: r.top - v.top - v.height * 0.35, behavior: smooth ? "smooth" : "auto" });
    }
  }
}

export function sentenceOf(doc, word) {
  const list = doc.sentences;
  let lo = 0;
  let hi = list.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].first <= word) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// Join the word boxes of a range into one box per line, so the band looks
// like a marker stroke instead of many little boxes.
function mergeLines(words, first, last) {
  const out = [];
  for (let i = first; i <= last; i++) {
    for (const b of words[i]?.rects || []) {
      const line = out.find((o) => o.p === b.p && Math.abs(o.y - b.y) < b.h * 0.5 && b.x - (o.x + o.w) < b.h * 2 && b.x >= o.x - 1);
      if (line) {
        const right = Math.max(line.x + line.w, b.x + b.w);
        line.y = Math.min(line.y, b.y);
        line.h = Math.max(line.h, b.h);
        line.w = right - line.x;
      } else out.push({ ...b });
    }
  }
  return out;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
