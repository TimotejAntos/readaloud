# Engine `modal`: our own Kokoro on a Modal GPU, with real word times

Follows `docs/CLOUD-CONTRACT.md`.

## What runs where

| Part | Where | File |
|---|---|---|
| Kokoro-82M, official Python `kokoro` 0.9.4 (KPipeline), T4 GPU | Modal app `readaloud-kokoro` in your Modal workspace | `kokoro_worker.py` |
| Job runner | Supabase Edge Function `ra-engine-modal` | `../../supabase/functions/ra-engine-modal/index.ts` |
| Tests and measurements | Modal app `readaloud-bench` (runs on demand only) | `bench.py` |

Endpoint: `https://<your-workspace>--readaloud-kokoro.<region>.modal.run` (printed by `modal deploy`). It is protected by the
bearer token `MODAL_ENGINE_TOKEN`, which is stored in 3 places:
- `engines/modal/.env` (gitignored)
- Modal secret `readaloud-engine`
- Supabase Edge secret

**Flow:**
1. The phone sends `{job_id}` with its JWT.
2. The function checks the user and claims the job (`queued` → `working`). It answers 202.
3. In the background, the function sends the sentences to Modal in batches of 8.
4. Modal streams back one NDJSON line per sentence (MP3 + marks).
5. For each line, the function uploads `audio/{user}/modal/{voice}/{key}.mp3` and inserts the `ra_audio` row.
6. Before each sentence, it checks that the job still exists. The phone deletes jobs it no longer needs.
7. At the end, the job status is `done` or `error`.
8. If the run gets near the wall-clock limit (100 s budget), the function calls itself to finish the rest.

**Why the function, not Modal, writes to Supabase:** the service-role key stays inside
Supabase. Modal never needs a Supabase key.

## Word times

Kokoro's own predicted phoneme durations give a start and end time per token. We match
the tokens back to the text and merge them into **exactly one chunk per whitespace word**.
Punctuation stays on its word. The marks have `estimated: false`.

If a word gets no model time, we fill it in from its neighbours. That chunk gets
`"estimated": true`, and the sentence gets `"estimatedWords": n`. In all tests, 0 words
needed this, including `$4.50`, `2024`, `7:30 a.m.`, curly quotes and dashes.

## Measured (synthetic text, 2026-10-28)

| What | Result |
|---|---|
| Wake-up from zero (cold start), first sentence back | **21 s** (15 s of it is loading the model onto the GPU) |
| Warm, 4 sentences | 1.1 s to the first, 1.4 s for all |
| T4 speed | **28× real time** on the GPU, 25× end to end (186 s of audio in 7.4 s) |
| L4 speed | 36× real time. But it took 13 min to get an L4 (none free), and it costs the same per hour of audio |
| Full path (job → function → Modal → storage + `ra_audio`), 7 sentences, cold | done in 32 s |
| MP3 | mono, 24 kHz, 48 kbps |
| Word times vs an independent listener (faster-whisper), 12 sentences, 174 words | median **55 ms** off, 83% within 100 ms |
| Same audio with the PC's estimate method | median 305 ms off, 20% within 100 ms |

Whisper's own word times are only about ±50 ms exact. So 55 ms is close to the best this
check can show.

## Cost

Prices from modal.com/pricing: T4 $0.000164/s, CPU $0.0000131/core/s, memory
$0.00000222/GiB/s. That is about **$0.66 per hour while a container is up**. Starter plan:
$30 free credit every month, but a payment method must be on file.

For one book of about 77,000 words (about 8 h of audio):
- **Rendered in big batches (the whole book, or a chapter at a time):** about 19 min of GPU
  time, so **about $0.21 per book**. The $30 credit covers about 140 books a month.
- **Rendered 4 sentences at a time while listening:** the container never gets 60 s of rest,
  so it stays up for the whole 8 h. That is **about $5.30 per book**, and the $30 covers only
  about 5 books.

**So `modal` must be asked for big batches, early.** See the proposed contract changes below.

## Proposed contract changes

1. **`modal` batch size.**
   - Problem: the phone now asks for about 4 sentences per job, so the container stays up the whole listening time.
   - Proposal: ask for 40 sentences, and ask again when about 15 are left.
   - Cost: about $1–2 per book instead of $5.
2. **"Download book" for `modal`.** Render every sentence in jobs of 40, one after another. Cost: about $0.21 per book.
3. **Partly estimated marks.** Add the optional fields `chunks[k].estimated: true` and `estimatedWords: n` for words the model did not time. The top-level `estimated` stays `false`, unless every word was filled.
4. **Ping.** `{"ping": true}` → `200 {"ok": true}`, with CORS on every answer. This is already done here.

## Commands

The commands below are for Git Bash. In PowerShell, run them one at a time, without `&&`.

If Python fails with certificate errors (some antivirus tools intercept HTTPS),
point `SSL_CERT_FILE` at a CA bundle that includes your antivirus root certificate.

```bash
cd engines/modal
.venv/Scripts/modal deploy kokoro_worker.py         # redeploy the worker
.venv/Scripts/modal run bench.py                    # all measurements (T4, L4, word check)
.venv/Scripts/modal run bench.py --skip-l4
.venv/Scripts/modal run bench.py --check-only       # only the word-time check
```
