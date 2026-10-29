// App shell: sign-in, the library screen, the reader screen, and the controls
// that connect the Player (sound) to the Reader (highlights).
//
// Two modes:
//   local - the original PC app: PDFs in data/library, Kokoro via /api/tts.
//   cloud - Supabase: library, positions and audio follow you to every device.
// The deployed site is always cloud. On localhost you can switch.

import * as cloud from "./cloud.js";
import { CLOUD_READY, ENGINES, KOKORO_VOICES } from "./config.js";
import { buildDocument } from "./document.js";
import { anchor, buildChapters, checkLabel, colorOf, createHighlightStore, describeRange, MAX_CUSTOM, pathText, toMarkdown } from "./highlights.js";
import { downloadRange, nextChapter } from "./offline.js";
import { openPdf } from "./pdf.js";
import { Player, systemVoices } from "./player.js";
import { Reader, sentenceOf } from "./reader.js";

const $ = (s) => document.querySelector(s);
const IS_LOCALHOST = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);

// ---- settings (remembered in this browser) ----
const DEFAULTS = {
  view: "original", font: "sans", size: 20, line: 1.7, width: "medium", theme: "light", highlight: "both", speed: 1,
  voice: "af_heart", systemVoice: "", engine: "pc", localEngine: "local", mode: "local",
};
let settings = { ...DEFAULTS };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem("readaloud.settings") || "{}"));
} catch {}
// Old format: voice "k:af_heart" or "s:Microsoft Zira".
if (/^[ks]:/.test(settings.voice)) {
  if (settings.voice.startsWith("s:")) Object.assign(settings, { localEngine: "system", systemVoice: settings.voice.slice(2), voice: "af_heart" });
  else settings.voice = settings.voice.slice(2);
}
if (!IS_LOCALHOST) settings.mode = "cloud";
// No supabase-config.js yet: local mode only (see README, "Cloud setup").
if (IS_LOCALHOST && !CLOUD_READY) settings.mode = "local";
if (!IS_LOCALHOST && settings.view === "original" && matchMedia("(max-width: 720px)").matches && !localStorage.getItem("readaloud.settings")) settings.view = "text";
function saveSettings() {
  try {
    localStorage.setItem("readaloud.settings", JSON.stringify(settings));
  } catch {}
}
function applyLook() {
  const root = document.documentElement;
  root.dataset.theme = settings.theme;
  root.dataset.font = settings.font;
  root.dataset.width = settings.width;
  root.style.setProperty("--read-size", `${settings.size}px`);
  root.style.setProperty("--read-line", settings.line);
}
applyLook();

const isCloud = () => settings.mode === "cloud";

// ---------------------------------------------------------------------------
// Two libraries behind one interface.

const localStore = {
  list: () => fetch("/api/library").then((r) => r.json()).then((items) => items.map((it) => ({ ...it, opened_at: it.openedAt }))),
  async upload(file) {
    const r = await fetch("/api/library", { method: "POST", headers: { "x-file-name": encodeURIComponent(file.name) }, body: file });
    if (!r.ok) throw new Error((await r.json()).error);
  },
  remove: (item) => fetch(`/api/library/${item.id}`, { method: "DELETE" }),
  removeNote: "The file moves to data/trash.",
  async open(item, onProgress) {
    const pdf = await openPdf(`/api/library/${item.id}/file`);
    const doc = await buildDocument(pdf, onProgress);
    fetch(`/api/library/${item.id}`, patchReq({ pages: doc.numPages, words: doc.words.length, openedAt: new Date().toISOString() }));
    return { pdf, doc };
  },
  savePosition: (item, word) => fetch(`/api/library/${item.id}`, patchReq({ position: { word } })),
  coverSource: (item) => `/api/library/${item.id}/file`,
};
function patchReq(body) {
  return { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

const cloudStore = {
  list: () => cloud.listDocuments(),
  upload: (file) => cloud.uploadPdf(file),
  remove: (item) => cloud.removeDocument(item),
  removeNote: "It is deleted from the cloud on all your devices.",
  async open(item, onProgress) {
    onProgress(0, 0, "Getting the PDF…");
    const bytes = await cloud.pdfBytes(item);
    const pdf = await openPdf(bytes);
    let doc = await cloud.loadDoc(item);
    if (!doc) {
      // First open anywhere: read the PDF once, save the result for all devices.
      doc = await buildDocument(pdf, onProgress);
      cloud.saveDoc(item, doc).catch((err) => console.warn("could not save parsed document", err));
    }
    cloud.patchDocument(item.id, { opened_at: new Date().toISOString() }).catch(() => {});
    return { pdf, doc };
  },
  savePosition: (item, word) => cloud.savePosition(item.id, word),
  coverSource: () => null, // covers would download every PDF; skipped on phones
};
const store = () => (isCloud() ? cloudStore : localStore);

// ---------------------------------------------------------------------------
// Start

async function boot() {
  if ("serviceWorker" in navigator && (location.protocol === "https:" || IS_LOCALHOST)) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
  if (isCloud()) {
    // A used or old email link comes back as #error=...; read it before the client clears it.
    const back = new URLSearchParams(location.hash.slice(1) || location.search.slice(1));
    const linkError = back.get("error_description") || back.get("error");
    cloud.init();
    const u = await cloud.currentUser();
    if (location.hash.includes("access_token") || linkError) history.replaceState(null, "", location.pathname);
    if (!u) {
      showSignin();
      if (linkError) toast(/expired|invalid|denied/i.test(linkError) ? "That sign-in link is used or too old. Open the newest email, or send a new link." : linkError, 9000);
      return;
    }
    startCloud();
  } else {
    loadLocalVoices();
    pollStatus();
    initHighlights("local");
  }
  showLibrary();
}

function startCloud() {
  cloud.startLive();
  initHighlights("cloud");
  cloud.on("document", onDocumentChanged);
  cloud.on("engines", () => {
    updateStatusDots();
    if (!$("#listen-pop").hidden) refreshEngineNote();
  });
  updateStatusDots();
}

// ---------------------------------------------------------------------------
// Sign-in

function showSignin() {
  hideAll();
  $("#signin").hidden = false;
  $("#use-local").hidden = !IS_LOCALHOST;
  const saved = localStorage.getItem("readaloud.email");
  if (saved) $("#email").value = saved;
}

$("#signin-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = $("#email").value.trim();
  const btn = $("#signin-btn");
  btn.disabled = true;
  btn.textContent = "Signing in…";
  try {
    await cloud.signInWithPassword(email, $("#password").value);
    localStorage.setItem("readaloud.email", email);
    $("#password").value = "";
    startCloud();
    showLibrary();
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Sign in";
  }
};
$("#send-link").onclick = async () => {
  const email = $("#email").value.trim();
  if (!$("#email").checkValidity() || !email) return toast("Type your email first.");
  const btn = $("#send-link");
  btn.disabled = true;
  try {
    await cloud.sendLink(email);
    localStorage.setItem("readaloud.email", email);
    $("#link-sent").hidden = false;
    $("#signin-form").hidden = true;
  } catch (err) {
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
};
$("#paste-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await cloud.signInWithPasted($("#paste").value, $("#email").value.trim());
    startCloud();
    showLibrary();
  } catch (err) {
    toast(err.message);
  }
};
$("#resend").onclick = () => {
  $("#link-sent").hidden = true;
  $("#signin-form").hidden = false;
};
$("#use-local").onclick = () => setMode("local");

// A link tapped on another tab of this browser signs this tab in too.
window.addEventListener("storage", async (e) => {
  if (!isCloud() || !e.key?.includes("auth-token") || $("#signin").hidden) return;
  if (await cloud.currentUser()) {
    startCloud();
    showLibrary();
  }
});

function setMode(mode) {
  if (mode === "cloud" && !CLOUD_READY) return toast("Cloud is not set up yet. See README, \"Cloud setup\".", 6000);
  settings.mode = mode;
  saveSettings();
  location.reload();
}

// ---------------------------------------------------------------------------
// Library

let libraryItems = [];

function hideAll() {
  for (const id of ["#signin", "#library", "#reader", "#vault"]) $(id).hidden = true;
  closeSheets();
}

async function showLibrary() {
  closeReader();
  hideAll();
  $("#library").hidden = false;
  $("#lib-sub").textContent = isCloud() ? "Your books, on every device. Pick up where you stopped." : "Everything stays on this computer. Drop PDFs anywhere on the page.";
  $("#account-who").textContent = isCloud() ? `Signed in as ${cloud.user?.email}` : "Local library on this PC";
  $("#sign-out").hidden = !isCloud();
  $("#password-form").hidden = !isCloud();
  $("#mode-row").hidden = !IS_LOCALHOST;
  document.querySelectorAll("[data-mode]").forEach((b) => b.classList.toggle("on", b.dataset.mode === settings.mode));
  try {
    libraryItems = await store().list();
  } catch (err) {
    libraryItems = [];
    toast(navigator.onLine ? `Could not load the library: ${err.message}` : "You are offline.");
  }
  renderLibrary();
  if (isCloud() && IS_LOCALHOST) checkImport();
  openDeepLink();
}

function renderLibrary() {
  const grid = $("#grid");
  grid.innerHTML = "";
  $("#empty").hidden = libraryItems.length > 0;
  for (const it of libraryItems) {
    const card = document.createElement("article");
    card.className = "card";
    const pct = it.words ? Math.round(((it.position?.word || 0) / Math.max(1, it.words - 1)) * 100) : 0;
    card.innerHTML = `
      <button class="card-open" aria-label="Open">
        <div class="card-cover"><span>PDF</span></div>
        <h3></h3>
        <p class="meta"></p>
        <div class="bar"><i style="width:${pct}%"></i></div>
      </button>
      <button class="card-del" title="Remove from library" aria-label="Remove">✕</button>`;
    card.querySelector("h3").textContent = it.title;
    card.querySelector(".meta").textContent = [it.pages ? `${it.pages} pages` : "New", pct ? `${pct}% read` : null].filter(Boolean).join(" · ");
    card.querySelector(".card-open").onclick = () => openItem(it);
    card.querySelector(".card-del").onclick = async () => {
      if (!confirm(`Remove "${it.title}" from your library?\n${store().removeNote}`)) return;
      try {
        await store().remove(it);
      } catch (err) {
        toast(err.message);
      }
      showLibrary();
    };
    grid.append(card);
    const src = store().coverSource(it);
    if (src) drawCover(src, card.querySelector(".card-cover"));
  }
}

// Small picture of page 1 on each card.
async function drawCover(src, box) {
  try {
    const pdf = await openPdf(src);
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: (box.clientWidth * 2) / base.width });
    const canvas = document.createElement("canvas");
    canvas.width = vp.width;
    canvas.height = vp.height;
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
    box.replaceChildren(canvas);
    box.classList.add("has-cover");
    closePdf(pdf);
  } catch {}
}

async function uploadFiles(files) {
  const pdfs = [...files].filter((f) => f.type === "application/pdf" || /\.pdf$/i.test(f.name));
  if (!pdfs.length) return toast("Only PDF files for now.");
  let ok = 0;
  for (const f of pdfs) {
    toast(`Adding ${f.name}…`, 60000);
    try {
      await store().upload(f);
      ok++;
    } catch (err) {
      toast(`${f.name}: ${err.message}`);
      await sleep(2500);
    }
  }
  if (ok) toast(ok === 1 ? "Added to your library." : `Added ${ok} files.`);
  showLibrary();
}

$("#file").onchange = (e) => uploadFiles(e.target.files).then(() => (e.target.value = ""));
$("#add").onclick = () => $("#file").click();
$("#add2").onclick = () => $("#file").click();
$("#account-btn").onclick = () => togglePop("#account-pop");
$("#password-form").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await cloud.setPassword($("#new-password").value);
    $("#new-password").value = "";
    toast("Password saved. Use it next time you sign in.");
  } catch (err) {
    toast(err.message);
  }
};
$("#sign-out").onclick = async () => {
  await cloud.signOut();
  cloud.stopLive();
  showSignin();
};
document.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => b.dataset.mode !== settings.mode && setMode(b.dataset.mode)));

window.addEventListener("dragover", (e) => {
  e.preventDefault();
  document.body.classList.add("dragging");
});
window.addEventListener("dragleave", (e) => {
  if (!e.relatedTarget) document.body.classList.remove("dragging");
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  document.body.classList.remove("dragging");
  if (e.dataTransfer?.files?.length && !$("#library").hidden) uploadFiles(e.dataTransfer.files);
});

// ---- move the PC library to the cloud (localhost + cloud mode only) ----

let toImport = [];
async function checkImport() {
  const local = await localStore.list().catch(() => []);
  const have = new Set(libraryItems.map((i) => i.id));
  toImport = local.filter((i) => !have.has(i.id));
  $("#import").hidden = !toImport.length;
  $("#import-count").textContent = toImport.length === 1 ? "1 book" : `${toImport.length} books`;
}
$("#import-btn").onclick = async () => {
  const mb = (toImport.reduce((a, b) => a + (b.bytes || 0), 0) / 1048576).toFixed(1);
  if (!confirm(`Copy ${toImport.length} PDF(s), ${mb} MB, from this PC to your cloud library?\nYour PC copies stay as they are.`)) return;
  const btn = $("#import-btn");
  btn.disabled = true;
  for (const [n, it] of toImport.entries()) {
    btn.textContent = `Copying ${n + 1} of ${toImport.length}…`;
    try {
      const blob = await fetch(`/api/library/${it.id}/file`).then((r) => r.blob());
      const file = new File([blob], it.fileName || `${it.title}.pdf`, { type: "application/pdf" });
      const row = await cloud.uploadPdf(file, { id: it.id, title: it.title, position: { word: it.position?.word || 0 }, openedAt: it.openedAt });
      // Read it here once (fast on the PC), so the phone opens it at once.
      btn.textContent = `Reading ${n + 1} of ${toImport.length}…`;
      const pdf = await openPdf(await blob.arrayBuffer());
      await cloud.saveDoc(row, await buildDocument(pdf));
      closePdf(pdf);
    } catch (err) {
      toast(`${it.title}: ${err.message}`);
      await sleep(2500);
    }
  }
  btn.disabled = false;
  btn.textContent = "Copy them to the cloud";
  toast("Done. Your books are in the cloud.");
  showLibrary();
};

// ---------------------------------------------------------------------------
// Reader

let session = null; // { item, pdf, doc, player, reader, follow }

// opts: { highlight } = open at a highlight and make it blink,
//       { word } = open at a word, { reel: [highlights] } = start a reel.
async function openItem(item, opts = {}) {
  closeReader();
  hideAll();
  $("#reader").hidden = false;
  $("#title").textContent = item.title;
  $("#scroller").innerHTML = "";
  const busy = $("#busy");
  busy.hidden = false;
  busy.textContent = "Opening…";

  let opened;
  try {
    opened = await store().open(item, (p, n, msg) => (busy.textContent = msg || `Reading page ${p} of ${n}… (only the first time)`));
  } catch (err) {
    busy.hidden = true;
    toast(`Could not open: ${err.message}`);
    return showLibrary();
  }
  busy.hidden = true;
  const { pdf, doc } = opened;

  const player = new Player(doc);
  const reader = new Reader({
    scroller: $("#scroller"),
    pdf,
    doc,
    onWordClick: (i) => {
      player.seekWord(i, true);
      setFollow(true);
    },
    onUserScroll: () => setFollow(false),
    onSelect: (start, end) => openNewSheet(start, end),
    onHighlightTap: (id) => openEditSheet(id),
  });
  reader.highlight = settings.highlight;
  session = { item, pdf, doc, player, reader, follow: true, chapters: [] };
  session.chaptersReady = buildChapters(pdf, doc)
    .then((c) => (session && session.doc === doc ? (session.chapters = c) : c))
    .catch(() => []);

  player.speed = settings.speed;
  player.voice = settings.voice;
  player.systemVoice = settings.systemVoice;
  player.setEngine(engineKind(), { documentId: item.id });
  reader.setView(settings.view);
  refreshReaderHighlights();

  const last = Math.max(0, doc.words.length - 1);
  const at = opts.highlight ? anchor(doc, opts.highlight) : null;
  const start = Math.min(at ? at.start : opts.word ?? item.position?.word ?? 0, last);
  player.seekWord(start, false);
  reader.setActive(player.word, player.sentence);
  requestAnimationFrame(() => (at ? reader.flash(at.start, at.end) : reader.follow(false)));

  player.addEventListener("word", () => {
    reader.setActive(player.word, player.sentence);
    if (session.follow) reader.follow();
    updateProgress();
    updateSaveButton();
    savePositionSoon();
    checkReel();
  });
  player.addEventListener("state", (e) => {
    updatePlayButton();
    updateMediaSession();
    if (e.detail?.error && e.detail.error !== "cancelled") toast(e.detail.error, 6000);
    if (player.state === "paused" || player.state === "ended") savePositionNow();
    if (player.state === "ended" && reel) finishReel();
  });
  player.addEventListener("speed", updateSpeedLabel);

  $("#progress").max = Math.max(0, doc.words.length - 1);
  $("#offline-row").hidden = !isCloud();
  updateProgress();
  updatePlayButton();
  updateSpeedLabel();
  syncFormatPanel();
  fillEngines();
  fillVoiceSelect();
  setupMediaSession();
  updateSaveButton();
  if (!doc.words.length) toast("No text found. This looks like a scanned PDF.");
  // A tap started this, but the book took a moment to open. Phones only
  // allow sound inside a tap, so the reel waits for the Play button.
  if (opts.reel) startReel(opts.reel, { autoplay: false });
}

function closeReader() {
  if (!session) return;
  stopReel();
  closeSheets();
  session.reader.dispose();
  savePositionNow();
  session.player.engine?.stop();
  session.player.engine?.dispose?.();
  closePdf(session.pdf);
  session = null;
  if ("mediaSession" in navigator) navigator.mediaSession.metadata = null;
}

let saveTimer = null;
function savePositionSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(savePositionNow, 4000);
}
function savePositionNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  if (!session) return;
  const word = session.player.word;
  if (word === session.savedWord) return;
  session.savedWord = word;
  session.item.position = { word };
  store().savePosition(session.item, word);
}

// Another device saved a new position (Realtime).
function onDocumentChanged(row) {
  const it = libraryItems.find((i) => i.id === row.id);
  if (it) Object.assign(it, row);
  if (!$("#library").hidden) renderLibrary();
  if (!session || session.item.id !== row.id) return;
  const pos = row.position || {};
  if (pos.device === cloud.deviceId || pos.word == null) return;
  const p = session.player;
  if (p.state === "playing" || p.state === "loading" || pos.word === p.word) return;
  session.savedWord = pos.word;
  p.seekWord(Math.min(pos.word, session.doc.words.length - 1), false);
  session.reader.setActive(p.word, p.sentence);
  session.reader.follow();
  toast("Moved to where you stopped on your other device.");
}

function setFollow(on) {
  if (!session) return;
  session.follow = on;
  $("#follow").hidden = on || !(session.player.state === "playing" || session.player.state === "loading");
  if (on) session.reader.follow();
}

// ---- engine + voice ----

function engineKind() {
  if (!isCloud()) return settings.localEngine === "system" ? "system" : "local";
  return settings.engine === "device" ? "system" : settings.engine;
}
const usesSystemVoice = () => engineKind() === "system";

function fillEngines() {
  const box = $("#engines");
  box.innerHTML = "";
  const list = isCloud()
    ? ENGINES
    : [
        { id: "local", name: "This PC", note: "Kokoro on this computer." },
        { id: "system", name: "System voice", note: "The voices built into Windows. Exact word timing." },
      ];
  const current = isCloud() ? settings.engine : settings.localEngine;
  for (const e of list) {
    const b = document.createElement("button");
    b.textContent = e.name;
    b.dataset.engine = e.id;
    b.classList.toggle("on", e.id === current);
    b.onclick = () => setEngine(e.id);
    box.append(b);
  }
  refreshEngineNote();
}

async function refreshEngineNote() {
  const id = isCloud() ? settings.engine : settings.localEngine;
  const list = isCloud() ? ENGINES : [];
  const base = list.find((e) => e.id === id)?.note || "";
  const note = $("#engine-note");
  note.textContent = base;
  note.dataset.state = "";
  if (!isCloud()) return;
  const st = await cloud.engineStatus(id);
  if ((isCloud() ? settings.engine : settings.localEngine) !== id) return;
  note.textContent = st.note ? `${st.ok ? "" : "⚠ "}${st.note}` : base;
  note.dataset.state = st.ok ? "ok" : "bad";
}

function setEngine(id) {
  if (isCloud()) settings.engine = id;
  else settings.localEngine = id;
  saveSettings();
  document.querySelectorAll("#engines button").forEach((b) => b.classList.toggle("on", b.dataset.engine === id));
  fillVoiceSelect();
  refreshEngineNote();
  updateStatusDots();
  if (session) session.player.setEngine(engineKind(), { documentId: session.item.id });
}

let localVoices = [];
async function loadLocalVoices() {
  localVoices = await fetch("/api/voices").then((r) => r.json()).catch(() => []);
  fillVoiceSelect();
}
function fillVoiceSelect() {
  const sel = $("#voice");
  sel.innerHTML = "";
  if (usesSystemVoice()) {
    const voices = systemVoices();
    for (const v of voices) sel.append(new Option(v.name.replace(/^Microsoft /, "").replace(/ - English.*$/, ""), v.name));
    if (!voices.length) sel.append(new Option("Default voice", ""));
    sel.value = settings.systemVoice;
    if (sel.value !== settings.systemVoice) sel.selectedIndex = 0;
  } else {
    const list = !isCloud() && localVoices.length ? localVoices : KOKORO_VOICES;
    for (const v of list) sel.append(new Option(`${v.name} (${v.accent})`, v.id));
    sel.value = settings.voice;
    if (sel.value !== settings.voice) sel.value = "af_heart";
  }
  const eng = isCloud() ? ENGINES.find((e) => e.id === settings.engine)?.name : settings.localEngine === "system" ? "System" : "This PC";
  $("#listen-label").textContent = eng || "Voice";
}
window.speechSynthesis?.addEventListener?.("voiceschanged", () => usesSystemVoice() && fillVoiceSelect());

$("#voice").onchange = (e) => {
  const v = e.target.value;
  if (usesSystemVoice()) {
    settings.systemVoice = v;
    if (session) {
      session.player.systemVoice = v;
      session.player.engine.voiceChanged();
    }
  } else {
    settings.voice = v;
    session?.player.setVoice(v);
  }
  saveSettings();
};
$("#listen-btn").onclick = () => {
  togglePop("#listen-pop");
  if (!$("#listen-pop").hidden) refreshEngineNote();
};

// Green / orange / red dot: is the chosen voice usable?
async function pollStatus() {
  const s = await fetch("/api/status").then((r) => r.json()).catch(() => null);
  localState = !s ? "off" : s.ready ? "ready" : s.error ? "error" : "loading";
  localTitle = !s ? "Server not reachable" : s.ready ? "Local voice ready" : s.error ? `Voice failed: ${s.error}` : "Local voice is loading…";
  updateStatusDots();
  if (!s?.ready) setTimeout(pollStatus, 1500);
}
let localState = "loading";
let localTitle = "";
function updateStatusDots() {
  let state = localState;
  let title = localTitle;
  if (isCloud()) {
    const e = settings.engine;
    if (e === "device") [state, title] = ["ready", "Phone voice"];
    else if (e === "pc") [state, title] = cloud.isOnline("pc") ? ["ready", "PC voice is on"] : ["off", "PC voice is off"];
    else [state, title] = ["ready", ENGINES.find((x) => x.id === e)?.name];
  } else if (settings.localEngine === "system") [state, title] = ["ready", "System voice"];
  for (const dot of document.querySelectorAll(".status-dot")) {
    dot.dataset.state = state;
    dot.title = title;
  }
}

// ---- transport ----

$("#play").onclick = () => session?.player.toggle();
$("#back").onclick = () => session?.player.skipSentence(-1);
$("#fwd").onclick = () => session?.player.skipSentence(1);
$("#home").onclick = () => showLibrary();
$("#follow").onclick = () => setFollow(true);
$("#progress").oninput = (e) => session?.player.seekWord(Number(e.target.value));

function updatePlayButton() {
  if (!session) return;
  const st = session.player.state;
  const btn = $("#play");
  btn.dataset.state = st;
  btn.setAttribute("aria-label", st === "playing" ? "Pause" : "Play");
  if (st !== "playing" && st !== "loading") $("#follow").hidden = true;
}

function updateProgress() {
  if (!session) return;
  const { player, doc } = session;
  $("#progress").value = player.word;
  const msPerWord = player.engine?.msPerWord || 380;
  const left = ((doc.words.length - player.word) * msPerWord) / player.speed / 1000;
  $("#time-left").textContent = `${fmtTime(left)} left`;
  const page = doc.words[player.word]?.page ?? 0;
  $("#page-pos").textContent = `Page ${page + 1} / ${doc.numPages}`;
}

// ---- lock screen + headphone buttons (Media Session API) ----

function setupMediaSession() {
  if (!("mediaSession" in navigator) || !session) return;
  const ms = navigator.mediaSession;
  ms.metadata = new MediaMetadata({
    title: session.item.title,
    artist: "ReadAloud",
    artwork: [{ src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" }],
  });
  const handlers = {
    play: () => session?.player.play(),
    pause: () => session?.player.pause(),
    stop: () => session?.player.pause(),
    previoustrack: () => (reel ? playClip(Math.max(0, reel.i - 1)) : session?.player.skipSentence(-1)),
    nexttrack: () => (reel ? playClip(reel.i + 1) : session?.player.skipSentence(1)),
    seekbackward: () => session?.player.skipSentence(-1),
    seekforward: () => session?.player.skipSentence(1),
  };
  for (const [action, fn] of Object.entries(handlers)) {
    try {
      ms.setActionHandler(action, fn);
    } catch {}
  }
}
function updateMediaSession() {
  if (!("mediaSession" in navigator) || !session) return;
  const st = session.player.state;
  navigator.mediaSession.playbackState = st === "playing" || st === "loading" ? "playing" : "paused";
}

// ---- sleep timer ----

const SLEEP = [0, 5, 15, 30, 45, 60];
let sleepAt = 0;
let sleepTimer = null;
for (const m of SLEEP) {
  const b = document.createElement("button");
  b.textContent = m ? `${m} min` : "Off";
  b.dataset.min = m;
  b.onclick = () => setSleep(m);
  $("#sleep").append(b);
}
function setSleep(min) {
  clearInterval(sleepTimer);
  sleepAt = min ? Date.now() + min * 60000 : 0;
  document.querySelectorAll("#sleep button").forEach((b) => b.classList.toggle("on", Number(b.dataset.min) === min));
  if (min) sleepTimer = setInterval(tickSleep, 1000);
  tickSleep();
}
function tickSleep() {
  const badge = $("#sleep-badge");
  if (!sleepAt) return (badge.hidden = true);
  const left = sleepAt - Date.now();
  if (left <= 0) {
    session?.player.pause();
    setSleep(0);
    toast("Sleep timer: stopped.");
    return;
  }
  badge.hidden = false;
  badge.textContent = `${Math.ceil(left / 60000)}′`;
}
setSleep(0);

// ---- offline chapter ----

$("#download").onclick = async () => {
  if (!session) return;
  const note = $("#download-note");
  const btn = $("#download");
  if (settings.engine === "device") return (note.textContent = "The phone voice needs no download. It works offline.");
  const { from, to } = nextChapter(session.doc, session.player.sentence);
  btn.disabled = true;
  note.textContent = `Preparing ${to - from + 1} sentences…`;
  try {
    const { saved, total } = await downloadRange({
      doc: session.doc,
      documentId: session.item.id,
      engine: settings.engine,
      voice: settings.voice,
      from,
      to,
      onProgress: (n, t) => (note.textContent = `Saving on this device: ${n} of ${t}…`),
    });
    const pages = `pages ${session.doc.words[session.doc.sentences[from].first].page + 1}–${session.doc.words[session.doc.sentences[to].last].page + 1}`;
    note.textContent = `Saved ${saved} of ${total} sentences (${pages}). They play without internet.`;
  } catch (err) {
    note.textContent = `⚠ ${err.message}`;
  } finally {
    btn.disabled = false;
  }
};

// ---- speed ----

const SPEEDS = [0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const speedPresets = $("#speed-presets");
for (const s of SPEEDS) {
  const b = document.createElement("button");
  b.textContent = `${s}×`;
  b.dataset.speed = s;
  b.onclick = () => setSpeed(s);
  speedPresets.append(b);
}
$("#speed-range").oninput = (e) => setSpeed(Number(e.target.value));
$("#speed-down").onclick = () => setSpeed((session?.player.speed || settings.speed) - 0.1);
$("#speed-up").onclick = () => setSpeed((session?.player.speed || settings.speed) + 0.1);
$("#speed-btn").onclick = () => togglePop("#speed-pop");

function setSpeed(s) {
  s = Math.round(Math.min(3.5, Math.max(0.5, s)) * 100) / 100;
  settings.speed = s;
  saveSettings();
  if (session) session.player.setSpeed(s);
  else updateSpeedLabel();
}
function updateSpeedLabel() {
  const s = session?.player.speed ?? settings.speed;
  const msPerWord = session?.player.engine?.msPerWord || 380;
  const wpm = Math.round((60000 / msPerWord) * s);
  $("#speed-btn").textContent = `${s}×`;
  $("#speed-value").textContent = `${s}× · about ${wpm} words/min`;
  $("#speed-range").value = s;
  speedPresets.querySelectorAll("button").forEach((b) => b.classList.toggle("on", Number(b.dataset.speed) === s));
  updateProgress();
}

// ---- text format panel ----

$("#format-btn").onclick = () => togglePop("#format-pop");
document.querySelectorAll("[data-set]").forEach((ctrl) => {
  const key = ctrl.dataset.set;
  const handler = () => {
    let v = ctrl.type === "range" ? Number(ctrl.value) : ctrl.dataset.value ?? ctrl.value;
    if (key === "line") v = Number(v);
    settings[key] = v;
    saveSettings();
    applyLook();
    syncFormatPanel();
    if (!session) return;
    if (key === "view") {
      session.reader.setView(v);
      requestAnimationFrame(() => session.reader.follow(false));
    }
    if (key === "highlight") {
      session.reader.highlight = v;
      session.reader.paint(true);
    }
  };
  ctrl.addEventListener(ctrl.type === "range" ? "input" : "click", handler);
});
function syncFormatPanel() {
  document.querySelectorAll("[data-set]").forEach((ctrl) => {
    const v = settings[ctrl.dataset.set];
    if (ctrl.type === "range") ctrl.value = v;
    else ctrl.classList.toggle("on", String(ctrl.dataset.value) === String(v));
  });
  document.querySelectorAll("[data-for-view]").forEach((n) => (n.hidden = n.dataset.forView !== settings.view));
}

function togglePop(sel) {
  const pop = $(sel);
  const open = pop.hidden;
  document.querySelectorAll(".pop").forEach((p) => (p.hidden = true));
  pop.hidden = !open;
}
document.addEventListener("click", (e) => {
  if (!e.target.closest(".pop, [data-pop]")) document.querySelectorAll(".pop").forEach((p) => (p.hidden = true));
});

// ---------------------------------------------------------------------------
// Highlights

let hl = null; // highlight store (local server or Supabase)

function initHighlights(mode) {
  if (hl) return;
  hl = createHighlightStore(mode);
  hl.on((ev) => {
    refreshReaderHighlights();
    updateSaveButton();
    if (!$("#vault").hidden) renderVault();
    if (ev.type === "palette" && !$("#hl-sheet").hidden) renderSheet();
  });
  hl.load().catch((err) => toast(`Could not load highlights: ${err.message}`));
}

// Layer 2 of the open book: every saved highlight, in its color.
function refreshReaderHighlights() {
  if (!session || !hl) return;
  const list = [];
  for (const h of hl.forDocument(session.item.id)) {
    const a = anchor(session.doc, h);
    if (a) list.push({ id: h.id, start: a.start, end: a.end, hex: colorOf(hl.palette, h.color).hex });
  }
  session.reader.setHighlights(list);
}

const rangeText = (start, end) => session.doc.words.slice(start, end + 1).map((w) => w.display).join(" ");
const lastColor = () => (hl.palette.some((c) => c.id === settings.lastColor) ? settings.lastColor : hl.palette[0].id);

// ---- the highlight menu ----

let sheet = null; // { id, start, end } - id is null until a color is picked

function openNewSheet(start, end) {
  if (!session || !hl) return;
  sheet = { id: null, start, end, note: "" };
  renderSheet();
}

function openEditSheet(id) {
  const h = hl?.all().find((r) => r.id === id);
  const saved = session?.reader.saved.find((s) => s.id === id);
  if (!h || !saved) return;
  session.reader.clearSelection();
  sheet = { id, start: saved.start, end: saved.end, note: h.note || "" };
  renderSheet();
}

function renderSheet() {
  if (!sheet || !session) return;
  const h = sheet.id ? hl.all().find((r) => r.id === sheet.id) : null;
  const text = rangeText(sheet.start, sheet.end);
  const where = describeRange(session.doc, session.chapters, sheet.start, sheet.end);
  const current = h?.color;
  $("#hl-quote").textContent = text.length > 220 ? `${text.slice(0, 217)}…` : text;
  $("#hl-quote").style.setProperty("--hlc", current ? colorOf(hl.palette, current).hex : "var(--accent)");
  $("#hl-path").textContent = `${session.item.title} › ${pathText(where)}`;
  const box = $("#hl-colors");
  box.innerHTML = "";
  for (const c of hl.palette) {
    const b = document.createElement("button");
    b.className = "hl-color";
    b.classList.toggle("on", c.id === current);
    b.style.setProperty("--hlc", c.hex);
    b.innerHTML = "<i></i><span></span>";
    b.querySelector("span").textContent = c.label;
    b.title = c.label;
    b.onclick = () => pickColor(c.id);
    box.append(b);
  }
  if ($("#hl-note") !== document.activeElement) $("#hl-note").value = sheet.note;
  $("#hl-delete").hidden = !h;
  $("#hl-sheet").hidden = false;
}

async function pickColor(color) {
  const s = sheet;
  if (!s) return;
  settings.lastColor = color;
  saveSettings();
  try {
    // A note can create the highlight a moment before a color tap does:
    // wait for that, so the tap changes it instead of making a second one.
    if (s.creating) await s.creating;
    if (s.id) {
      await hl.update(s.id, { color });
    } else {
      s.creating = (async () => {
        await session.chaptersReady;
        const row = await hl.add({ document_id: session.item.id, ...describeRange(session.doc, session.chapters, s.start, s.end), color, note: $("#hl-note").value.trim() });
        s.id = row.id;
        s.note = row.note;
      })();
      await s.creating;
      s.creating = null;
      session.reader.clearSelection();
    }
    if (sheet === s) renderSheet();
  } catch (err) {
    s.creating = null;
    toast(`Could not save: ${err.message}`);
  }
}

async function saveNote() {
  if (!sheet) return;
  const note = $("#hl-note").value.trim();
  if (note === sheet.note) return;
  sheet.note = note;
  if (sheet.id) await hl.update(sheet.id, { note }).catch((err) => toast(`Could not save the note: ${err.message}`));
  else if (note) await pickColor(lastColor()); // a note on new words saves them in the last color
}

$("#hl-note").addEventListener("change", saveNote);
$("#hl-done").onclick = async () => {
  await saveNote();
  closeSheets();
};
$("#hl-close").onclick = () => closeSheets();
$("#hl-delete").onclick = async () => {
  if (!sheet?.id) return;
  try {
    await hl.remove(sheet.id);
    toast("Highlight deleted.");
  } catch (err) {
    toast(err.message);
  }
  closeSheets();
};
$("#hl-play").onclick = () => {
  if (!sheet || !session) return;
  const start = sheet.start;
  closeSheets();
  session.player.seekWord(start, true);
  setFollow(true);
};
$("#hl-copy").onclick = async () => {
  if (!sheet || !session) return;
  const where = describeRange(session.doc, session.chapters, sheet.start, sheet.end);
  await copyText(`"${rangeText(sheet.start, sheet.end)}"\n— ${session.item.title}, ${pathText(where)}`);
};
$("#hl-edit-meanings").onclick = () => openPalette();

// Grow or shrink the words by one, at either end.
document.querySelectorAll("[data-nudge]").forEach((b) => {
  b.onclick = async () => {
    if (!sheet || !session) return;
    const [edge, d] = b.dataset.nudge.split(":");
    const n = Number(d);
    const max = session.doc.words.length - 1;
    if (edge === "start") sheet.start = Math.min(sheet.end, Math.max(0, sheet.start + n));
    else sheet.end = Math.max(sheet.start, Math.min(max, sheet.end + n));
    if (sheet.id) {
      await session.chaptersReady;
      await hl.update(sheet.id, describeRange(session.doc, session.chapters, sheet.start, sheet.end)).catch((err) => toast(err.message));
    } else session.reader.setSelection(sheet.start, sheet.end);
    renderSheet();
  };
});

function closeSheets() {
  sheet = null;
  $("#hl-sheet").hidden = true;
  $("#palette-sheet").hidden = true;
  session?.reader.clearSelection();
}

// ---- "Save this sentence" (for when you only listen) ----

$("#save-sentence").onclick = () => saveCurrentSentence();

async function saveCurrentSentence() {
  if (!session || !hl) return;
  const s = session.doc.sentences[session.player.sentence];
  if (!s) return;
  if (session.reader.saved.some((h) => h.start <= s.first && s.last <= h.end)) return toast("This sentence is already saved.");
  try {
    await session.chaptersReady;
    const color = lastColor();
    await hl.add({ document_id: session.item.id, ...describeRange(session.doc, session.chapters, s.first, s.last), color, note: "" });
    toast(`Saved as "${colorOf(hl.palette, color).label}". Tap it to change.`);
  } catch (err) {
    toast(`Could not save: ${err.message}`);
  }
}

function updateSaveButton() {
  if (!session) return;
  const s = session.doc.sentences[session.player.sentence];
  const saved = !!s && session.reader.saved.some((h) => h.start <= s.first && s.last <= h.end);
  $("#save-sentence").classList.toggle("saved", saved);
}

// ---- what each color means ----

let draftPalette = [];

function openPalette() {
  if (!hl) return;
  draftPalette = hl.palette.map((c) => ({ ...c }));
  $("#hl-sheet").hidden = true;
  renderPalette();
  $("#palette-sheet").hidden = false;
}

function renderPalette() {
  const box = $("#palette-rows");
  box.innerHTML = "";
  $("#palette-error").textContent = "";
  for (const c of draftPalette) {
    const custom = c.id.startsWith("c-");
    const row = document.createElement("div");
    row.className = "palette-row";
    row.style.setProperty("--hlc", c.hex);
    row.innerHTML = `${custom ? '<input type="color" class="swatch" aria-label="Color">' : '<span class="swatch"></span>'}<input type="text" maxlength="24" aria-label="Meaning">${custom ? '<button class="remove" aria-label="Remove color">✕</button>' : "<span></span>"}`;
    const label = row.querySelector('input[type="text"]');
    label.value = c.label;
    label.oninput = () => (c.label = label.value);
    if (custom) {
      const pick = row.querySelector('input[type="color"]');
      pick.value = c.hex;
      pick.oninput = () => {
        c.hex = pick.value;
        row.style.setProperty("--hlc", c.hex);
      };
      row.querySelector(".remove").onclick = () => {
        const used = hl.all().filter((h) => h.color === c.id).length;
        if (used) return ($("#palette-error").textContent = `${used} highlight(s) use "${c.label}". Give them another color first.`);
        draftPalette = draftPalette.filter((x) => x !== c);
        renderPalette();
      };
    }
    box.append(row);
  }
  $("#add-color").disabled = draftPalette.filter((c) => c.id.startsWith("c-")).length >= MAX_CUSTOM;
}

$("#add-color").onclick = () => {
  const check = checkLabel($("#new-label").value);
  if (!check.ok) return ($("#palette-error").textContent = check.error);
  draftPalette.push({ id: `c-${Date.now().toString(36)}`, hex: $("#new-color").value, label: check.value });
  $("#new-label").value = "";
  renderPalette();
};
$("#palette-save").onclick = async () => {
  for (const c of draftPalette) {
    const check = checkLabel(c.label);
    if (!check.ok) return ($("#palette-error").textContent = `${c.label || "A color"}: ${check.error}`);
    c.label = check.value;
  }
  try {
    await hl.savePalette(draftPalette);
    toast("Color meanings saved.");
    $("#palette-sheet").hidden = true;
    if (sheet) renderSheet();
  } catch (err) {
    $("#palette-error").textContent = err.message;
  }
};
$("#palette-close").onclick = () => {
  $("#palette-sheet").hidden = true;
  if (sheet) renderSheet();
};

// ---- the vault: every highlight, with its exact place ----

const vaultFilter = { q: "", book: "", color: "" };

async function showVault(book = "") {
  closeReader();
  hideAll();
  $("#vault").hidden = false;
  vaultFilter.book = book;
  if (!libraryItems.length) libraryItems = await store().list().catch(() => []);
  if (hl && !hl.loaded) await hl.load().catch(() => {});
  renderVault();
}

function vaultRows() {
  const q = vaultFilter.q.toLowerCase();
  return (hl?.all() || []).filter(
    (h) =>
      (!vaultFilter.book || h.document_id === vaultFilter.book) &&
      (!vaultFilter.color || h.color === vaultFilter.color) &&
      (!q || `${h.text} ${h.note} ${h.chapter}`.toLowerCase().includes(q)),
  );
}

const titleOf = (id) => libraryItems.find((i) => i.id === id)?.title || "A removed book";

function renderVault() {
  const all = hl?.all() || [];
  // Book picker: only books that have highlights.
  const sel = $("#vault-book");
  const books = [...new Set(all.map((h) => h.document_id))];
  sel.innerHTML = "";
  sel.append(new Option(`All books (${books.length})`, ""));
  for (const id of books) sel.append(new Option(titleOf(id), id));
  sel.value = books.includes(vaultFilter.book) ? vaultFilter.book : "";

  const chips = $("#vault-colors");
  chips.innerHTML = "";
  const chip = (id, label, hex, count) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.classList.toggle("on", vaultFilter.color === id);
    if (hex) b.style.setProperty("--hlc", hex);
    b.innerHTML = `${hex ? "<i></i>" : ""}<span></span> <small>${count}</small>`;
    b.querySelector("span").textContent = label;
    b.onclick = () => {
      vaultFilter.color = vaultFilter.color === id ? "" : id;
      renderVault();
    };
    chips.append(b);
  };
  chip("", "All colors", null, all.length);
  for (const c of hl?.palette || []) chip(c.id, c.label, c.hex, all.filter((h) => h.color === c.id).length);

  const rows = vaultRows();
  $("#vault-count").textContent = rows.length === 1 ? "1 highlight" : `${rows.length} highlights`;
  $("#vault-empty").hidden = all.length > 0;
  const list = $("#vault-list");
  list.innerHTML = "";
  const order = [...libraryItems.map((i) => i.id), ...books];
  const byBook = new Map();
  for (const id of order) if (!byBook.has(id)) byBook.set(id, rows.filter((h) => h.document_id === id).sort((a, b) => a.start_word - b.start_word));
  for (const [docId, items] of byBook) {
    if (!items.length) continue;
    const sec = document.createElement("section");
    sec.className = "vault-book";
    sec.innerHTML = `<div class="vault-book-head"><h2></h2><button class="btn small">▶ Play reel (${items.length})</button></div>`;
    sec.querySelector("h2").textContent = titleOf(docId);
    sec.querySelector("button").onclick = () => playReel(docId, items);
    let chapter = null;
    for (const h of items) {
      if (h.chapter !== chapter) {
        chapter = h.chapter;
        if (chapter) {
          const ch = document.createElement("h3");
          ch.className = "vault-ch";
          ch.textContent = chapter;
          sec.append(ch);
        }
      }
      sec.append(vaultCard(h));
    }
    list.append(sec);
  }
}

function vaultCard(h) {
  const c = colorOf(hl.palette, h.color);
  const card = document.createElement("article");
  card.className = "hl-card";
  card.style.setProperty("--hlc", c.hex);
  card.innerHTML = `<div class="path"></div><blockquote></blockquote>${h.note ? '<p class="hl-note-text"></p>' : ""}
    <div class="hl-card-actions"><button data-a="open">Open here</button><button data-a="listen">▶ Listen</button><button data-a="copy">Copy</button><button data-a="delete">Delete</button></div>`;
  const path = card.querySelector(".path");
  const tag = document.createElement("span");
  tag.className = "chip";
  tag.style.setProperty("--hlc", c.hex);
  tag.innerHTML = "<i></i><span></span>";
  tag.querySelector("span").textContent = c.label;
  const where = document.createElement("span");
  where.textContent = [h.page ? `p. ${h.page}` : "", h.paragraph ? `¶ ${h.paragraph}` : ""].filter(Boolean).join(" · ");
  path.append(tag, where);
  card.querySelector("blockquote").textContent = h.text;
  if (h.note) card.querySelector(".hl-note-text").textContent = h.note;
  card.querySelector('[data-a="open"]').onclick = () => openHere(h);
  card.querySelector('[data-a="listen"]').onclick = () => playReel(h.document_id, [h]);
  card.querySelector('[data-a="copy"]').onclick = () => copyText(`"${h.text}"\n— ${titleOf(h.document_id)}, ${pathText(h)}`);
  card.querySelector('[data-a="delete"]').onclick = async () => {
    if (!confirm("Delete this highlight?")) return;
    await hl.remove(h.id).catch((err) => toast(err.message));
  };
  return card;
}

function openHere(h) {
  const item = libraryItems.find((i) => i.id === h.document_id);
  if (!item) return toast("That book is not in your library any more.");
  openItem(item, { highlight: h });
}

$("#vault-btn").onclick = () => showVault();
$("#vault-back").onclick = () => showLibrary();
$("#reader-vault").onclick = () => showVault(session?.item.id || "");
$("#vault-meanings").onclick = () => openPalette();
$("#vault-search").oninput = (e) => {
  vaultFilter.q = e.target.value;
  renderVault();
};
$("#vault-book").onchange = (e) => {
  vaultFilter.book = e.target.value;
  renderVault();
};
$("#vault-export").onclick = async () => {
  const rows = vaultRows();
  if (!rows.length) return toast("Nothing to export yet.");
  const md = toMarkdown(rows, titleOf, hl.palette, (h) => `${location.origin}/#open=${h.document_id}&w=${h.start_word}`);
  const name = `readaloud-highlights-${new Date().toISOString().slice(0, 10)}.md`;
  const file = new File([md], name, { type: "text/markdown" });
  // Phones: the share sheet (save to Files, Notes, Notion…). PCs: a download.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      return await navigator.share({ files: [file], title: "My highlights" });
    } catch (err) {
      if (err.name === "AbortError") return;
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(file);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
};

// Links from the export: #open=<book id>&w=<word>
function openDeepLink() {
  const m = location.hash.match(/^#open=([0-9a-f-]{36})&w=(\d+)/);
  if (!m) return;
  history.replaceState(null, "", location.pathname);
  const item = libraryItems.find((i) => i.id === m[1]);
  if (!item) return toast("That book is not in this library.");
  const word = Number(m[2]);
  const h = hl?.all().find((r) => r.document_id === item.id && r.start_word === word);
  openItem(item, h ? { highlight: h } : { word });
}

// ---- the highlight reel: only your highlights, one after another ----

let reel = null; // { clips: [{ start, end, color }], i, gap }

function playReel(docId, highlights) {
  const item = libraryItems.find((i) => i.id === docId);
  if (!item) return toast("That book is not in your library any more.");
  const list = [...highlights].sort((a, b) => a.start_word - b.start_word);
  if (session?.item.id === docId) {
    hideAll();
    $("#reader").hidden = false;
    return startReel(list, { autoplay: true });
  }
  openItem(item, { reel: list });
}

function startReel(highlights, { autoplay }) {
  if (!session) return;
  const clips = [];
  for (const h of highlights) {
    const a = anchor(session.doc, h);
    if (a) clips.push({ start: a.start, end: a.end, color: h.color });
  }
  if (!clips.length) return toast("These highlights could not be found in the book.");
  reel = { clips, i: 0, gap: false };
  $("#reel-bar").hidden = false;
  playClip(0, autoplay);
  if (!autoplay) toast("Highlight reel ready. Tap ▶ to start.", 5000);
}

function playClip(i, autoplay = true) {
  if (!reel || !session) return;
  if (i >= reel.clips.length) return finishReel();
  reel.i = i;
  const c = reel.clips[i];
  const color = colorOf(hl.palette, c.color);
  $("#reel-text").textContent = `Highlight reel · ${i + 1} of ${reel.clips.length} · ${color.label}`;
  $("#reel-bar").style.setProperty("--hlc", color.hex);
  reel.gap = true;
  session.player.seekWord(c.start, autoplay);
  reel.gap = false;
  setFollow(true);
}

// Called on every spoken word: at the end of a clip, go to the next one.
function checkReel() {
  if (!reel || reel.gap || !session) return;
  const w = session.player.word;
  const c = reel.clips[reel.i];
  if (w >= c.start && w <= c.end) return;
  if (w > c.end && w <= c.end + 4) {
    // A short breath between clips, like a page turn.
    reel.gap = true;
    session.player.pause();
    setTimeout(() => reel && playClip(reel.i + 1), 700);
  } else stopReel("Reel stopped: you jumped to another place.");
}

function finishReel() {
  if (!reel) return;
  const n = reel.clips.length;
  session?.player.pause();
  stopReel(`Reel finished: ${n === 1 ? "1 highlight" : `${n} highlights`}.`);
}

function stopReel(message) {
  if (!reel) return;
  reel = null;
  $("#reel-bar").hidden = true;
  if (message) toast(message);
}

$("#reel-prev").onclick = () => reel && playClip(Math.max(0, reel.i - 1));
$("#reel-next").onclick = () => reel && playClip(reel.i + 1);
$("#reel-stop").onclick = () => {
  session?.player.pause();
  stopReel();
};

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied.");
  } catch {
    toast("Could not copy on this device.");
  }
}

// ---- keyboard ----

document.addEventListener("keydown", (e) => {
  if (!session || e.target.closest("input, select, textarea") || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.code === "Space") {
    e.preventDefault();
    session.player.toggle();
  } else if (e.key === "ArrowRight") session.player.skipSentence(1);
  else if (e.key === "ArrowLeft") session.player.skipSentence(-1);
  else if (e.key === "ArrowUp") {
    e.preventDefault();
    setSpeed(session.player.speed + 0.25);
  } else if (e.key === "ArrowDown") {
    e.preventDefault();
    setSpeed(session.player.speed - 0.25);
  } else if (e.key === "s" || e.key === "S") saveCurrentSentence();
  else if (e.key === "Escape") {
    document.querySelectorAll(".pop").forEach((p) => (p.hidden = true));
    closeSheets();
  }
});
window.addEventListener("beforeunload", savePositionNow);
// Phones rarely fire beforeunload; leaving the app does fire this.
document.addEventListener("visibilitychange", () => document.visibilityState === "hidden" && savePositionNow());

// ---- helpers ----

let toastTimer;
function toast(msg, ms = 3500) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), ms);
}
function fmtTime(sec) {
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min` : `${sec} s`;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// PDF.js 6 closes a document through its loading task.
function closePdf(pdf) {
  try {
    (pdf.loadingTask || pdf).destroy?.();
  } catch {}
}

boot();
