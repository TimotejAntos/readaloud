// ReadAloud tutor: make the search numbers (embeddings) for a book's pieces.
// Contract: docs/TUTOR.md. The phone cuts the book into ra_chunks rows (it has
// the parsed book and its chapters), then calls this function again and again
// with { document_id } until it answers { left: 0 }.
//
// Uses OpenAI text-embedding-3-small (1536 numbers). Secret: OPENAI_API_KEY.
// Acts with the caller's own token, so RLS keeps it to their own rows.

import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const EMBED_MODEL = "text-embedding-3-small";
const BATCH = 64; // pieces per call: one OpenAI request
const MAX_CHARS = 6000; // a piece is ~1,500 characters; this only guards odd ones

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

async function embedMany(texts: string[]): Promise<number[][]> {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("The tutor is not set up yet: add OPENAI_API_KEY in Supabase Edge Function secrets.");
  for (let attempt = 1; ; attempt++) {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: EMBED_MODEL, input: texts.map((t) => t.slice(0, MAX_CHARS)) }),
    });
    if (res.ok) {
      const out = await res.json();
      return (out.data as { index: number; embedding: number[] }[]).sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    const msg = (await res.text()).slice(0, 200);
    if (res.status === 401) throw new Error("The OpenAI key is wrong or missing.");
    if (res.status === 429 && /quota|billing/i.test(msg)) throw new Error("The OpenAI account has no credit left.");
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
      continue;
    }
    throw new Error(`OpenAI ${res.status}: ${msg}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const body = await req.json().catch(() => ({}));
  if (body?.ping) return reply(200, { ok: true, ready: !!Deno.env.get("OPENAI_API_KEY") });

  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await db.auth.getUser(jwt);
  if (!auth?.user) return reply(401, { error: "Please sign in again." });

  const documentId = typeof body?.document_id === "string" ? body.document_id : "";
  if (!documentId) return reply(400, { error: "document_id is missing" });

  const { data: rows, error } = await db
    .from("ra_chunks")
    .select("id,chapter,text")
    .eq("document_id", documentId)
    .is("embedding", null)
    .order("chunk_no")
    .limit(BATCH);
  if (error) return reply(500, { error: error.message });

  const t0 = Date.now();
  if (rows?.length) {
    let vectors: number[][];
    try {
      vectors = await embedMany(rows.map((r) => (r.chapter ? `${r.chapter}\n${r.text}` : r.text)));
    } catch (e) {
      return reply(502, { error: String((e as Error).message || e) });
    }
    for (let i = 0; i < rows.length; i += 8) {
      const ups = await Promise.all(
        rows.slice(i, i + 8).map((r, k) => db.from("ra_chunks").update({ embedding: JSON.stringify(vectors[i + k]) }).eq("id", r.id)),
      );
      const bad = ups.find((u) => u.error);
      if (bad) return reply(500, { error: bad.error!.message });
    }
  }

  const { count } = await db
    .from("ra_chunks")
    .select("id", { count: "exact", head: true })
    .eq("document_id", documentId)
    .is("embedding", null);
  return reply(200, { ok: true, made: rows?.length || 0, left: count ?? 0, ms: Date.now() - t0 });
});
