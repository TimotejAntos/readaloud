# The tutor

Ask a question about your books. The tutor answers like a teacher, only from
your books, and ties every point to the exact place it came from. Cloud mode only.

```
Your books ──► pieces ──► search numbers (Supabase)
                               │
You ask ──► best 8 pieces + neighbours ┘
                 │
                 ▼
     the AI gets ONLY those pieces + "answer only from these"
                 │
                 ▼
 Answer with [1] [2] marks ──► tap → quote → "Open here" / "Read aloud"
```

## The three questions

| Question | Answer |
|---|---|
| **Who?** | The caller's sign-in token. Both functions read the database *as that user*, so RLS returns only their rows. |
| **Which book?** | `document_ids` from the phone: this book, or `null` for all the user's books. |
| **Which piece?** | `ra_search_chunks`: search by meaning (OpenAI embeddings) and by words (full text), merged by rank. Pieces near the reader's place get a small bonus. |

## Parts

| Part | Job |
|---|---|
| `public/js/tutor.js` | `chunkDocument` cuts a parsed book at sentence and paragraph ends (about 200–280 words a piece, a new piece at each chapter). `answerHtml` turns an answer into HTML with marks. |
| `public/js/cloud.js` (tutor section) | Save pieces, run the indexer, stream an answer, load a chat, the learner profile. |
| `supabase/functions/ra-tutor-index` | Makes the search numbers (OpenAI `text-embedding-3-small`), 64 pieces per call. The phone calls it until `left` is 0. |
| `supabase/functions/ra-tutor` | Search, then the OpenAI model with the pieces numbered [1]..[n]; it writes the numbers after each sentence, and the function maps them back to pieces (book, chapter, page, word range) and picks the best-matching sentence as the quote. Streams JSON lines. |
| `supabase/migrations/20261031120000_ra_tutor.sql`, `…130000_ra_tutor_openai.sql`, `…140000_ra_quizzes.sql` | `ra_chunks`, `ra_tutor_threads`, `ra_tutor_messages`, `ra_user_settings.tutor`, `ra_search_chunks`. |

## When a book is prepared

The first time a book is opened in cloud mode, the phone cuts it into pieces
(it has the parsed book and its chapters) and calls the indexer in the
background. "All books" searches every book prepared this way.

## How it stays honest

1. The model gets only the user's pieces: no web, no memory.
2. The system prompt says: answer only from them, or say "I can't find this in your books."
3. Every factual sentence must carry a piece number, and numbers that do not exist are dropped. A long part of the answer with no number is shown with a dotted underline.

## Set up

1. Run the migrations (after the base and highlights ones).
2. Deploy `ra-tutor-index` and `ra-tutor` (`supabase functions deploy ra-tutor-index ra-tutor`).
3. Supabase → Edge Functions → Secrets: add `OPENAI_API_KEY`.
   Optional: `OPENAI_MODEL` (answers, default `gpt-6.1-sol`) and
   `OPENAI_FAST_MODEL` (rewrites follow-up questions, default `gpt-6-luna`).

Search numbers: OpenAI `text-embedding-3-small` (1536 numbers), about $0.02 per
1M tokens, so a 300-page book costs well under 1 cent to prepare. One answer
reads about 5k tokens and writes about 1k; with `gpt-6.1-sol` ($2 / $10 per 1M)
that is roughly 2 cents. Prices read on 2026-10-31; check OpenAI's pricing page.

## "Don't get it"

Pick the color whose meaning says you do not understand (default: purple,
"Don't get it"; any meaning with "don't get", "confused", "unclear" counts).
The highlight is saved, the tutor opens, and it explains those words at once,
from the book. The highlight keeps a link to that answer
(`ra_highlights.explained_message_id`): "See explanation" in the highlight menu
and "Explanation" in the vault open it again. "Explain" in the highlight menu
does the same for any words, without a color.

## Quizzes

Tutor panel → quiz icon, or the offer that appears when you reach the end of a
book. Choose what to test (this chapter, the whole book, or your "Don't get it"
parts) and 5, 10 or 15 questions. `ra-tutor-quiz` picks pieces (spread over the
book, the chapter's pieces, or the pieces under your flagged words), asks the
model for ABCD questions in a fixed JSON shape, checks each one, shuffles the
options and ties every question to its piece (chapter, page, quote). Quizzes and
answers are saved in `ra_quizzes`; you can resume, review or retake them.
Results show the score, every answer with its explanation and page, and
"Explain" sends a wrong answer to the tutor.
