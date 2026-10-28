// ReadAloud voice engine "kokoro_api": Kokoro-82M hosted by DeepInfra.
// Contract: docs/CLOUD-CONTRACT.md. The phone inserts an ra_render_jobs row and
// calls this function with { job_id } and its JWT. We render each sentence,
// upload the mp3 and insert its ra_audio row as soon as it is ready.
//
// Secret: DEEPINFRA_API_KEY (Supabase -> Edge Functions -> Secrets).

import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import { buildMarks, mp3Info, type ApiWord } from "./marks.ts";

const ENGINE = "kokoro_api";
const BUCKET = "readaloud";
const DEEPINFRA_URL = "https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M";
// Same ids as VOICES in server/tts.js.
const VOICES = new Set(["af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael", "am_fenrir", "am_puck", "bf_emma", "bm_george", "bm_fable"]);
const PARALLEL = 3; // sentences in flight at once; the first one still lands first
const STALE_MS = 3 * 60_000; // a "working" job older than this was left behind by a dead run

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function sha1(s: string) {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromBase64(s: string) {
  const bin = atob(s.replace(/^data:[^,]*,/, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Spoken = { mp3: Uint8Array; words: ApiWord[]; cost: number | null };
type Speaker = (text: string, voice: string, i: number) => Promise<Spoken>;

// DeepInfra answers { audio: "data:audio/mpeg;base64,...", words: [{ text, start, end }], inference_status: { cost } }.
function readReply(out: { audio?: string; words?: ApiWord[]; inference_status?: { cost?: number } }): Spoken {
  if (!out?.audio) throw new Error("DeepInfra sent no audio");
  return { mp3: fromBase64(out.audio), words: out.words || [], cost: out.inference_status?.cost ?? null };
}

async function speak(text: string, voice: string, key: string): Promise<Spoken> {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(DEEPINFRA_URL, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ text, preset_voice: [voice], output_format: "mp3", return_timestamps: true, sample_rate: 24000 }),
    });
    if (res.ok) return readReply(await res.json());
    const msg = (await res.text()).slice(0, 200);
    // Busy or a hiccup on their side: try twice more, then give up.
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 800 * attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403) throw new Error("DeepInfra key is wrong or missing");
    if (res.status === 402) throw new Error("DeepInfra account has no balance. Add money at deepinfra.com/dash/billing.");
    throw new Error(`DeepInfra ${res.status}: ${msg}`);
  }
}

// A token that claims role "service_role" must also work as an admin key.
async function isServiceKey(jwt: string) {
  if (!jwt) return false;
  if (jwt === Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")) return true;
  try {
    const claims = JSON.parse(atob(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    if (claims.role !== "service_role") return false;
    const probe = createClient(Deno.env.get("SUPABASE_URL")!, jwt, { auth: { persistSession: false, autoRefreshToken: false } });
    const { error } = await probe.auth.admin.listUsers({ page: 1, perPage: 1 });
    return !error;
  } catch {
    return false;
  }
}

type Job = { id: string; user_id: string; engine: string; voice: string; items: { i: number; text: string }[]; status: string; updated_at: string };

async function render(job: Job, say: Speaker) {
  const t0 = Date.now();
  const stats = { made: 0, skipped: 0, chars: 0, cost: 0, firstMs: null as number | null, estimated: 0, stopped: false };
  const items = (Array.isArray(job.items) ? job.items : [])
    .map((it) => ({ i: it.i, text: String(it.text ?? "").replace(/\s+/g, " ").trim() }))
    .filter((it) => it.text);

  let next = 0;
  let failure: string | null = null;
  const worker = async () => {
    while (next < items.length && !failure && !stats.stopped) {
      const it = items[next++];
      // The phone deletes jobs it no longer needs (the reader jumped away).
      const { data: still } = await db.from("ra_render_jobs").select("id").eq("id", job.id).maybeSingle();
      if (!still) {
        stats.stopped = true;
        return;
      }
      const key = await sha1(`${ENGINE}|${job.voice}|${it.text}`);
      const { data: have } = await db.from("ra_audio").select("key").eq("key", key).maybeSingle();
      if (have) {
        stats.skipped++;
        continue;
      }
      try {
        const out = await say(it.text, job.voice, it.i);
        const info = mp3Info(out.mp3);
        const marks = buildMarks(it.text, out.words, info.durationMs);
        const audio_path = `audio/${job.user_id}/${ENGINE}/${job.voice}/${key}.mp3`;
        const up = await db.storage.from(BUCKET).upload(audio_path, out.mp3, { contentType: "audio/mpeg", upsert: true });
        if (up.error) throw new Error(`upload: ${up.error.message}`);
        const ins = await db.from("ra_audio").upsert(
          { key, user_id: job.user_id, engine: ENGINE, voice: job.voice, audio_path, format: "mp3", duration_ms: marks.endTime, marks },
          { onConflict: "key", ignoreDuplicates: true },
        );
        if (ins.error) throw new Error(`ra_audio: ${ins.error.message}`);
        stats.made++;
        stats.chars += it.text.length;
        stats.cost += out.cost || 0;
        if (marks.estimated) stats.estimated++;
        if (stats.firstMs === null) stats.firstMs = Date.now() - t0;
        console.log(JSON.stringify({ job: job.id, i: it.i, ms: Date.now() - t0, chars: it.text.length, kbps: info.kbps, rate: info.sampleRate, words: marks.chunks.length, estimated: marks.estimated }));
      } catch (err) {
        failure = String((err as Error)?.message || err).slice(0, 300);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL, items.length || 1) }, worker));

  if (!stats.stopped) {
    await db.from("ra_render_jobs").update(failure ? { status: "error", error: failure } : { status: "done", error: null }).eq("id", job.id);
  }
  const summary = { job: job.id, ...stats, cost: Number(stats.cost.toFixed(6)), totalMs: Date.now() - t0, error: failure };
  console.log(JSON.stringify(summary));
  return summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });

  const body = await req.json().catch(() => ({}));
  // The phone's "is this engine deployed?" check.
  if (body?.ping) return reply(200, { ok: true });

  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  // The service key (tests, the PC) may run any job; everyone else only their own.
  const admin = await isServiceKey(jwt);
  const { data: auth } = jwt && !admin ? await db.auth.getUser(jwt) : { data: null };
  const user = auth?.user;
  if (!user && !admin) return reply(401, { error: "Please sign in again." });

  const jobId = typeof body?.job_id === "string" ? body.job_id : "";
  if (!jobId) return reply(400, { error: "job_id is missing" });
  const { data: job } = await db.from("ra_render_jobs").select("id,user_id,engine,voice,items,status,updated_at").eq("id", jobId).maybeSingle();
  if (!job || (!admin && job.user_id !== user!.id)) return reply(404, { error: "Job not found." });
  if (job.engine !== ENGINE) return reply(400, { error: `This job is for engine "${job.engine}".` });

  const fail = async (msg: string) => {
    await db.from("ra_render_jobs").update({ status: "error", error: msg }).eq("id", job.id);
    return reply(400, { error: msg });
  };
  if (!VOICES.has(job.voice)) return fail(`Unknown voice "${job.voice}".`);

  // Practice mode (service key only): the caller sends DeepInfra-shaped replies,
  // one per item index, so everything after the DeepInfra call can be tested
  // without paying. See smoke-test.mjs.
  const practice = admin && body?.practice_replies && typeof body.practice_replies === "object";
  let say: Speaker;
  if (practice) {
    say = async (_text, _voice, i) => {
      const out = body.practice_replies[String(i)];
      if (!out) throw new Error(`no practice reply for item ${i}`);
      return readReply(out);
    };
  } else {
    const apiKey = Deno.env.get("DEEPINFRA_API_KEY");
    if (!apiKey) return fail("DEEPINFRA_API_KEY is not set in Supabase Edge Function secrets.");
    say = (text, voice) => speak(text, voice, apiKey);
  }

  // Claim the job once. A second call for the same job is a no-op, unless the
  // first run died and left it "working" for too long.
  if (job.status === "done") return reply(200, { ok: true, status: "done" });
  if (job.status === "working" && Date.now() - Date.parse(job.updated_at) < STALE_MS) return reply(202, { ok: true, status: "working" });
  const { data: claimed } = await db
    .from("ra_render_jobs")
    .update({ status: "working", error: null })
    .eq("id", job.id)
    .eq("updated_at", job.updated_at)
    .select("id");
  if (!claimed?.length) return reply(202, { ok: true, status: "working" });

  // Keep going even if the phone drops the request (screen off, app closed).
  const work = render(job as Job, say).catch(async (err) => {
    const msg = String(err?.message || err).slice(0, 300);
    await db.from("ra_render_jobs").update({ status: "error", error: msg }).eq("id", job.id);
    return { error: msg };
  });
  // deno-lint-ignore no-explicit-any
  (globalThis as any).EdgeRuntime?.waitUntil?.(work);
  const summary = await work;
  return reply(summary.error ? 502 : 200, { ok: !summary.error, practice: !!practice, ...summary });
});
