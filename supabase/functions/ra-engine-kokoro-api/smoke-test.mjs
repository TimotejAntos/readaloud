// Smoke test for the deployed ra-engine-kokoro-api function.
// Inserts one kokoro_api job with synthetic sentences, calls the function with
// the service key, then checks every ra_audio row + mp3 against the contract.
//
//   node --use-system-ca supabase/functions/ra-engine-kokoro-api/smoke-test.mjs [voice] [--clean] [--practice]
//
// Reads SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from pc-worker/.env.
// --clean     deletes the test job, its ra_audio rows and mp3s afterwards.
// --practice  no DeepInfra call (costs nothing): the Windows voice speaks each
//             sentence (practice-voice.ps1), ffmpeg makes the mp3, and we send it
//             to the function in DeepInfra's reply shape. Always cleans up, so no
//             Windows-voice audio is left in the cache under a Kokoro key.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mp3Info } from "./marks.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const env = Object.fromEntries(
  readFileSync(`${root}pc-worker/.env`, "utf8")
    .split(/\r?\n/)
    .filter((l) => /^\w+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const URL_ = env.SUPABASE_URL;
if (!URL_) throw new Error("Set SUPABASE_URL in pc-worker/.env first.");
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const voice = process.argv.find((a, i) => i > 1 && !a.startsWith("--")) || "af_heart";
const practice = process.argv.includes("--practice");
const clean = practice || process.argv.includes("--clean");
const H = { apikey: KEY, authorization: `Bearer ${KEY}`, "content-type": "application/json" };

const SENTENCES = [
  "The little robot counted 1,204 marbles before lunch.",
  "Dr. Lee said, \"Don't open the blue door — not yet!\"",
  "In 1990, the U.S. postal service delivered 166 billion letters.",
  `Smoke test ${Date.now()}: every word should light up right on time.`,
];

const rest = async (path, init = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...init, headers: { ...H, ...init.headers } });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path}: ${r.status} ${t}`);
  return t ? JSON.parse(t) : null;
};

// Any ReadAloud user will do; take the owner of the newest document.
const [doc] = await rest("ra_documents?select=user_id&order=created_at.desc&limit=1");
if (!doc) throw new Error("no ra_documents row to borrow a user_id from");
const [job] = await rest("ra_render_jobs", {
  method: "POST",
  headers: { prefer: "return=representation" },
  body: JSON.stringify({ user_id: doc.user_id, engine: "kokoro_api", voice, items: SENTENCES.map((text, i) => ({ i, text })), status: "queued" }),
});
console.log("job", job.id, "voice", voice);

// Practice replies, exactly in DeepInfra's shape: { audio: data URL, words: [{ text, start, end }] }.
let practice_replies;
if (practice) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ra-practice-"));
  writeFileSync(path.join(dir, "in.json"), JSON.stringify(SENTENCES));
  const spoken = JSON.parse(
    execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileURLToPath(new URL("practice-voice.ps1", import.meta.url)), "-InFile", path.join(dir, "in.json"), "-OutDir", dir], { encoding: "utf8" }),
  );
  practice_replies = {};
  spoken.forEach((s, i) => {
    const mp3 = execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", s.wav, "-c:a", "libmp3lame", "-b:a", "40k", "-ar", "24000", "-ac", "1", "-f", "mp3", "pipe:1"]);
    const words = s.words.map((w, k) => ({ text: w.text, start: w.start, end: k + 1 < s.words.length ? s.words[k + 1].start : Math.min(w.start + 0.6, s.seconds) }));
    practice_replies[i] = { audio: `data:audio/mpeg;base64,${mp3.toString("base64")}`, words, inference_status: { cost: 0 } };
  });
  rmSync(dir, { recursive: true, force: true });
  console.log("practice replies made with the Windows voice");
}

const t0 = Date.now();
const res = await fetch(`${URL_}/functions/v1/ra-engine-kokoro-api`, { method: "POST", headers: H, body: JSON.stringify({ job_id: job.id, practice_replies }) });
const out = await res.json();
console.log("function", res.status, JSON.stringify(out), `${Date.now() - t0} ms round trip`);

const norm = (s) => s.replace(/\s+/g, " ").trim();
const keys = SENTENCES.map((s) => createHash("sha1").update(`kokoro_api|${voice}|${norm(s)}`).digest("hex"));
const rows = await rest(`ra_audio?select=*&key=in.(${keys.join(",")})`);
const [after] = await rest(`ra_render_jobs?select=status,error&id=eq.${job.id}`);
console.log("job status", after.status, after.error || "");

let pass = rows.length === SENTENCES.length && after.status === "done";
for (const text of SENTENCES) {
  const key = keys[SENTENCES.indexOf(text)];
  const row = rows.find((r) => r.key === key);
  if (!row) {
    console.log("MISSING", text);
    pass = false;
    continue;
  }
  const words = norm(text).split(/\s+/);
  const m = row.marks;
  const a = await fetch(`${URL_}/storage/v1/object/readaloud/${row.audio_path}`, { headers: H });
  const mp3 = new Uint8Array(await a.arrayBuffer());
  const info = mp3Info(mp3);
  const checks = {
    path: row.audio_path === `audio/${row.user_id}/kokoro_api/${voice}/${key}.mp3`,
    oneChunkPerWord: m.chunks.length === words.length && m.chunks.every((c, k) => c.value === words[k] && c.type === "word"),
    offsets: m.chunks.every((c) => norm(text).slice(c.start, c.end) === c.value),
    inOrder: m.chunks.every((c, k) => c.endTime >= c.startTime && (k === 0 || c.startTime >= m.chunks[k - 1].startTime)),
    shape: m.type === "sentence" && m.value === norm(text) && m.start === 0 && m.end === norm(text).length && m.startTime === 0 && typeof m.estimated === "boolean",
    mp3: a.ok && info.frames > 0 && info.sampleRate === 24000,
    duration: Math.abs(row.duration_ms - info.durationMs) < 100 && m.endTime === row.duration_ms,
  };
  const ok = Object.values(checks).every(Boolean);
  if (!ok) pass = false;
  console.log(ok ? "OK  " : "FAIL", JSON.stringify({ bytes: mp3.length, kbps: info.kbps, rate: info.sampleRate, ms: row.duration_ms, estimated: m.estimated, failed: Object.keys(checks).filter((k) => !checks[k]) }));
  console.log("     ", m.chunks.map((c) => `${c.value}@${c.startTime}`).join(" "));
}

if (clean) {
  if (rows.length) {
    const del = await fetch(`${URL_}/storage/v1/object/readaloud`, { method: "DELETE", headers: H, body: JSON.stringify({ prefixes: rows.map((r) => r.audio_path) }) });
    if (!del.ok) console.log("mp3 delete failed", del.status, await del.text());
  }
  if (rows.length) await rest(`ra_audio?key=in.(${rows.map((r) => r.key).join(",")})`, { method: "DELETE" });
  await rest(`ra_render_jobs?id=eq.${job.id}`, { method: "DELETE" });
  console.log("cleaned up");
}
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
