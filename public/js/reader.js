// Two ways to look at the same document, both with live highlights:
//
//   Original view - the real PDF pages, with highlight boxes drawn on top.
//   Text view     - clean reflowed text you can restyle (font, size, theme).
//
// The highlight has two layers, like Speechify: a soft band on the sentence
// being read and a strong mark on the word being spoken.

export class Reader {
  constructor({ scroller, pdf, doc, onWordClick, onUserScroll }) {
    this.scroller = scroller;
    this.pdf = pdf;
    this.doc = doc;
    this.onWordClick = onWordClick;
    this.onUserScroll = onUserScroll;
    this.view = "original";
    this.word = -1;
    this.sentence = -1;
    this.highlight = "both"; // both | word | sentence | off

    // Only scrolling done by a person turns autoscroll off.
    for (const ev of ["wheel", "touchmove", "mousedown"]) {
      scroller.addEventListener(ev, (e) => {
        if (ev === "mousedown" && e.target !== scroller) return; // scrollbar drags only
        this.onUserScroll();
      }, { passive: true });
    }
  }

  setView(view) {
    this.view = view;
    this.scroller.innerHTML = "";
    this.scroller.dataset.view = view;
    if (view === "text") this.buildText();
    else this.buildOriginal();
    this.paint(true);
  }

  // ---- text view ----

  buildText() {
    const { words, paragraphs, pages } = this.doc;
    const col = el("article", "text-col");
    this.wordEls = new Array(words.length);
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
        p.append(span, " ");
      }
      frag.append(p);
    }
    if (!paragraphs.length) frag.append(el("p", "empty-note", "This PDF has no selectable text. It is probably a scan. Scans need OCR, which is not in this MVP yet."));
    col.append(frag);
    col.addEventListener("click", (e) => {
      const i = e.target?.dataset?.i;
      if (i != null) this.onWordClick(Number(i));
    });
    this.scroller.append(col);
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
      const hl = el("div", "hl-layer");
      box.append(canvas, hl);
      if (pg.empty) box.append(el("div", "page-note", "No text on this page (scan)"));
      wrap.append(box);
      this.pageEls.push({ box, canvas, hl, scale, rendered: false });
      box.addEventListener("click", (e) => this.clickPage(idx, e));
    });
    this.scroller.append(wrap);

    // Draw pages only when they come near the screen.
    this.observer?.disconnect();
    this.observer = new IntersectionObserver((entries) => {
      for (const en of entries) if (en.isIntersecting) this.renderPage(Number(en.target.dataset.page));
    }, { root: this.scroller, rootMargin: "800px 0px" });
    for (const pe of this.pageEls) this.observer.observe(pe.box);
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

  clickPage(idx, e) {
    const pe = this.pageEls[idx];
    const r = pe.box.getBoundingClientRect();
    const x = (e.clientX - r.left) / pe.scale;
    const y = (e.clientY - r.top) / pe.scale;
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
    if (best >= 0 && bestD < 400) this.onWordClick(best);
  }

  // ---- highlight ----

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

  addBox(b, cls, hidden = false) {
    const pe = this.pageEls[b.p];
    if (!pe) return null;
    const pad = cls === "hl-word" ? 1.5 : 1;
    const n = el("div", cls);
    n.style.left = `${(b.x - pad) * pe.scale}px`;
    n.style.top = `${(b.y - pad) * pe.scale}px`;
    n.style.width = `${(b.w + pad * 2) * pe.scale}px`;
    n.style.height = `${(b.h + pad * 2) * pe.scale}px`;
    if (hidden) n.style.visibility = "hidden";
    pe.hl.append(n);
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

// Join the word boxes of a sentence into one box per line, so the sentence
// band looks like a marker stroke instead of many little boxes.
function mergeLines(words, first, last) {
  const out = [];
  for (let i = first; i <= last; i++) {
    for (const b of words[i].rects) {
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
