// Local text-to-speech with Kokoro, plus "speech marks" (word timings).
//
// Speechify's audio server answers every request with
//   { audioData, audioFormat, speechMarks }
// where speechMarks = { type: "sentence", start, end, startTime, endTime,
//                       chunks: [{ type: "word", value, start, end, startTime, endTime }] }
// (seen in their web bundle, see FINDINGS.md). We return the same shape, so the
// reader does not care whether the audio came from Kokoro or a cloud voice.
//
// Kokoro's ONNX model only returns the waveform, not per-word timings. So we
// estimate them: each word gets a share of the speaking time based on its
// phoneme count, punctuation adds a pause, and leading/trailing silence is
// trimmed from the real audio first. Good enough to look locked to the voice.

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { KokoroTTS } from "kokoro-js";
import { phonemize } from "phonemizer";

const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
// fp32 measured 2.8x faster than real time on a Ryzen 5 3600; q8 was slower (0.9x).
const DTYPE = process.env.KOKORO_DTYPE || "fp32";
const SAMPLE_RATE = 24000;

export const VOICES = [
  { id: "af_heart", name: "Heart", accent: "US", gender: "female" },
  { id: "af_bella", name: "Bella", accent: "US", gender: "female" },
  { id: "af_nicole", name: "Nicole (soft)", accent: "US", gender: "female" },
  { id: "af_sarah", name: "Sarah", accent: "US", gender: "female" },
  { id: "am_michael", name: "Michael", accent: "US", gender: "male" },
  { id: "am_fenrir", name: "Fenrir", accent: "US", gender: "male" },
  { id: "am_puck", name: "Puck", accent: "US", gender: "male" },
  { id: "bf_emma", name: "Emma", accent: "UK", gender: "female" },
  { id: "bm_george", name: "George", accent: "UK", gender: "male" },
  { id: "bm_fable", name: "Fable", accent: "UK", gender: "male" },
];

let tts = null;
let loadError = null;
let loading = null;

export function status() {
  return { ready: !!tts, loading: !!loading && !tts, error: loadError, dtype: DTYPE };
}

export function loadModel() {
  if (!loading) {
    const t = Date.now();
    loading = KokoroTTS.from_pretrained(MODEL_ID, { dtype: DTYPE, device: "cpu" })
      .then((m) => {
        tts = m;
        console.log(`[tts] Kokoro ${DTYPE} ready in ${Date.now() - t} ms`);
        return m;
      })
      .catch((err) => {
        loadError = String(err?.message || err);
        console.error("[tts] model failed to load:", loadError);
        throw err;
      });
  }
  return loading;
}

// One generation at a time: the ONNX session is CPU-bound, and running two at
// once just makes both late. Requests wait in line.
let line = Promise.resolve();
function inLine(fn) {
  const run = line.then(fn, fn);
  line = run.catch(() => {});
  return run;
}

let cacheDir = null;
export function setCacheDir(dir) {
  cacheDir = dir;
}

export async function synthesize(text, voice, { isCancelled = () => false } = {}) {
  text = text.replace(/\s+/g, " ").trim();
  if (!text) throw new Error("empty text");
  if (!VOICES.some((v) => v.id === voice)) voice = VOICES[0].id;

  const key = createHash("sha1").update(`${DTYPE}|${voice}|${text}`).digest("hex");
  const file = cacheDir && path.join(cacheDir, key.slice(0, 2), `${key}.json`);
  if (file) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {}
  }

  const result = await inLine(async () => {
    // The reader skipped ahead before we got here: do not burn CPU on it.
    if (isCancelled()) return null;
    const model = await loadModel();
    const t = Date.now();
    const raw = await model.generate(text, { voice });
    const samples = raw.audio;
    const speechMarks = await estimateSpeechMarks(text, samples, voice);
    return {
      audioData: encodeWav(samples, SAMPLE_RATE).toString("base64"),
      audioFormat: "wav",
      speechMarks,
      genMs: Date.now() - t,
    };
  });
  if (!result) return null;

  if (file) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(result));
  }
  return result;
}

// Same voice, but raw samples instead of a WAV, for the cloud PC worker
// (it encodes MP3 itself). No disk cache: the cloud ra_audio table is the cache.
export async function render(text, voice) {
  text = normalizeText(text);
  if (!text) throw new Error("empty text");
  if (!VOICES.some((v) => v.id === voice)) voice = VOICES[0].id;
  return inLine(async () => {
    const model = await loadModel();
    const raw = await model.generate(text, { voice });
    const speechMarks = await estimateSpeechMarks(text, raw.audio, voice);
    return { text, voice, samples: raw.audio, sampleRate: SAMPLE_RATE, speechMarks };
  });
}

export function normalizeText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
}

// ---- speech marks -------------------------------------------------------

async function estimateSpeechMarks(text, samples, voice) {
  const words = [];
  for (const m of text.matchAll(/\S+/g)) words.push({ value: m[0], start: m.index, end: m.index + m[0].length });

  // Phoneme count per word tracks spoken length far better than letter count
  // ("through" = 7 letters, 3 phonemes). Fall back to letters if the counts
  // do not line up (numbers like "1990" become several spoken words).
  let phonemeCounts = null;
  try {
    const lang = voice.startsWith("b") ? "en-gb" : "en-us";
    const out = (await phonemize(text, lang)).join(" ");
    const groups = out.split(/\s+/).filter(Boolean);
    if (groups.length === words.length) phonemeCounts = groups.map((g) => g.replace(/[ˈˌː]/g, "").length);
  } catch {}

  const weights = words.map((w, i) => {
    const letters = w.value.replace(/[^\p{L}\p{N}]/gu, "").length || 1;
    const base = phonemeCounts ? Math.max(1, phonemeCounts[i]) : letters * 0.8;
    return base + 1.2; // small fixed cost per word (onset/transition)
  });
  const pauses = words.map((w) => {
    if (/[.!?…]["')\]]*$/.test(w.value)) return 5;
    if (/[,;:—–]["')\]]*$/.test(w.value)) return 3;
    return 0;
  });

  const { startMs, endMs } = speechWindow(samples);
  const total = weights.reduce((a, b) => a + b, 0) + pauses.slice(0, -1).reduce((a, b) => a + b, 0);
  const msPerUnit = (endMs - startMs) / total;

  let t = startMs;
  const chunks = words.map((w, i) => {
    const startTime = Math.round(t);
    t += weights[i] * msPerUnit;
    const endTime = Math.round(t);
    if (i < words.length - 1) t += pauses[i] * msPerUnit;
    return { type: "word", value: w.value, start: w.start, end: w.end, startTime, endTime };
  });
  const durationMs = Math.round((samples.length / SAMPLE_RATE) * 1000);
  return { type: "sentence", value: text, start: 0, end: text.length, startTime: 0, endTime: durationMs, chunks, estimated: true };
}

// Find where speech actually starts and stops (skip the quiet edges).
function speechWindow(samples) {
  const frame = Math.round(SAMPLE_RATE * 0.01); // 10 ms frames
  let peak = 0;
  const energies = [];
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const end = Math.min(samples.length, i + frame);
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    const rms = Math.sqrt(sum / (end - i));
    energies.push(rms);
    if (rms > peak) peak = rms;
  }
  const threshold = peak * 0.06;
  let first = energies.findIndex((e) => e > threshold);
  let last = energies.length - 1 - [...energies].reverse().findIndex((e) => e > threshold);
  if (first < 0) first = 0;
  if (last < first) last = energies.length - 1;
  return { startMs: first * 10, endMs: (last + 1) * 10 };
}

// ---- wav ----------------------------------------------------------------

function encodeWav(float32, sampleRate) {
  const buf = Buffer.alloc(44 + float32.length * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + float32.length * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(float32.length * 2, 40);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    buf.writeInt16LE(Math.round(s < 0 ? s * 0x8000 : s * 0x7fff), 44 + i * 2);
  }
  return buf;
}
