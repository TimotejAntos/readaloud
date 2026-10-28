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
import { downloadRange, nextChapter } from "./offline.js";
import { openPdf } from "./pdf.js";
import { Player, systemVoices } from "./player.js";
import { Reader } from "./reader.js";

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
  }
  showLibrary();
}

function startCloud() {
  cloud.startLive();
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
  for (const id of ["#signin", "#library", "#reader"]) $(id).hidden = true;
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

async function openItem(item) {
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
  });
  reader.highlight = settings.highlight;
  session = { item, pdf, doc, player, reader, follow: true };

  player.speed = settings.speed;
  player.voice = settings.voice;
  player.systemVoice = settings.systemVoice;
  player.setEngine(engineKind(), { documentId: item.id });
  reader.setView(settings.view);

  const start = Math.min(item.position?.word || 0, Math.max(0, doc.words.length - 1));
  player.seekWord(start, false);
  reader.setActive(player.word, player.sentence);
  requestAnimationFrame(() => reader.follow(false));

  player.addEventListener("word", () => {
    reader.setActive(player.word, player.sentence);
    if (session.follow) reader.follow();
    updateProgress();
    savePositionSoon();
  });
  player.addEventListener("state", (e) => {
    updatePlayButton();
    updateMediaSession();
    if (e.detail?.error && e.detail.error !== "cancelled") toast(e.detail.error, 6000);
    if (player.state === "paused" || player.state === "ended") savePositionNow();
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
  if (!doc.words.length) toast("No text found. This looks like a scanned PDF.");
}

function closeReader() {
  if (!session) return;
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
    previoustrack: () => session?.player.skipSentence(-1),
    nexttrack: () => session?.player.skipSentence(1),
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
  } else if (e.key === "Escape") document.querySelectorAll(".pop").forEach((p) => (p.hidden = true));
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
