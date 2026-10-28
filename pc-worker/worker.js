// ReadAloud PC voice worker (engine "pc", docs/CLOUD-CONTRACT.md).
//
// Listens for ra_render_jobs with engine = "pc", makes each sentence with
// the Kokoro code in server/tts.js, encodes MP3 (mono, 24 kHz, 40 kbps) with
// ffmpeg, uploads it to audio/{user}/pc/{voice}/{key}.mp3 and inserts the
// ra_audio row. The phone hears that insert over Realtime and plays.
//
// Runs inside the ReadAloud server (start.cmd), or alone:
//   node --use-system-ca pc-worker/worker.js
//   node --use-system-ca pc-worker/worker.js --selftest "Hello there."   (no Supabase; writes an mp3)
//
// Needs pc-worker/.env with SUPABASE_SERVICE_ROLE_KEY (see .env.example).

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import * as tts from "../server/tts.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUCKET = "readaloud";
const ENGINE = "pc";
const BITRATE = "40k";

function loadEnv() {
  const env = {};
  try {
    for (const line of readFileSync(path.join(HERE, ".env"), "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {}
  return {
    url: process.env.SUPABASE_URL || env.SUPABASE_URL || "",
    key: process.env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "",
    ffmpeg: process.env.FFMPEG_PATH || env.FFMPEG_PATH || "ffmpeg",
  };
}

export function audioKey(voice, text) {
  return createHash("sha1").update(`${ENGINE}|${voice}|${tts.normalizeText(text)}`).digest("hex");
}

// ---- mp3 ----------------------------------------------------------------

function checkFfmpeg(bin) {
  const r = spawnSync(bin, ["-hide_banner", "-version"], { encoding: "utf8" });
  return r.status === 0;
}

export function encodeMp3(samples, sampleRate, bin = "ffmpeg") {
  return new Promise((resolve, reject) => {
    const ff = spawn(bin, ["-hide_banner", "-loglevel", "error", "-f", "f32le", "-ar", String(sampleRate), "-ac", "1", "-i", "pipe:0", "-c:a", "libmp3lame", "-b:a", BITRATE, "-ar", "24000", "-ac", "1", "-f", "mp3", "pipe:1"]);
    const out = [];
    let err = "";
    ff.stdout.on("data", (c) => out.push(c));
    ff.stderr.on("data", (c) => (err += c));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed: ${err.trim() || code}`))));
    ff.stdin.end(Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength));
  });
}

// ---- worker -------------------------------------------------------------

const log = (...a) => console.log(`[pc-worker ${new Date().toLocaleTimeString()}]`, ...a);

export async function startWorker({ quietIfNoKey = false } = {}) {
  const env = loadEnv();
  if (!env.key) {
    if (!quietIfNoKey) console.log("[pc-worker] No SUPABASE_SERVICE_ROLE_KEY in pc-worker/.env. See pc-worker/.env.example.");
    else console.log("[pc-worker] off (no pc-worker/.env). Local mode works as before.");
    return null;
  }
  if (!env.url) {
    console.log("[pc-worker] No SUPABASE_URL in pc-worker/.env. See pc-worker/.env.example.");
    return null;
  }
  if (!checkFfmpeg(env.ffmpeg)) {
    console.error("[pc-worker] ffmpeg not found. Install it (winget install Gyan.FFmpeg) or set FFMPEG_PATH in pc-worker/.env.");
    return null;
  }

  const db = createClient(env.url, env.key, { auth: { persistSession: false, autoRefreshToken: false } });
  const queue = [];
  const known = new Set();
  let busy = false;

  const enqueue = (job) => {
    if (known.has(job.id)) return;
    known.add(job.id);
    queue.push(job);
    pump();
  };

  async function pump() {
    if (busy) return;
    busy = true;
    while (queue.length) {
      const job = queue.shift();
      try {
        await runJob(job);
      } catch (err) {
        log("job failed", job.id, err.message);
        await db.from("ra_render_jobs").update({ status: "error", error: String(err.message).slice(0, 300) }).eq("id", job.id);
      }
      known.delete(job.id);
    }
    busy = false;
  }

  async function runJob(job) {
    // Claim it. If someone else (or the phone, by cancelling) got there first, skip.
    const { data: claimed } = await db.from("ra_render_jobs").update({ status: "working" }).eq("id", job.id).eq("status", "queued").select("id");
    if (!claimed?.length) return;
    if (!tts.VOICES.some((v) => v.id === job.voice)) throw new Error(`unknown voice ${job.voice}`);
    const items = Array.isArray(job.items) ? job.items : [];
    const t0 = Date.now();
    let made = 0;
    for (const item of items) {
      const text = tts.normalizeText(item.text);
      if (!text) continue;
      // The phone deletes jobs it no longer needs (the reader jumped away).
      const { data: still } = await db.from("ra_render_jobs").select("id").eq("id", job.id).maybeSingle();
      if (!still) return log(`job ${job.id.slice(0, 8)} cancelled after ${made}/${items.length}`);
      const key = audioKey(job.voice, text);
      const { data: have } = await db.from("ra_audio").select("key").eq("key", key).maybeSingle();
      if (have) continue;

      const out = await tts.render(text, job.voice);
      const mp3 = await encodeMp3(out.samples, out.sampleRate, env.ffmpeg);
      const audio_path = `audio/${job.user_id}/${ENGINE}/${job.voice}/${key}.mp3`;
      const up = await db.storage.from(BUCKET).upload(audio_path, mp3, { contentType: "audio/mpeg", upsert: true });
      if (up.error) throw new Error(`upload: ${up.error.message}`);
      const { error } = await db.from("ra_audio").upsert(
        { key, user_id: job.user_id, engine: ENGINE, voice: job.voice, audio_path, format: "mp3", duration_ms: out.speechMarks.endTime, marks: out.speechMarks },
        { onConflict: "key", ignoreDuplicates: true },
      );
      if (error) throw new Error(`ra_audio: ${error.message}`);
      made++;
    }
    await db.from("ra_render_jobs").update({ status: "done" }).eq("id", job.id);
    log(`job ${job.id.slice(0, 8)} done: ${made} new of ${items.length} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }

  // Jobs that came in while the PC was off (or a Realtime message we missed).
  async function sweep() {
    const { data, error } = await db.from("ra_render_jobs").select("*").eq("engine", ENGINE).eq("status", "queued").order("created_at").limit(50);
    if (error) return log("sweep failed:", error.message);
    for (const job of data) enqueue(job);
    // A job stuck in "working" for 3 minutes was left by a crashed run.
    const old = new Date(Date.now() - 180000).toISOString();
    await db.from("ra_render_jobs").update({ status: "queued" }).eq("engine", ENGINE).eq("status", "working").lt("updated_at", old);
  }

  db.channel("ra-pc-jobs")
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "ra_render_jobs", filter: `engine=eq.${ENGINE}` }, (p) => enqueue(p.new))
    .subscribe((status) => {
      if (status === "SUBSCRIBED") {
        log("listening for phone jobs");
        sweep();
      } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") log("realtime:", status, "(will retry)");
    });

  // Tell the phones "the PC voice is on" (Realtime presence).
  const lobby = db.channel("ra-engines", { config: { presence: { key: `pc-${os.hostname()}` } } });
  lobby.subscribe((status) => {
    if (status === "SUBSCRIBED") lobby.track({ engine: ENGINE, host: os.hostname(), since: new Date().toISOString() });
  });

  setInterval(sweep, 30000);
  tts.loadModel().catch(() => {});
  return { stop: () => db.removeAllChannels() };
}

// ---- run alone ----------------------------------------------------------

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--selftest");
  if (i > 0) {
    const text = process.argv[i + 1] || "Hello there. This is the PC voice, made on your own computer.";
    const voice = "af_heart";
    const out = await tts.render(text, voice);
    const mp3 = await encodeMp3(out.samples, out.sampleRate, loadEnv().ffmpeg);
    const file = path.join(os.tmpdir(), `readaloud-selftest-${audioKey(voice, text).slice(0, 8)}.mp3`);
    writeFileSync(file, mp3);
    const words = tts.normalizeText(text).split(/\s+/).length;
    console.log(JSON.stringify({ file, bytes: mp3.length, durationMs: out.speechMarks.endTime, words, chunks: out.speechMarks.chunks.length, oneChunkPerWord: words === out.speechMarks.chunks.length, key: audioKey(voice, text) }, null, 2));
    process.exit(0);
  }
  const w = await startWorker();
  if (!w) process.exit(1);
}
