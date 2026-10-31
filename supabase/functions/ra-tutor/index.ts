// ReadAloud tutor: answer a question from the reader's own books, like a teacher,
// with every claim tied to the exact place it came from. Contract: docs/TUTOR.md.
//
// POST { question, thread_id?, document_ids?, near?: { document_id, word }, selection? }
// Answers a stream of JSON lines:
//   { t: "meta", thread_id }            the chat this answer belongs to
//   { t: "text", text }                 answer text as it is written (with [n] marks)
//   { t: "done", message_id, parts, sources }   the final answer, marks mapped to sources
//   { t: "error", error }
//
// Who: the caller's token. Every database read runs as that user, so RLS keeps
// it to their own books. Which book: document_ids (null = all their books).
// Which piece: ra_search_chunks (meaning + words). The model sees only those pieces,
// numbered [1]..[n], and must put the numbers after each sentence it bases on them.
//
// Secrets: OPENAI_API_KEY. Optional: OPENAI_MODEL (answers), OPENAI_FAST_MODEL
// (rewrites follow-up questions for the search).

import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-6.1-sol";
const FAST_MODEL = Deno.env.get("OPENAI_FAST_MODEL") || "gpt-6-luna";
const EMBED_MODEL = "text-embedding-3-small";
const HITS = 8; // best pieces from the search
const MAX_PIECES = 18; // with their neighbours
const HISTORY = 8; // earlier messages sent along

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const SYSTEM = `You are the ReadAloud tutor. You teach the reader using ONLY the numbered passages from their own books in their message.

Truth rules:
- Every fact, idea, name, number or claim you state must come from the passages.
- After each sentence that uses a passage, put that passage's number in square brackets, like [2], or [2][5] for two. Every factual sentence needs at least one. Use only numbers that exist.
- If the passages do not answer the question, say so plainly in one sentence, for example "I can't find this in your books." Then, if it helps, say what the books do cover nearby. Never fill the gap from general knowledge, even when you know the answer.
- You may rephrase, simplify, connect and compare sourced ideas, and you may give an everyday analogy to make one clear. Introduce an analogy as your own ("Think of it like..."), and never put new facts in it.
- Quote a short exact phrase when the author's wording matters.

How to teach:
- Open with the direct answer in one or two sentences.
- Then explain step by step, from simple to deeper, in short paragraphs. Use a numbered list only for real steps or sequences.
- When ideas from different places relate, connect them, and name the chapter or page when that helps the reader find their way.
- End with one short question that makes the reader think about what they just learned (never a yes/no question), on its own line starting with "Check yourself:". No passage numbers on that line.
- Fit the reader's level, goals and style in the learner profile. With no profile, write for a curious adult who is new to the topic.
- Answer in the language of the reader's question. Plain text with simple Markdown only (**bold**, numbered lists); no headings, no tables.
- Speak about "your book" or the book's title. Never mention "passages" or their numbers in words.
- Do not write a list of sources; the app shows them from your numbers.`;

function profileText(p: Record<string, unknown> | null) {
  if (!p) return "";
  const lines = [
    p.level && `Level: ${p.level}`,
    p.goal && `Goal: ${p.goal}`,
    p.style && `How they like to learn: ${p.style}`,
    p.notes && `Notes: ${p.notes}`,
  ].filter(Boolean);
  return lines.length ? `\n\nLearner profile:\n${lines.join("\n")}` : "";
}

function openaiKey() {
  const key = Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new Error("The tutor is not set up yet: add OPENAI_API_KEY in Supabase Edge Function secrets.");
  return key;
}

async function openaiError(res: Response) {
  const msg = (await res.text()).slice(0, 300);
  if (res.status === 401) return new Error("The OpenAI key is wrong or missing.");
  if (res.status === 429 && /quota|billing/i.test(msg)) return new Error("The OpenAI account has no credit left.");
  if (res.status === 429) return new Error("OpenAI is busy. Try again in a moment.");
  return new Error(`OpenAI ${res.status}: ${msg}`);
}

async function embed(text: string): Promise<number[]> {
  const res = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: { authorization: `Bearer ${openaiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text.slice(0, 6000) }),
  });
  if (!res.ok) throw await openaiError(res);
  return (await res.json()).data[0].embedding;
}

type Msg = { role: "system" | "user" | "assistant"; content: string };

// Stream a chat answer; onText gets each new piece of text. Returns the whole text.
async function chat(model: string, messages: Msg[], effort: string, maxTokens: number, onText?: (t: string) => void) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${openaiKey()}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, reasoning_effort: effort, max_completion_tokens: maxTokens }),
  });
  if (!res.ok || !res.body) throw await openaiError(res);
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  let full = "";
  let finish = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += value;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") continue;
      const ev = JSON.parse(data);
      const choice = ev.choices?.[0];
      const t = choice?.delta?.content;
      if (t) {
        full += t;
        onText?.(t);
      }
      if (choice?.finish_reason) finish = choice.finish_reason;
    }
  }
  if (finish === "content_filter") throw new Error("The tutor could not answer this one. Try asking it another way.");
  return full;
}

// The sentence of a piece that best matches what the answer said, as the quote.
function bestSentence(pieceText: string, said: string) {
  const words = (s: string) => new Set(s.toLowerCase().match(/[\p{L}\p{N}']{4,}/gu) || []);
  const want = words(said);
  const sentences = pieceText.split(/(?<=[.!?…])\s+/).filter((s) => s.trim());
  let best = sentences[0] || pieceText;
  let score = -1;
  for (const s of sentences) {
    let n = 0;
    for (const w of words(s)) if (want.has(w)) n++;
    if (n > score) [best, score] = [s, n];
  }
  return best.trim().slice(0, 400);
}

type Chunk = { id: string; document_id: string; chunk_no: number; start_word: number; end_word: number; page: number | null; page_end: number | null; chapter: string; text: string };
type Source = { n: number; chunk_id: string; document_id: string; title: string; chapter: string; page: number | null; page_end: number | null; start_word: number; end_word: number; quote: string; text: string };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const body = await req.json().catch(() => ({}));
  if (body?.ping) return reply(200, { ok: true, ready: !!Deno.env.get("OPENAI_API_KEY"), model: MODEL });

  // ---- who
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await db.auth.getUser(jwt);
  if (!auth?.user) return reply(401, { error: "Please sign in again." });

  const question = String(body?.question ?? "").trim().slice(0, 2000);
  const selection = String(body?.selection ?? "").trim().slice(0, 2000);
  if (!question && !selection) return reply(400, { error: "Ask a question first." });
  if (!Deno.env.get("OPENAI_API_KEY")) return reply(503, { error: "The tutor is not set up yet: add OPENAI_API_KEY in Supabase Edge Function secrets." });

  // ---- which book
  const docIds: string[] | null = Array.isArray(body?.document_ids) && body.document_ids.length ? body.document_ids.map(String) : null;
  const near = body?.near && typeof body.near.document_id === "string" ? { document_id: body.near.document_id, word: Number(body.near.word) || 0 } : null;

  // ---- the chat
  let threadId = typeof body?.thread_id === "string" ? body.thread_id : "";
  let history: { role: "user" | "assistant"; content: string }[] = [];
  if (threadId) {
    const { data: rows } = await db.from("ra_tutor_messages").select("role,content").eq("thread_id", threadId).order("created_at", { ascending: false }).limit(HISTORY);
    history = (rows || []).reverse() as typeof history;
    while (history.length && history[0].role !== "user") history.shift();
  } else {
    const { data: t, error } = await db
      .from("ra_tutor_threads")
      .insert({ document_id: docIds?.length === 1 ? docIds[0] : null, title: (question || selection).slice(0, 80) })
      .select("id")
      .single();
    if (error) return reply(500, { error: error.message });
    threadId = t.id;
  }

  const { data: settings } = await db.from("ra_user_settings").select("tutor").maybeSingle();
  const asked = question || "Explain this passage to me.";

  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (o: unknown) => controller.enqueue(enc.encode(JSON.stringify(o) + "\n"));
      try {
        send({ t: "meta", thread_id: threadId });

        // ---- which piece: a question that leans on the chat ("and the second one?")
        // is first rewritten into one that stands alone, so the search can find it.
        let searchText = [asked, selection].filter(Boolean).join("\n");
        if (history.length) {
          try {
            const q = await chat(
              FAST_MODEL,
              [
                { role: "system", content: "Rewrite the reader's last question as one standalone search query for their books, using the chat for missing names and topics. Reply with the query only." },
                { role: "user", content: history.map((m) => `${m.role}: ${m.content.slice(0, 600)}`).join("\n") + `\nuser: ${asked}` },
              ],
              "low",
              400,
            );
            if (q.trim()) searchText = [q.trim(), selection].filter(Boolean).join("\n");
          } catch (e) {
            console.log("rewrite failed", String(e));
          }
        }

        const { data: hits, error: searchError } = await db.rpc("ra_search_chunks", {
          query_embedding: JSON.stringify(await embed(searchText)),
          query_text: searchText,
          doc_ids: docIds,
          match_count: HITS,
          near_doc: near?.document_id ?? null,
          near_word: near?.word ?? null,
        });
        if (searchError) throw new Error(searchError.message);

        // Add each hit's neighbours so no idea is cut in half, and the piece the
        // reader selected text in.
        const want = new Map<string, Set<number>>();
        const add = (doc: string, no: number) => {
          if (no < 0) return;
          if (!want.has(doc)) want.set(doc, new Set());
          want.get(doc)!.add(no);
        };
        for (const h of hits || []) for (const no of [h.chunk_no, h.chunk_no - 1, h.chunk_no + 1]) add(h.document_id, no);
        if (selection && near) {
          const { data: here } = await db.from("ra_chunks").select("chunk_no").eq("document_id", near.document_id).lte("start_word", near.word).gte("end_word", near.word).limit(1);
          if (here?.[0]) add(near.document_id, here[0].chunk_no);
        }
        let chunks: Chunk[] = [];
        for (const [doc, nos] of want) {
          const { data } = await db.from("ra_chunks").select("id,document_id,chunk_no,start_word,end_word,page,page_end,chapter,text").eq("document_id", doc).in("chunk_no", [...nos]);
          chunks.push(...((data || []) as Chunk[]));
        }
        // Keep the best hits first when trimming, then put each book back in reading order.
        const rank = new Map((hits || []).map((h: { id: string }, i: number) => [h.id, i]));
        chunks.sort((a, b) => (rank.get(a.id) ?? 99) - (rank.get(b.id) ?? 99));
        chunks = chunks.slice(0, MAX_PIECES).sort((a, b) => a.document_id.localeCompare(b.document_id) || a.chunk_no - b.chunk_no);

        if (!chunks.length) {
          const text = "I can't find anything about this in your books yet. If the book is new, give it a moment to finish preparing, then ask again.";
          send({ t: "text", text });
          const saved = await save(db, threadId, question || selection, text, [{ text, cites: [] }], []);
          send({ t: "done", message_id: saved, parts: [{ text, cites: [] }], sources: [] });
          controller.close();
          return;
        }

        const ids = [...new Set(chunks.map((c) => c.document_id))];
        const { data: docs } = await db.from("ra_documents").select("id,title").in("id", ids);
        const titleOf = new Map((docs || []).map((d: { id: string; title: string }) => [d.id, d.title]));
        const where = (c: Chunk) =>
          [titleOf.get(c.document_id) || "Your book", c.chapter, c.page ? `p. ${c.page}${c.page_end && c.page_end !== c.page ? `–${c.page_end}` : ""}` : ""].filter(Boolean).join(" — ");

        let ask = `Passages from my books:\n\n${chunks.map((c, i) => `[${i + 1}] ${where(c)}\n${c.text}`).join("\n\n")}\n\nMy question: ${asked}`;
        if (selection) ask += `\n\nThe passage I selected:\n"${selection}"`;

        const text = await chat(
          MODEL,
          [{ role: "system", content: SYSTEM + profileText(settings?.tutor || null) }, ...history, { role: "user", content: ask }],
          "medium",
          6000,
          (t) => send({ t: "text", text: t }),
        );

        // ---- turn the [n] marks into parts with sources (book, chapter, page, words)
        const sources: Source[] = [];
        const numberOf = new Map<string, number>();
        const parts: { text: string; cites: number[] }[] = [];
        const pieces = text.split(/((?:\s*\[\d+\])+)/);
        for (let i = 0; i < pieces.length; i += 2) {
          const said = pieces[i];
          const marks = pieces[i + 1] || "";
          const cites: number[] = [];
          for (const m of marks.matchAll(/\[(\d+)\]/g)) {
            const ch = chunks[Number(m[1]) - 1];
            if (!ch) continue;
            if (!numberOf.has(ch.id)) {
              numberOf.set(ch.id, sources.length + 1);
              sources.push({
                n: sources.length + 1,
                chunk_id: ch.id,
                document_id: ch.document_id,
                title: titleOf.get(ch.document_id) || "Your book",
                chapter: ch.chapter,
                page: ch.page,
                page_end: ch.page_end,
                start_word: ch.start_word,
                end_word: ch.end_word,
                quote: bestSentence(ch.text, said),
                text: ch.text,
              });
            }
            const n = numberOf.get(ch.id)!;
            if (!cites.includes(n)) cites.push(n);
          }
          if (said || cites.length) parts.push({ text: said, cites });
        }
        const full = parts.map((p) => p.text).join("");
        const saved = await save(db, threadId, question || selection, full, parts, sources);
        send({ t: "done", message_id: saved, parts, sources });
      } catch (e) {
        console.log("tutor error", String(e));
        send({ t: "error", error: String((e as Error)?.message || e).slice(0, 300) });
      }
      controller.close();
    },
  });
  return new Response(stream, { headers: { ...CORS, "content-type": "application/x-ndjson", "cache-control": "no-cache" } });
});

// deno-lint-ignore no-explicit-any
async function save(db: any, threadId: string, question: string, answer: string, parts: unknown, sources: unknown) {
  await db.from("ra_tutor_messages").insert({ thread_id: threadId, role: "user", content: question });
  const { data } = await db.from("ra_tutor_messages").insert({ thread_id: threadId, role: "assistant", content: answer, parts, sources }).select("id").single();
  await db.from("ra_tutor_threads").update({ updated_at: new Date().toISOString() }).eq("id", threadId);
  return data?.id ?? null;
}
