// ReadAloud quiz maker: ABCD questions from the reader's own book, each tied to
// the exact place it came from. Contract: docs/TUTOR.md.
//
// POST { document_id, scope: "book" | "chapter" | "confused", count?, chapter?, word?, ranges? }
//   book      pieces spread over the whole book
//   chapter   pieces of `chapter` (the chapter title the reader is in)
//   confused  pieces under the reader's "Don't get it" highlights: ranges = [{ start, end }]
// Answers the saved ra_quizzes row.
//
// Acts with the caller's own token, so RLS keeps it to their own books.
// Secrets: OPENAI_API_KEY. Optional: OPENAI_MODEL.

import { createClient } from "npm:@supabase/supabase-js@2.49.4";

const MODEL = Deno.env.get("OPENAI_MODEL") || "gpt-6.1-sol";
const MAX_PIECES = 24;
// Front and back matter makes poor questions.
const SKIP = /^(title page|copyright|contents|table of contents|dedication|epigraph|acknowledg|index|notes|bibliography|about the author|also by|praise for)/i;

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, x-client-info, apikey, content-type",
  "access-control-allow-methods": "POST, OPTIONS",
};
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "content-type": "application/json" } });

const SYSTEM = `You write multiple-choice quizzes that check whether a reader understood their book. Use ONLY the numbered passages.

Rules:
- Each question tests one idea, cause, distinction, example or application from one passage. No trivia: never ask about page numbers, chapter names, the author's life or exact wording.
- Exactly 4 options. Exactly one is correct according to the passage. The 3 wrong options sound plausible to someone who only skimmed, but the passage clearly rules them out.
- Keep the options similar in length and style. Never use "all of the above" or "none of the above".
- The explanation is 1 to 3 plain sentences: why the right answer is right, from the passage.
- piece is the number of the passage the question comes from. Spread the questions over different passages, from easier to harder.
- Write in the book's language. The title is short (at most 6 words) and names the topic.`;

const SCHEMA = {
  name: "quiz",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["title", "questions"],
    properties: {
      title: { type: "string" },
      questions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["question", "options", "correct", "explanation", "piece"],
          properties: {
            question: { type: "string" },
            options: { type: "array", items: { type: "string" } },
            correct: { type: "integer" },
            explanation: { type: "string" },
            piece: { type: "integer" },
          },
        },
      },
    },
  },
};

type Meta = { id: string; chunk_no: number; start_word: number; end_word: number; page: number | null; page_end: number | null; chapter: string };

// Pick n items spread evenly over a list.
function spread<T>(list: T[], n: number) {
  if (list.length <= n) return list;
  return Array.from({ length: n }, (_, i) => list[Math.floor(((i + 0.5) * list.length) / n)]);
}

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

function profileText(p: Record<string, unknown> | null) {
  if (!p?.level) return "";
  return `\n\nThe reader's level: ${p.level}. Fit the difficulty to it.`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST only" });
  const body = await req.json().catch(() => ({}));
  const key = Deno.env.get("OPENAI_API_KEY");
  if (body?.ping) return reply(200, { ok: true, ready: !!key, model: MODEL });
  if (!key) return reply(503, { error: "Quizzes are not set up yet: add OPENAI_API_KEY in Supabase Edge Function secrets." });

  // ---- who
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: `Bearer ${jwt}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: auth } = await db.auth.getUser(jwt);
  if (!auth?.user) return reply(401, { error: "Please sign in again." });

  // ---- which book, which pieces
  const documentId = typeof body?.document_id === "string" ? body.document_id : "";
  const scope = ["book", "chapter", "confused"].includes(body?.scope) ? body.scope : "book";
  const count = Math.min(15, Math.max(3, Number(body?.count) || 10));
  if (!documentId) return reply(400, { error: "document_id is missing" });

  const { data: doc } = await db.from("ra_documents").select("id,title").eq("id", documentId).maybeSingle();
  if (!doc) return reply(404, { error: "Book not found." });
  const { data: metaRows, error: metaError } = await db
    .from("ra_chunks")
    .select("id,chunk_no,start_word,end_word,page,page_end,chapter")
    .eq("document_id", documentId)
    .order("chunk_no")
    .limit(5000);
  if (metaError) return reply(500, { error: metaError.message });
  const all = (metaRows || []) as Meta[];
  if (!all.length) return reply(409, { error: "This book is still being prepared. Try again in a minute." });

  let picked: Meta[] = [];
  if (scope === "chapter") {
    const chapter = String(body?.chapter ?? "");
    let inChapter = all.filter((c) => c.chapter === chapter);
    if (!inChapter.length) {
      const word = Number(body?.word) || 0;
      const at = Math.max(0, all.findIndex((c) => c.end_word >= word));
      inChapter = all.slice(Math.max(0, at - 6), at + 6);
    }
    picked = spread(inChapter, MAX_PIECES);
  } else if (scope === "confused") {
    const ranges = (Array.isArray(body?.ranges) ? body.ranges : []).map((r: { start: number; end: number }) => [Number(r.start), Number(r.end)]);
    picked = all.filter((c) => ranges.some(([s, e]: number[]) => c.start_word <= e && c.end_word >= s)).slice(0, MAX_PIECES);
    if (!picked.length) return reply(400, { error: "No \"Don't get it\" highlights in this book yet." });
  } else {
    const main = all.filter((c) => !SKIP.test(c.chapter.trim()));
    picked = spread(main.length >= 4 ? main : all, Math.min(MAX_PIECES, Math.max(8, count * 2)));
  }

  const { data: texts } = await db.from("ra_chunks").select("id,text").in("id", picked.map((c) => c.id));
  const textOf = new Map((texts || []).map((t: { id: string; text: string }) => [t.id, t.text]));
  const pieces = picked.filter((c) => textOf.get(c.id));
  const where = (c: Meta) => [c.chapter, c.page ? `p. ${c.page}` : ""].filter(Boolean).join(" — ");
  const { data: settings } = await db.from("ra_user_settings").select("tutor").maybeSingle();

  // ---- ask the model, in a fixed JSON shape
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      reasoning_effort: "low",
      max_completion_tokens: 10000,
      response_format: { type: "json_schema", json_schema: SCHEMA },
      messages: [
        { role: "system", content: SYSTEM + profileText(settings?.tutor || null) },
        {
          role: "user",
          content: `Book: "${doc.title}"\n\nPassages:\n\n${pieces.map((c, i) => `[${i + 1}] ${where(c)}\n${textOf.get(c.id)}`).join("\n\n")}\n\nWrite ${count} questions.`,
        },
      ],
    }),
  });
  if (!res.ok) {
    const msg = (await res.text()).slice(0, 300);
    if (res.status === 401) return reply(502, { error: "The OpenAI key is wrong or missing." });
    if (res.status === 429 && /quota|billing/i.test(msg)) return reply(502, { error: "The OpenAI account has no credit left." });
    return reply(502, { error: `OpenAI ${res.status}: ${msg}` });
  }
  const out = await res.json();
  const message = out.choices?.[0]?.message;
  if (message?.refusal) return reply(502, { error: "Could not make a quiz from this part. Try another one." });
  let made: { title: string; questions: { question: string; options: string[]; correct: number; explanation: string; piece: number }[] };
  try {
    made = JSON.parse(message?.content || "{}");
  } catch {
    return reply(502, { error: "The quiz came back broken. Try again." });
  }

  // ---- check each question, shuffle the options, tie it to its place
  const questions = [];
  for (const q of made.questions || []) {
    const piece = pieces[q.piece - 1];
    if (!piece || !Array.isArray(q.options) || q.options.length !== 4 || !(q.correct >= 0 && q.correct <= 3)) continue;
    const order = [0, 1, 2, 3];
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    questions.push({
      question: q.question.trim(),
      options: order.map((k) => String(q.options[k]).trim()),
      correct: order.indexOf(q.correct),
      explanation: q.explanation.trim(),
      source: {
        chunk_id: piece.id,
        chapter: piece.chapter,
        page: piece.page,
        page_end: piece.page_end,
        start_word: piece.start_word,
        end_word: piece.end_word,
        quote: bestSentence(textOf.get(piece.id)!, `${q.question} ${q.options[q.correct]} ${q.explanation}`),
      },
    });
    if (questions.length >= count) break;
  }
  if (!questions.length) return reply(502, { error: "The quiz came back empty. Try again." });

  const { data: quiz, error: saveError } = await db
    .from("ra_quizzes")
    .insert({ document_id: documentId, scope, title: (made.title || doc.title).slice(0, 80), questions, total: questions.length })
    .select("*")
    .single();
  if (saveError) return reply(500, { error: saveError.message });
  return reply(200, { quiz });
});
