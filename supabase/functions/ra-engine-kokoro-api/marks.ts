// Speech marks for the kokoro_api engine (see docs/CLOUD-CONTRACT.md).
//
// DeepInfra's Kokoro returns its own word timestamps (return_timestamps: true).
// Its words do not always line up 1:1 with ours: punctuation can come back as
// separate tokens, and "1990" is spoken (and timed) as "nineteen ninety". So we
// align the two on letters and digits only, give every matched word the model's
// times, and fill the gaps (unmatched words) by letter weight between the
// neighbours that did match. No Deno or Node APIs here, so tests run in Node.

export type ApiWord = { text: string; start: number; end: number }; // seconds
export type Chunk = { type: "word"; value: string; start: number; end: number; startTime: number; endTime: number };
export type Marks = {
  type: "sentence";
  value: string;
  start: number;
  end: number;
  startTime: number;
  endTime: number;
  estimated: boolean;
  chunks: Chunk[];
};

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

export function splitWords(text: string) {
  const words: { value: string; start: number; end: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) words.push({ value: m[0], start: m.index!, end: m.index! + m[0].length });
  return words;
}

export function buildMarks(text: string, apiWords: ApiWord[] | null | undefined, durationMs: number): Marks {
  const words = splitWords(text);
  const api = (apiWords || [])
    .filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ n: norm(w.text || ""), s: w.start * 1000, e: w.end * 1000 }))
    .filter((w) => w.n);

  // Character streams: each char remembers which word it came from.
  const a: { c: string; w: number }[] = [];
  words.forEach((w, i) => [...norm(w.value)].forEach((c) => a.push({ c, w: i })));
  const b: { c: string; w: number }[] = [];
  api.forEach((w, i) => [...w.n].forEach((c) => b.push({ c, w: i })));

  // Longest common subsequence on characters (sentences are short: <= a few
  // hundred chars, so the n*m table is cheap).
  const n = a.length, m = b.length;
  // hits[k] = Map(api word index -> chars of word k matched into it)
  const hits: Map<number, number>[] = words.map(() => new Map());
  if (n && m) {
    const dp = new Uint16Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i * (m + 1) + j] = a[i].c === b[j].c ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i].c === b[j].c) {
        hits[a[i].w].set(b[j].w, (hits[a[i].w].get(b[j].w) || 0) + 1);
        i++, j++;
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) i++;
      else j++;
    }
  }

  // An API word belongs to word k only if k covers most of it (a stray "t"
  // borrowed from "nineteen" does not count). Word k is matched when most of
  // its own letters land in API words it owns.
  const times: ({ s: number; e: number } | null)[] = words.map((w, k) => {
    const len = norm(w.value).length;
    const ids = [...hits[k]].filter(([x, c]) => c / api[x].n.length >= 0.5);
    const got = ids.reduce((sum, [, c]) => sum + c, 0);
    if (!len || !ids.length || got / len < 0.6) return null;
    return { s: Math.min(...ids.map(([x]) => api[x].s)), e: Math.max(...ids.map(([x]) => api[x].e)) };
  });

  // Pure punctuation ("—") is never spoken, so it cannot make the marks an estimate.
  const guessed = words.filter((w, k) => !times[k] && norm(w.value)).length;
  const speechStart = api.length ? api[0].s : 0;
  const speechEnd = api.length ? api[api.length - 1].e : durationMs;

  // Keep times in order (a stray late match must not jump backwards).
  let floor = 0;
  for (let k = 0; k < times.length; k++) {
    const t = times[k];
    if (!t) continue;
    if (t.s < floor) t.s = floor;
    if (t.e < t.s) t.e = t.s;
    floor = t.s;
  }

  // Fill each run of unmatched words between the anchors around it.
  for (let k = 0; k < words.length; ) {
    if (times[k]) {
      k++;
      continue;
    }
    let end = k;
    while (end < words.length && !times[end]) end++;
    const from = k > 0 ? times[k - 1]!.e : speechStart;
    const to = end < words.length ? times[end]!.s : speechEnd;
    const weights = words.slice(k, end).map((w) => (norm(w.value).length || 1) * 0.8 + 1.2);
    const total = weights.reduce((x, y) => x + y, 0);
    let t = from;
    const span = Math.max(0, to - from);
    for (let q = k; q < end; q++) {
      const d = (weights[q - k] / total) * span;
      times[q] = { s: t, e: t + d };
      t += d;
    }
    k = end;
  }

  // Never highlight past the end of the real audio.
  const cap = (t: number) => Math.round(durationMs > 0 ? Math.min(t, durationMs) : t);
  const chunks: Chunk[] = words.map((w, k) => ({
    type: "word",
    value: w.value,
    start: w.start,
    end: w.end,
    startTime: cap(times[k]!.s),
    endTime: cap(times[k]!.e),
  }));
  return {
    type: "sentence",
    value: text,
    start: 0,
    end: text.length,
    startTime: 0,
    endTime: Math.max(durationMs, chunks.length ? chunks[chunks.length - 1].endTime : 0),
    estimated: guessed > 0 || !api.length,
    chunks,
  };
}

// ---- mp3 length -----------------------------------------------------------
// Walk the MPEG frame headers and add up their samples. Exact for CBR and VBR.

const BITRATES: Record<string, number[]> = {
  "1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], // MPEG-1 Layer III
  "2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160], // MPEG-2/2.5 Layer III
};
const RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

export function mp3Info(buf: Uint8Array) {
  let i = 0;
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
    i = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  }
  let samples = 0, rate = 0, kbps = 0, frames = 0;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) {
      i++;
      continue;
    }
    const ver = (buf[i + 1] >> 3) & 3; // 3 = MPEG-1, 2 = MPEG-2, 0 = MPEG-2.5
    const layer = (buf[i + 1] >> 1) & 3; // 1 = Layer III
    const bi = (buf[i + 2] >> 4) & 15, ri = (buf[i + 2] >> 2) & 3, pad = (buf[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bi === 0 || bi === 15 || ri === 3) {
      i++;
      continue;
    }
    const br = BITRATES[ver === 3 ? "1" : "2"][bi] * 1000;
    const sr = RATES[ver][ri];
    const perFrame = ver === 3 ? 1152 : 576;
    const len = Math.floor(((perFrame / 8) * br) / sr) + pad;
    if (len < 4) break;
    // The first frame may be a "Xing"/"Info" header with no sound in it.
    const tag = frames === 0 ? String.fromCharCode(...buf.subarray(i + 4, i + 4 + 40)) : "";
    if (!/Xing|Info/.test(tag)) samples += perFrame;
    rate = sr;
    kbps = br / 1000;
    frames++;
    i += len;
  }
  return { durationMs: rate ? Math.round((samples / rate) * 1000) : 0, sampleRate: rate, kbps, frames };
}
