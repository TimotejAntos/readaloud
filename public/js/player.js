// The player: reads the document sentence by sentence and reports which word
// is being spoken right now.
//
// How Speechify does it (see FINDINGS.md), and how we copy it:
//   1. Text is cut into short utterances (sentences).
//   2. Each utterance is sent to a voice; the answer is audio + speech marks
//      (start/end time of every word).
//   3. While audio plays, the current time is turned into a word with a
//      lookup over the speech marks ("getCharacterIndexAtTime").
//   4. Speed is just the audio playback rate. Nothing is generated again.
//   5. The next few utterances are fetched ahead of time (prefetch), so the
//      voice never waits.
//
// Three voice engines share one interface:
//   KokoroEngine  - our local server (high quality, estimated word timings)
//   CloudEngine   - audio from Supabase (ra_audio), made by the pc /
//                   kokoro_api / modal engines (docs/CLOUD-CONTRACT.md)
//   SystemEngine  - the voices built into Windows/the browser (exact word
//                   events, lower quality). Works even before Kokoro loads.

import * as cloud from "./cloud.js";

const PREFETCH = 3;

export class Player extends EventTarget {
  constructor(doc) {
    super();
    this.doc = doc;
    this.sentence = 0;
    this.word = 0;
    this.speed = 1;
    this.voice = "af_heart";
    this.state = "idle"; // idle | loading | playing | paused | ended
    this.engine = null;
  }

  // kind: "local" (Kokoro on this PC's server), "system" (device voice),
  // or a cloud engine id: "pc" | "kokoro_api" | "modal".
  setEngine(kind, { documentId } = {}) {
    const wasPlaying = this.state === "playing" || this.state === "loading";
    this.engine?.stop();
    this.engine?.dispose?.();
    if (kind === "system") this.engine = new SystemEngine(this);
    else if (kind === "local") this.engine = new KokoroEngine(this);
    else this.engine = new CloudEngine(this, kind, documentId);
    this.engineKind = kind;
    this.emit("engine");
    if (wasPlaying) this.play();
  }

  setVoice(voice) {
    this.voice = voice;
    this.engine?.voiceChanged();
  }

  setSpeed(speed) {
    this.speed = Math.round(Math.min(4, Math.max(0.5, speed)) * 100) / 100;
    this.engine?.speedChanged();
    this.emit("speed");
  }

  play() {
    if (!this.doc.sentences.length) return;
    if (this.state === "ended") this.seekWord(0, false);
    this.engine.unlock?.(); // phones only allow sound that starts inside a tap
    this.engine.start(this.sentence, this.word);
  }

  pause() {
    this.engine.pause();
    this.setState("paused");
  }

  toggle() {
    this.state === "playing" || this.state === "loading" ? this.pause() : this.play();
  }

  // Jump to a word. Keeps playing if we were playing.
  seekWord(wordIndex, autoplay = this.state === "playing" || this.state === "loading") {
    const s = this.sentenceOf(wordIndex);
    this.engine?.stop();
    this.sentence = s;
    this.setWord(wordIndex);
    if (autoplay) this.engine.start(s, wordIndex);
    else if (this.state !== "idle") this.setState("paused");
  }

  skipSentence(delta) {
    const s = Math.min(this.doc.sentences.length - 1, Math.max(0, this.sentence + delta));
    this.seekWord(this.doc.sentences[s].first);
  }

  sentenceOf(wordIndex) {
    const list = this.doc.sentences;
    let lo = 0;
    let hi = list.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (list[mid].first <= wordIndex) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  // --- called by engines ---
  setWord(i) {
    if (i === this.word && this._emittedOnce) return;
    this._emittedOnce = true;
    this.word = i;
    this.emit("word");
  }
  setSentence(s) {
    this.sentence = s;
    this.emit("sentence");
  }
  setState(state, detail) {
    this.state = state;
    this.emit("state", detail);
  }
  sentenceEnded(s) {
    if (s + 1 < this.doc.sentences.length) this.engine.start(s + 1, this.doc.sentences[s + 1].first);
    else {
      this.setState("ended");
    }
  }
  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// ---------------------------------------------------------------------------

class KokoroEngine {
  constructor(player) {
    this.p = player;
    this.audio = new Audio();
    this.audio.preservesPitch = true; // faster speech without the chipmunk voice
    this.cache = new Map(); // sentence index -> { voice, promise, abort }
    this.token = 0;
    this.msPerWord = 380; // running average, used for "time left"
    this.audio.addEventListener("ended", () => {
      if (this.current != null) this.p.sentenceEnded(this.current);
    });
  }

  fetchSentence(i) {
    const hit = this.cache.get(i);
    if (hit && hit.voice === this.p.voice) return hit.promise;
    hit?.abort.abort();
    const abort = new AbortController();
    const text = this.p.doc.sentences[i].text;
    const promise = fetch("/api/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, voice: this.p.voice }),
      signal: abort.signal,
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `voice server ${r.status}`);
        return r.json();
      })
      .then((data) => {
        const bytes = Uint8Array.from(atob(data.audioData), (c) => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: "audio/wav" }));
        const marks = data.speechMarks;
        const n = marks.chunks.length;
        if (n) this.msPerWord = this.msPerWord * 0.8 + (marks.endTime / n) * 0.2;
        return { url, marks };
      });
    promise.catch(() => {});
    this.cache.set(i, { voice: this.p.voice, promise, abort });
    return promise;
  }

  // Keep only the sentences we are about to read; cancel the rest.
  prune(from) {
    for (const [i, entry] of this.cache) {
      if (i < from - 1 || i > from + PREFETCH) {
        entry.abort.abort();
        entry.promise.then((v) => URL.revokeObjectURL(v.url)).catch(() => {});
        this.cache.delete(i);
      }
    }
  }

  async start(s, fromWord) {
    const token = ++this.token;
    const p = this.p;
    this.stopLoop();
    this.audio.pause();
    this.current = null;
    p.setSentence(s);
    this.prune(s);
    const pending = this.fetchSentence(s);
    for (let k = 1; k <= PREFETCH && s + k < p.doc.sentences.length; k++) this.fetchSentence(s + k);

    p.setState("loading");
    let entry;
    try {
      entry = await pending;
    } catch (err) {
      if (token !== this.token) return;
      p.setState("paused", { error: `Voice failed: ${err.message}` });
      return;
    }
    if (token !== this.token) return; // user jumped somewhere else meanwhile

    const sentence = p.doc.sentences[s];
    this.current = s;
    this.marks = entry.marks;
    this.first = sentence.first;
    this.audio.src = entry.url;
    this.audio.playbackRate = p.speed;
    const k = fromWord - sentence.first;
    if (k > 0 && this.marks.chunks[k]) this.audio.currentTime = Math.max(0, this.marks.chunks[k].startTime - 60) / 1000;
    try {
      await this.audio.play();
    } catch (err) {
      if (token === this.token) p.setState("paused", { error: err.message });
      return;
    }
    if (token !== this.token) return;
    p.setState("playing");
    this.loop();
  }

  // Every frame: audio time -> word. Same idea as Speechify's
  // getCharacterIndexAtTime, but we want the word, not the character.
  loop() {
    this.tick();
    this.raf = requestAnimationFrame(() => this.loop());
    // Frames stop when the phone screen is off; a slow timer keeps the
    // position (and the saved bookmark) moving anyway.
    clearTimeout(this.slow);
    this.slow = setTimeout(() => this.current != null && !this.audio.paused && this.loop(), 500);
  }
  tick() {
    const chunks = this.marks.chunks;
    const t = this.audio.currentTime * 1000;
    let k = 0;
    for (let i = 0; i < chunks.length; i++) {
      if (chunks[i].startTime <= t) k = i;
      else break;
    }
    // Contract: one chunk per word. If a voice ever breaks that, spread evenly.
    const s = this.p.doc.sentences[this.current];
    const n = s ? s.last - s.first + 1 : chunks.length;
    if (chunks.length && chunks.length !== n) k = Math.min(n - 1, Math.floor((k * n) / chunks.length));
    this.p.setWord(this.first + k);
  }
  stopLoop() {
    cancelAnimationFrame(this.raf);
    clearTimeout(this.slow);
  }

  // A silent sound played inside the tap "unlocks" audio on iPhone, so the
  // real sound may start later, after the network answered.
  unlock() {
    if (this.unlocked) return;
    this.unlocked = true;
    this.audio.src = SILENCE;
    this.audio.play().then(() => this.audio.pause()).catch(() => {});
  }

  pause() {
    this.token++;
    this.stopLoop();
    this.audio.pause();
  }
  stop() {
    this.pause();
    this.current = null;
  }
  speedChanged() {
    this.audio.playbackRate = this.p.speed;
  }
  voiceChanged() {
    this.prune(Infinity); // drop everything made with the old voice
    if (this.p.state === "playing" || this.p.state === "loading") this.start(this.p.sentence, this.p.word);
  }
}

// ---------------------------------------------------------------------------
// Cloud audio. Same playback as KokoroEngine; only "where does the audio of
// sentence i come from" changes:
//   1. key = sha1(engine|voice|text) -> look it up in ra_audio
//   2. missing -> one ra_render_jobs row for all missing sentences
//      (kokoro_api / modal: also call their Edge Function with the job id)
//   3. wait for the ra_audio insert (Realtime, plus a slow poll as backup)

class CloudEngine extends KokoroEngine {
  constructor(player, engine, documentId) {
    super(player);
    this.engine = engine;
    this.documentId = documentId;
    this.waiters = new Map(); // key -> { promise, resolve, reject, job, wanted }
    this.batch = null; // sentences asked for in this tick, sent as one job
    this.off = [
      cloud.on("audio", (row) => this.arrived(row)),
      cloud.on("job", (job) => this.jobChanged(job)),
    ];
    this.poll = setInterval(() => this.pollMissing(), 4000);
  }

  dispose() {
    this.off.forEach((f) => f());
    clearInterval(this.poll);
    this.cancelUnwanted(true);
  }

  fetchSentence(i) {
    const hit = this.cache.get(i);
    if (hit && hit.voice === this.p.voice) return hit.promise;
    hit?.abort.abort();
    const abort = new AbortController();
    const text = this.p.doc.sentences[i].text;
    const voice = this.p.voice;
    const promise = (async () => {
      const key = await cloud.audioKey(this.engine, voice, text);
      const row = await this.request(i, key, text, voice);
      if (abort.signal.aborted) throw new Error("cancelled");
      const blob = await cloud.audioBlob(row);
      const marks = row.marks;
      const n = marks.chunks.length;
      if (n) this.msPerWord = this.msPerWord * 0.8 + (marks.endTime / n) * 0.2;
      return { url: URL.createObjectURL(blob), marks, key };
    })();
    promise.catch(() => {});
    this.cache.set(i, { voice, promise, abort, keyOf: () => promise.then((v) => v.key) });
    return promise;
  }

  // Ask for one sentence. Requests made in the same moment become one job.
  request(i, key, text, voice) {
    let w = this.waiters.get(key);
    if (w) {
      w.wanted = true;
      return w.promise;
    }
    w = { wanted: true, i };
    w.promise = new Promise((res, rej) => Object.assign(w, { resolve: res, reject: rej }));
    w.promise.catch(() => {});
    this.waiters.set(key, w);
    if (!this.batch) {
      this.batch = [];
      setTimeout(() => this.flush(voice), 0);
    }
    this.batch.push({ key, i, text });
    return w.promise;
  }

  async flush(voice) {
    const batch = this.batch;
    this.batch = null;
    try {
      const found = await cloud.findAudio(batch.map((b) => b.key));
      for (const [key, row] of found) this.resolve(key, row);
      const missing = batch.filter((b) => !found.has(b.key));
      if (!missing.length) return;
      if (!navigator.onLine) throw new Error("You are offline, and this part is not saved on the phone.");
      if (this.engine === "pc" && !cloud.isOnline("pc")) throw new Error("PC voice is off. On the PC, double-click start.cmd. Or pick another engine in Settings.");
      const job = await cloud.createJob({
        documentId: this.documentId,
        engine: this.engine,
        voice,
        items: missing.map((b) => ({ i: b.i, text: b.text.replace(/\s+/g, " ").trim() })),
      });
      for (const b of missing) if (this.waiters.has(b.key)) this.waiters.get(b.key).job = job;
      if (this.engine !== "pc") {
        cloud.invokeEngine(this.engine, job).catch((err) => {
          const msg = err.message === "not ready" ? "This engine is not ready yet. Pick another one in Settings." : `Voice failed: ${err.message}`;
          for (const b of missing) this.reject(b.key, msg);
        });
      }
    } catch (err) {
      for (const b of batch) this.reject(b.key, err.message);
    }
  }

  arrived(row) {
    if (this.waiters.has(row.key)) this.resolve(row.key, row);
  }

  async jobChanged(job) {
    const mine = [...this.waiters].filter(([, w]) => w.job === job.id);
    if (!mine.length) return;
    if (job.status === "error") for (const [key] of mine) this.reject(key, `Voice failed: ${job.error || "unknown error"}`);
    if (job.status === "done") {
      // Realtime can miss a message; check once, then give up on the rest.
      const found = await cloud.findAudio(mine.map(([k]) => k));
      for (const [key] of mine) found.has(key) ? this.resolve(key, found.get(key)) : this.reject(key, "The voice skipped this sentence.");
    }
  }

  async pollMissing() {
    const keys = [...this.waiters].filter(([, w]) => w.job).map(([k]) => k);
    if (!keys.length || !navigator.onLine) return;
    const found = await cloud.findAudio(keys).catch(() => new Map());
    for (const [key, row] of found) this.resolve(key, row);
  }

  resolve(key, row) {
    const w = this.waiters.get(key);
    if (!w) return;
    this.waiters.delete(key);
    w.resolve(row);
  }
  reject(key, msg) {
    const w = this.waiters.get(key);
    if (!w) return;
    this.waiters.delete(key);
    w.reject(new Error(msg));
  }

  prune(from) {
    super.prune(from);
    // Waiters for sentences that left the window are not wanted any more.
    const keep = new Set([...this.cache.keys()]);
    for (const w of this.waiters.values()) w.wanted = keep.has(w.i);
    this.cancelUnwanted();
  }

  // A job none of whose sentences are still wanted is deleted, so the PC
  // does not spend minutes on audio nobody will hear.
  cancelUnwanted(all = false) {
    const jobs = new Map();
    for (const [key, w] of this.waiters) {
      if (!w.job) continue;
      const j = jobs.get(w.job) || { wanted: false, keys: [] };
      j.wanted ||= w.wanted && !all;
      j.keys.push(key);
      jobs.set(w.job, j);
    }
    const drop = [...jobs].filter(([, j]) => !j.wanted);
    if (!drop.length) return;
    for (const [, j] of drop) for (const k of j.keys) this.reject(k, "cancelled");
    cloud.cancelJobs(drop.map(([id]) => id)).catch(() => {});
  }

  voiceChanged() {
    this.cancelUnwanted(true);
    super.voiceChanged();
  }
}

// 0.05 s of silence as a WAV data URL (see KokoroEngine.unlock).
const SILENCE = (() => {
  const n = 1200;
  const b = new DataView(new ArrayBuffer(44 + n * 2));
  const s = (o, t) => [...t].forEach((c, i) => b.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); b.setUint32(4, 36 + n * 2, true); s(8, "WAVE"); s(12, "fmt ");
  b.setUint32(16, 16, true); b.setUint16(20, 1, true); b.setUint16(22, 1, true);
  b.setUint32(24, 24000, true); b.setUint32(28, 48000, true); b.setUint16(32, 2, true); b.setUint16(34, 16, true);
  s(36, "data"); b.setUint32(40, n * 2, true);
  let bin = "";
  new Uint8Array(b.buffer).forEach((x) => (bin += String.fromCharCode(x)));
  return `data:audio/wav;base64,${btoa(bin)}`;
})();

// ---------------------------------------------------------------------------

export function systemVoices() {
  return (window.speechSynthesis?.getVoices() || []).filter((v) => v.lang.startsWith("en"));
}

class SystemEngine {
  constructor(player) {
    this.p = player;
    this.token = 0;
    this.msPerWord = 400;
  }

  start(s, fromWord) {
    const token = ++this.token;
    const p = this.p;
    speechSynthesis.cancel();
    p.setSentence(s);
    const sentence = p.doc.sentences[s];
    // Speak from the chosen word to the end of the sentence.
    const words = p.doc.words.slice(fromWord, sentence.last + 1).map((w) => w.spoken);
    const starts = [];
    let text = "";
    for (const w of words) {
      starts.push(text.length);
      text += w + " ";
    }
    const u = new SpeechSynthesisUtterance(text);
    const voice = systemVoices().find((v) => v.name === p.systemVoice);
    if (voice) u.voice = voice;
    u.rate = p.speed;
    u.onstart = () => token === this.token && p.setState("playing");
    u.onboundary = (e) => {
      if (token !== this.token || e.name === "sentence") return;
      let k = 0;
      while (k + 1 < starts.length && starts[k + 1] <= e.charIndex) k++;
      p.setWord(fromWord + k);
    };
    u.onend = () => token === this.token && p.sentenceEnded(s);
    u.onerror = (e) => token === this.token && e.error !== "interrupted" && e.error !== "canceled" && p.setState("paused", { error: e.error });
    p.setWord(fromWord);
    p.setState("loading");
    speechSynthesis.speak(u);
  }

  // speechSynthesis.pause() is unreliable in Chrome, so pause = stop and
  // remember the word; play starts again from that word.
  pause() {
    this.token++;
    speechSynthesis.cancel();
  }
  stop() {
    this.pause();
  }
  speedChanged() {
    if (this.p.state === "playing") this.start(this.p.sentence, this.p.word);
  }
  voiceChanged() {
    if (this.p.state === "playing") this.start(this.p.sentence, this.p.word);
  }
}
