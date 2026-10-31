// Cloud mode: Supabase holds the library, the reading position, the voice
// jobs and the audio. Shapes and paths follow docs/CLOUD-CONTRACT.md.
//
//   ra_documents    one row per PDF (+ position, synced live)
//   ra_render_jobs  "please voice these sentences" (the phone writes them)
//   ra_audio        finished sentence audio + speech marks (engines write them)
//   bucket readaloud: pdfs/{uid}/{id}.pdf · docs/{uid}/{id}.json · audio/{uid}/{engine}/{voice}/{key}.mp3
//
// supabase-js is loaded as a classic script (window.supabase), see index.html.

import { BUCKET, CLOUD_READY, SUPABASE_KEY, SUPABASE_URL } from "./config.js";
import { packDocument, unpackDocument } from "./document.js";

const FILES = "ra-files"; // Cache Storage: PDFs, parsed docs, offline audio + marks
const DEVICE_ID = (() => {
  try {
    let id = localStorage.getItem("readaloud.device");
    if (!id) localStorage.setItem("readaloud.device", (id = crypto.randomUUID().slice(0, 8)));
    return id;
  } catch {
    return crypto.randomUUID().slice(0, 8);
  }
})();

export const deviceId = DEVICE_ID;
export let client = null;
export let user = null;

export function init() {
  if (client) return client;
  if (!CLOUD_READY) throw new Error("Cloud is not set up yet. Copy public/js/supabase-config.example.js to supabase-config.js (see README).");
  client = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "implicit" },
  });
  client.auth.onAuthStateChange((_event, session) => {
    user = session?.user ?? null;
    if (session) client.realtime.setAuth(session.access_token);
  });
  return client;
}

export async function currentUser() {
  init();
  const { data } = await client.auth.getSession();
  user = data.session?.user ?? null;
  return user;
}

// ---------------------------------------------------------------- sign-in

// Magic link. shouldCreateUser: false = only existing accounts can sign in,
// so a typo never creates a stranger account in this shared project.
export async function sendLink(email) {
  init();
  const redirect = location.origin + location.pathname;
  const { error } = await client.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: redirect } });
  if (error) throw new Error(/signups? not allowed|not found/i.test(error.message) ? "No ReadAloud account for that email." : error.message);
}

// Email + password. Works only for accounts that already exist (no sign-up here).
export async function signInWithPassword(email, password) {
  init();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(/invalid login credentials/i.test(error.message) ? "Wrong email or password." : error.message);
}

export async function setPassword(password) {
  const { error } = await client.auth.updateUser({ password });
  if (error) throw new Error(/same/i.test(error.message) ? "That is already your password." : error.message);
}

// For the installed phone app: a tapped email link opens the normal browser,
// not the app. So the app also accepts the pasted link (or a 6-digit code).
export async function signInWithPasted(text, email) {
  init();
  text = text.trim();
  if (/^\d{6,10}$/.test(text)) {
    const { error } = await client.auth.verifyOtp({ email, token: text, type: "email" });
    if (error) throw error;
    return;
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error("That is not a link or a code.");
  }
  const hash = new URLSearchParams(url.hash.slice(1));
  if (hash.get("access_token")) {
    const { error } = await client.auth.setSession({ access_token: hash.get("access_token"), refresh_token: hash.get("refresh_token") });
    if (error) throw error;
    return;
  }
  const token_hash = url.searchParams.get("token") || url.searchParams.get("token_hash");
  if (!token_hash) throw new Error("No sign-in code in that link.");
  const type = url.searchParams.get("type") === "magiclink" ? "magiclink" : "email";
  let { error } = await client.auth.verifyOtp({ token_hash, type });
  if (error && type === "magiclink") ({ error } = await client.auth.verifyOtp({ token_hash, type: "email" }));
  if (error) throw new Error(/expired|invalid/i.test(error.message) ? "That link is used or too old. Send a new one." : error.message);
}

export async function signOut() {
  await client.auth.signOut();
  user = null;
}

// ---------------------------------------------------------------- library

const COLS = "id,title,file_name,bytes,pages,words,pdf_path,doc_path,position,created_at,opened_at,updated_at";

export async function listDocuments() {
  const { data, error } = await client.from("ra_documents").select(COLS).order("opened_at", { ascending: false, nullsFirst: false }).order("created_at", { ascending: false });
  if (error) throw error;
  return data;
}

export async function uploadPdf(file, { id = crypto.randomUUID(), title, position, openedAt } = {}) {
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  if (String.fromCharCode(...head) !== "%PDF-") throw new Error("That file is not a PDF.");
  if (file.size > 50 * 1024 * 1024) throw new Error("Too big. The free plan takes PDFs up to 50 MB.");
  const pdf_path = `pdfs/${user.id}/${id}.pdf`;
  const up = await client.storage.from(BUCKET).upload(pdf_path, file, { contentType: "application/pdf", upsert: true });
  if (up.error) throw up.error;
  const name = file.name || "document.pdf";
  const row = {
    id,
    title: title || name.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim() || "Untitled",
    file_name: name,
    bytes: file.size,
    pdf_path,
    position: position || { word: 0 },
    opened_at: openedAt || null,
  };
  const { data, error } = await client.from("ra_documents").upsert(row).select(COLS).single();
  if (error) throw error;
  return data;
}

export async function patchDocument(id, fields) {
  const { error } = await client.from("ra_documents").update(fields).eq("id", id);
  if (error) throw error;
}

export async function removeDocument(item) {
  const paths = [item.pdf_path, item.doc_path].filter(Boolean);
  if (paths.length) await client.storage.from(BUCKET).remove(paths);
  const { error } = await client.from("ra_documents").delete().eq("id", item.id);
  if (error) throw error;
  const cache = await openCache();
  for (const p of paths) await cache?.delete(cacheUrl(p));
}

export function savePosition(id, word) {
  return patchDocument(id, { position: { word, device: DEVICE_ID, at: new Date().toISOString() } }).catch(() => {});
}

// ---------------------------------------------------------------- files (with an on-device copy)

export async function pdfBytes(item) {
  return (await cachedFile(item.pdf_path, "application/pdf")).arrayBuffer();
}

// The parsed document, or null if no device has parsed it yet.
export async function loadDoc(item) {
  if (!item.doc_path) return null;
  try {
    const blob = await cachedFile(item.doc_path, "application/json");
    return unpackDocument(JSON.parse(await blob.text()));
  } catch {
    return null;
  }
}

// Parse once, save for every device.
export async function saveDoc(item, doc) {
  const doc_path = `docs/${user.id}/${item.id}.json`;
  const body = new Blob([JSON.stringify(packDocument(doc))], { type: "application/json" });
  const up = await client.storage.from(BUCKET).upload(doc_path, body, { contentType: "application/json", upsert: true });
  if (up.error) throw up.error;
  await (await openCache())?.put(cacheUrl(doc_path), new Response(body));
  await patchDocument(item.id, { doc_path, pages: doc.numPages, words: doc.words.length });
  item.doc_path = doc_path;
}

async function cachedFile(path, type) {
  const cache = await openCache();
  const hit = await cache?.match(cacheUrl(path));
  if (hit) return hit.blob();
  const { data, error } = await client.storage.from(BUCKET).download(path);
  if (error) throw new Error(navigator.onLine ? error.message || "Download failed." : "You are offline, and this file is not on the phone yet.");
  const blob = data.type ? data : new Blob([data], { type });
  await cache?.put(cacheUrl(path), new Response(blob));
  return blob;
}

function cacheUrl(path) {
  return `${location.origin}/_ra/${path}`;
}
async function openCache() {
  try {
    return await caches.open(FILES);
  } catch {
    return null; // private mode or no Cache Storage
  }
}

// ---------------------------------------------------------------- audio

export async function audioKey(engine, voice, text) {
  const norm = text.replace(/\s+/g, " ").trim();
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`${engine}|${voice}|${norm}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// key -> ra_audio row, for the keys that exist (online) or are saved offline.
export async function findAudio(keys) {
  const found = new Map();
  const cache = await openCache();
  for (const k of keys) {
    const hit = await cache?.match(cacheUrl(`marks/${k}`));
    if (hit) found.set(k, await hit.json());
  }
  const missing = keys.filter((k) => !found.has(k));
  if (missing.length && navigator.onLine) {
    const { data, error } = await client.from("ra_audio").select("key,engine,voice,audio_path,format,duration_ms,marks").in("key", missing);
    if (error) throw error;
    for (const row of data) found.set(row.key, row);
  }
  return found;
}

export async function audioBlob(row) {
  return cachedOrFetch(row.audio_path, "audio/mpeg", false);
}

// Keep a sentence on the phone for offline listening (audio + marks).
export async function keepOffline(row) {
  const cache = await openCache();
  if (!cache) throw new Error("This browser cannot store files.");
  await cachedOrFetch(row.audio_path, "audio/mpeg", true);
  await cache.put(cacheUrl(`marks/${row.key}`), new Response(JSON.stringify(row), { headers: { "content-type": "application/json" } }));
}

async function cachedOrFetch(path, type, store) {
  const cache = await openCache();
  const hit = await cache?.match(cacheUrl(path));
  if (hit) return hit.blob();
  const { data, error } = await client.storage.from(BUCKET).download(path);
  if (error) throw new Error(error.message || "Audio download failed.");
  const blob = data.type === type ? data : new Blob([data], { type });
  if (store) await cache?.put(cacheUrl(path), new Response(blob));
  return blob;
}

export async function createJob({ documentId, engine, voice, items }) {
  const { data, error } = await client
    .from("ra_render_jobs")
    .insert({ user_id: user.id, document_id: documentId, engine, voice, items, status: "queued" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id;
}

// Drop jobs nobody needs any more (the reader jumped elsewhere).
export async function cancelJobs(ids) {
  if (ids.length) await client.from("ra_render_jobs").delete().in("id", ids).in("status", ["queued", "working"]);
}

export async function jobStatus(ids) {
  if (!ids.length) return [];
  const { data } = await client.from("ra_render_jobs").select("id,status,error").in("id", ids);
  return data || [];
}

const FUNCTION_OF = { kokoro_api: "ra-engine-kokoro-api", modal: "ra-engine-modal" };

export async function invokeEngine(engine, jobId) {
  const { error } = await client.functions.invoke(FUNCTION_OF[engine], { body: { job_id: jobId } });
  if (error) {
    // A function that is not deployed fails the browser's CORS check
    // (FunctionsFetchError) or answers 404.
    const status = error.context?.status;
    if (status === 404 || error.name === "FunctionsFetchError") throw new Error("not ready");
    throw new Error((await error.context?.json?.().catch(() => null))?.error || error.message);
  }
}

// ---------------------------------------------------------------- highlights

const HCOLS = "id,document_id,start_word,end_word,text,prefix,suffix,color,note,chapter,page,paragraph,explained_message_id,created_at,updated_at";

export async function listHighlights(documentId) {
  let q = client.from("ra_highlights").select(HCOLS).order("created_at", { ascending: true });
  if (documentId) q = q.eq("document_id", documentId);
  const { data, error } = await q;
  if (error) throw error;
  return data;
}

export async function addHighlight(row) {
  const { data, error } = await client.from("ra_highlights").insert({ ...row, user_id: user.id }).select(HCOLS).single();
  if (error) throw error;
  return data;
}

export async function updateHighlight(id, patch) {
  const { data, error } = await client.from("ra_highlights").update(patch).eq("id", id).select(HCOLS).single();
  if (error) throw error;
  return data;
}

export async function removeHighlight(id) {
  const { error } = await client.from("ra_highlights").delete().eq("id", id);
  if (error) throw error;
}

// The colors and what they mean, the same on every device. null = never saved.
export async function getPalette() {
  const { data, error } = await client.from("ra_user_settings").select("palette").eq("user_id", user.id).maybeSingle();
  if (error) throw error;
  return data?.palette?.length ? data.palette : null;
}

export async function savePalette(palette) {
  const { error } = await client.from("ra_user_settings").upsert({ user_id: user.id, palette });
  if (error) throw error;
}

// ---------------------------------------------------------------- tutor (docs/TUTOR.md)

// How many pieces of this book exist, and how many still need search numbers.
export async function chunkStatus(documentId) {
  const all = await client.from("ra_chunks").select("id", { count: "exact", head: true }).eq("document_id", documentId);
  if (all.error) throw all.error;
  const left = await client.from("ra_chunks").select("id", { count: "exact", head: true }).eq("document_id", documentId).is("embedding", null);
  if (left.error) throw left.error;
  return { total: all.count ?? 0, left: left.count ?? 0 };
}

export async function addChunks(documentId, chunks) {
  for (let i = 0; i < chunks.length; i += 100) {
    const rows = chunks.slice(i, i + 100).map((c) => ({ ...c, document_id: documentId, user_id: user.id }));
    const { error } = await client.from("ra_chunks").upsert(rows, { onConflict: "document_id,chunk_no", ignoreDuplicates: true });
    if (error) throw error;
  }
}

// One round of search numbers (the function does a small batch per call).
export async function indexChunks(documentId) {
  const { data, error } = await client.functions.invoke("ra-tutor-index", { body: { document_id: documentId } });
  if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error || error.message);
  return data; // { made, left }
}

// Ask the tutor. onLine gets each JSON line: meta, text, done, error.
export async function askTutor(body, onLine) {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) throw new Error("Please sign in again.");
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ra-tutor`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, apikey: SUPABASE_KEY, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const err = await res.json().catch(() => null);
    throw new Error(err?.error || (res.status === 404 ? "The tutor is not deployed yet." : `Tutor error ${res.status}`));
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onLine(JSON.parse(line));
    }
  }
  if (buf.trim()) onLine(JSON.parse(buf));
}

// The newest chat for this book (documentId = null: the "all my books" chat).
export async function latestThread(documentId) {
  let q = client.from("ra_tutor_threads").select("id,document_id,title,updated_at").order("updated_at", { ascending: false }).limit(1);
  q = documentId ? q.eq("document_id", documentId) : q.is("document_id", null);
  const { data, error } = await q;
  if (error) throw error;
  return data?.[0] || null;
}

export async function threadMessages(threadId) {
  const { data, error } = await client.from("ra_tutor_messages").select("id,role,content,parts,sources,created_at").eq("thread_id", threadId).order("created_at");
  if (error) throw error;
  return data || [];
}

// The learner profile: how the tutor should teach this user.
export async function getTutorProfile() {
  const { data, error } = await client.from("ra_user_settings").select("tutor").eq("user_id", user.id).maybeSingle();
  if (error) throw error;
  return data?.tutor || {};
}

export async function saveTutorProfile(tutor) {
  const { error } = await client.from("ra_user_settings").upsert({ user_id: user.id, tutor });
  if (error) throw error;
}

// The chat a tutor message belongs to (to show a saved explanation again).
export async function messageThread(messageId) {
  const { data, error } = await client.from("ra_tutor_messages").select("thread_id").eq("id", messageId).maybeSingle();
  if (error) throw error;
  return data?.thread_id || null;
}

// ---------------------------------------------------------------- quizzes

const QCOLS = "id,document_id,scope,title,questions,answers,score,total,created_at,finished_at";

// body = { document_id, scope, count, chapter?, word?, ranges? }. Takes 10–40 s.
export async function makeQuiz(body) {
  const { data, error } = await client.functions.invoke("ra-tutor-quiz", { body });
  if (error) throw new Error((await error.context?.json?.().catch(() => null))?.error || error.message);
  return data.quiz;
}

export async function listQuizzes(documentId) {
  const { data, error } = await client.from("ra_quizzes").select(QCOLS).eq("document_id", documentId).order("created_at", { ascending: false }).limit(20);
  if (error) throw error;
  return data || [];
}

// The same questions again, as a new attempt.
export async function retakeQuiz(quiz) {
  const { data, error } = await client
    .from("ra_quizzes")
    .insert({ user_id: user.id, document_id: quiz.document_id, scope: quiz.scope, title: quiz.title, questions: quiz.questions, total: quiz.total })
    .select(QCOLS)
    .single();
  if (error) throw error;
  return data;
}

export async function saveQuizAnswers(id, answers, done) {
  const patch = { answers };
  if (done) Object.assign(patch, { score: done.score, finished_at: new Date().toISOString() });
  const { error } = await client.from("ra_quizzes").update(patch).eq("id", id);
  if (error) throw error;
}

// ---------------------------------------------------------------- live updates

let channel = null;
const listeners = { audio: new Set(), job: new Set(), document: new Set(), engines: new Set(), highlight: new Set(), palette: new Set() };
let enginesOnline = new Set();

export function on(type, fn) {
  listeners[type].add(fn);
  return () => listeners[type].delete(fn);
}

export function startLive() {
  if (channel || !user) return;
  const f = `user_id=eq.${user.id}`;
  channel = client
    .channel(`ra-user-${user.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ra_audio", filter: f }, (p) => emit("audio", p.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "ra_render_jobs", filter: f }, (p) => emit("job", p.new))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "ra_documents", filter: f }, (p) => emit("document", p.new))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ra_highlights", filter: f }, (p) => emit("highlight", { type: "upsert", row: p.new }))
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "ra_highlights", filter: f }, (p) => emit("highlight", { type: "upsert", row: p.new }))
    // Realtime cannot filter deletes; the payload is only the id.
    .on("postgres_changes", { event: "DELETE", schema: "public", table: "ra_highlights" }, (p) => p.old?.id && emit("highlight", { type: "delete", id: p.old.id }))
    .on("postgres_changes", { event: "*", schema: "public", table: "ra_user_settings", filter: f }, (p) => p.new?.palette && emit("palette", p.new.palette))
    .subscribe();

  // The PC worker announces itself here ("presence"), so the phone knows
  // whether the PC voice is switched on.
  const lobby = client.channel("ra-engines", { config: { presence: { key: DEVICE_ID } } });
  lobby
    .on("presence", { event: "sync" }, () => {
      enginesOnline = new Set(Object.values(lobby.presenceState()).flat().map((m) => m.engine).filter(Boolean));
      emit("engines", enginesOnline);
    })
    .subscribe();
}

export function stopLive() {
  if (!channel) return;
  client.removeAllChannels();
  channel = null;
}

export function isOnline(engine) {
  return enginesOnline.has(engine);
}

// Is an engine usable right now? -> { ok, note }
export async function engineStatus(engine) {
  if (engine === "device") return { ok: true };
  if (!navigator.onLine) return { ok: false, note: "Offline. Only saved chapters and the phone voice work." };
  if (engine === "pc") {
    return enginesOnline.has("pc") ? { ok: true, note: "PC voice is on." } : { ok: false, note: "PC voice is off. On the PC: the service key must be in pc-worker/.env, then double-click start.cmd." };
  }
  // Edge Function engines: a call to a function that is not deployed answers 404.
  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/${FUNCTION_OF[engine]}`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: SUPABASE_KEY, authorization: `Bearer ${(await client.auth.getSession()).data.session?.access_token}` },
      body: JSON.stringify({ ping: true }),
    });
    if (res.status === 404 && /not found/i.test(await res.text())) return { ok: false, note: "Not ready yet: this engine is still being built." };
    return { ok: true };
  } catch {
    return { ok: false, note: "Not ready yet: this engine is still being built." };
  }
}

function emit(type, payload) {
  for (const fn of listeners[type]) {
    try {
      fn(payload);
    } catch (err) {
      console.error(err);
    }
  }
}
