// "Download next chapter for offline": make sure the audio of the coming
// sentences exists in the cloud, then keep a copy on the phone.

import * as cloud from "./cloud.js";

// A chapter = from the current sentence to the next heading, at least ~20 and
// at most 400 sentences. Without headings: 150 sentences (about 15 minutes).
export function nextChapter(doc, fromSentence) {
  const headingStarts = new Set(doc.paragraphs.filter((p) => p.heading).map((p) => p.first));
  const max = Math.min(doc.sentences.length, fromSentence + 400);
  let end = Math.min(doc.sentences.length, fromSentence + 150);
  for (let s = fromSentence + 20; s < max; s++) {
    if (headingStarts.has(doc.sentences[s].first)) {
      end = s;
      break;
    }
  }
  return { from: fromSentence, to: end - 1 };
}

const JOB_SIZE = { pc: 8, kokoro_api: 10, modal: 40 };

export async function downloadRange({ doc, documentId, engine, voice, from, to, onProgress }) {
  const items = [];
  for (let s = from; s <= to; s++) {
    const text = doc.sentences[s].text.replace(/\s+/g, " ").trim();
    items.push({ i: s, text, key: await cloud.audioKey(engine, voice, text) });
  }
  const uniq = [...new Map(items.map((it) => [it.key, it])).values()];
  const rows = await cloud.findAudio(uniq.map((u) => u.key));
  let saved = 0;
  const total = uniq.length;
  const report = () => onProgress?.(saved, total);

  const missing = uniq.filter((u) => !rows.has(u.key));
  if (missing.length && engine === "pc" && !cloud.isOnline("pc")) throw new Error("PC voice is off. Start it on the PC, or pick another engine.");

  // Wait for the missing ones while the engine works.
  const waiting = new Map(missing.map((m) => [m.key, m]));
  const arrived = new Promise((resolve, reject) => {
    if (!waiting.size) return resolve();
    let lastNews = Date.now();
    const done = (key, row) => {
      if (!waiting.delete(key)) return;
      rows.set(key, row);
      lastNews = Date.now();
      if (!waiting.size) finish(resolve);
    };
    const off = [
      cloud.on("audio", (row) => done(row.key, row)),
      cloud.on("job", (job) => job.status === "error" && finish(() => reject(new Error(job.error || "The voice failed.")))),
    ];
    const poll = setInterval(async () => {
      const found = await cloud.findAudio([...waiting.keys()]).catch(() => new Map());
      for (const [k, r] of found) done(k, r);
      if (Date.now() - lastNews > 120000) finish(() => reject(new Error("The voice stopped answering.")));
    }, 5000);
    function finish(fn) {
      off.forEach((f) => f());
      clearInterval(poll);
      fn();
    }
  });

  const size = JOB_SIZE[engine] || 10;
  for (let k = 0; k < missing.length; k += size) {
    const part = missing.slice(k, k + size).map(({ i, text }) => ({ i, text }));
    const job = await cloud.createJob({ documentId, engine, voice, items: part });
    if (engine !== "pc") await cloud.invokeEngine(engine, job);
  }

  // Save what already exists while the rest is being made.
  const keep = async (row) => {
    await cloud.keepOffline(row);
    saved++;
    report();
  };
  const ready = [...rows.values()];
  const before = new Set(rows.keys());
  for (const row of ready) await keep(row);
  report();
  await arrived;
  for (const [key, row] of rows) if (!before.has(key)) await keep(row);
  return { saved, total };
}
