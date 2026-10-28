// ReadAloud voice engine `modal` (docs/CLOUD-CONTRACT.md).
//
// The phone inserts a ra_render_jobs row, then POSTs { job_id } here with its JWT.
// We answer 202 at once and keep working in the background (EdgeRuntime.waitUntil):
// send the sentences to our Kokoro worker on Modal in small batches, read its
// NDJSON stream, and for each sentence as soon as it arrives upload the MP3 and
// insert the ra_audio row (the phone hears it over Realtime).
//
// Why batches through here, not Modal writing to Supabase itself: the service
// role key stays inside Supabase. A warm T4 makes a sentence in well under a
// second, so even a 40-sentence job fits the wall-clock limit. If time runs short
// anyway, the function hands the rest of the job to a fresh call of itself.
//
// Secrets (Supabase -> Edge Functions -> Secrets): MODAL_ENGINE_URL, MODAL_ENGINE_TOKEN.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.

import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const ENGINE = "modal";
const VOICES = [
  "af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael",
  "am_fenrir", "am_puck", "bf_emma", "bm_george", "bm_fable",
];
const BATCH = 8;                 // sentences per Modal request
const TIME_BUDGET_MS = 100_000;  // free-plan wall clock is 150 s; leave room

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const MODAL_URL = Deno.env.get("MODAL_ENGINE_URL") ?? "";
const MODAL_TOKEN = Deno.env.get("MODAL_ENGINE_TOKEN") ?? "";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });
}

const admin = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

type Item = { i: number; text: string };
type Job = { id: string; user_id: string; engine: string; voice: string; items: Item[]; status: string };

async function sha1(s: string) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromBase64(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

const jobExists = async (id: string) =>
  !!(await admin.from("ra_render_jobs").select("id").eq("id", id).maybeSingle()).data;

async function setStatus(id: string, status: string, error: string | null = null) {
  await admin.from("ra_render_jobs").update({ status, error }).eq("id", id);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const body = await req.json().catch(() => ({}));
  if (body?.ping) return json({ ok: true });

  const jobId = typeof body?.job_id === "string" ? body.job_id : "";
  if (!jobId) return json({ error: "job_id missing" }, 400);

  // A continuation call comes from this function itself, carrying the engine token.
  const internal = !!MODAL_TOKEN && req.headers.get("x-ra-continue") === MODAL_TOKEN;
  let userId: string | null = null;
  if (!internal) {
    const jwt = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data?.user) return json({ error: "sign in first" }, 401);
    userId = data.user.id;
  }

  const { data: job } = await admin.from("ra_render_jobs")
    .select("id, user_id, engine, voice, items, status").eq("id", jobId).maybeSingle<Job>();
  if (!job) return json({ error: "no such job" }, 404);
  if (!internal && job.user_id !== userId) return json({ error: "not your job" }, 403);
  if (job.engine !== ENGINE) return json({ error: `job is for engine ${job.engine}` }, 400);

  if (!MODAL_URL || !MODAL_TOKEN) {
    await setStatus(job.id, "error", "modal engine is not configured (MODAL_ENGINE_URL / MODAL_ENGINE_TOKEN)");
    return json({ error: "engine not configured" }, 503);
  }
  if (!VOICES.includes(job.voice)) {
    await setStatus(job.id, "error", `unknown voice ${job.voice}`);
    return json({ error: "unknown voice" }, 400);
  }

  if (internal) {
    if (job.status !== "working") return json({ ok: true, status: job.status });
  } else {
    // Claim the job once. A second call for the same job does nothing.
    const { data: claimed } = await admin.from("ra_render_jobs")
      .update({ status: "working", error: null }).eq("id", job.id).eq("status", "queued").select("id");
    if (!claimed?.length) return json({ ok: true, status: job.status });
  }

  const from = internal && Number.isInteger(body.from) ? body.from : 0;
  const done = internal && Number.isInteger(body.made) ? body.made : 0;
  const failed: string[] = internal && Array.isArray(body.failed) ? body.failed : [];
  EdgeRuntime.waitUntil(run(job, from, done, failed));
  return json({ ok: true, status: "working" }, 202);
});

async function run(job: Job, from: number, made: number, failed: string[]) {
  const started = Date.now();
  try {
    const items = (Array.isArray(job.items) ? job.items : [])
      .map((it) => ({ i: it.i, text: String(it.text ?? "").replace(/\s+/g, " ").trim() }))
      .filter((it) => it.text);
    const keyed = await Promise.all(items.map(async (it) => ({ ...it, key: await sha1(`${ENGINE}|${job.voice}|${it.text}`) })));

    // Never make the same file twice.
    const { data: have } = await admin.from("ra_audio").select("key").in("key", keyed.map((k) => k.key));
    const known = new Set((have ?? []).map((r) => r.key));
    const todo = keyed.filter((k) => !known.has(k.key));

    for (let b = from; b < todo.length; b += BATCH) {
      if (!(await jobExists(job.id))) return; // the phone moved on and deleted the job
      if (Date.now() - started > TIME_BUDGET_MS) {
        await continueLater(job.id, b, made, failed);
        return;
      }
      const batch = todo.slice(b, b + BATCH);
      const byI = new Map(batch.map((k) => [k.i, k]));
      const ctrl = new AbortController();
      const res = await fetch(MODAL_URL, {
        method: "POST",
        signal: ctrl.signal,
        headers: { authorization: `Bearer ${MODAL_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ voice: job.voice, items: batch.map(({ i, text }) => ({ i, text })) }),
      });
      if (!res.ok || !res.body) throw new Error(`modal ${res.status}: ${(await res.text()).slice(0, 200)}`);

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
          if (!line) continue;
          const msg = JSON.parse(line);
          if (msg.done) continue;
          const it = byI.get(msg.i);
          if (!it) continue;
          if (!msg.ok) {
            failed.push(`#${msg.i}: ${msg.error}`);
            continue;
          }
          if (!(await jobExists(job.id))) {
            ctrl.abort();
            return;
          }
          const path = `audio/${job.user_id}/${ENGINE}/${job.voice}/${it.key}.mp3`;
          const up = await admin.storage.from("readaloud")
            .upload(path, fromBase64(msg.mp3), { contentType: "audio/mpeg", upsert: true });
          if (up.error) throw new Error(`upload: ${up.error.message}`);
          const ins = await admin.from("ra_audio").upsert({
            key: it.key, user_id: job.user_id, engine: ENGINE, voice: job.voice,
            audio_path: path, format: "mp3", duration_ms: msg.duration_ms, marks: msg.marks,
          }, { onConflict: "key", ignoreDuplicates: true });
          if (ins.error) throw new Error(`ra_audio: ${ins.error.message}`);
          made++;
        }
      }
    }

    if (!(await jobExists(job.id))) return;
    if (failed.length && !made) await setStatus(job.id, "error", failed.join("; ").slice(0, 500));
    else await setStatus(job.id, "done", failed.length ? failed.join("; ").slice(0, 500) : null);
  } catch (e) {
    if (await jobExists(job.id)) await setStatus(job.id, "error", String((e as Error)?.message ?? e).slice(0, 500));
  }
}

// Hand the rest of the job to a fresh invocation (new wall clock).
async function continueLater(jobId: string, from: number, made: number, failed: string[]) {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/ra-engine-modal`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-ra-continue": MODAL_TOKEN, authorization: `Bearer ${SERVICE_KEY}` },
    body: JSON.stringify({ job_id: jobId, from, made, failed }),
  });
  if (!res.ok) await setStatus(jobId, "error", `could not continue the job (${res.status})`);
}
