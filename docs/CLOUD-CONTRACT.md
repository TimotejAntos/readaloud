# ReadAloud cloud contract

How the phone app, Supabase and the voice engines talk to each other. Every
engine follows these rules, so they can be swapped in Settings and compared.

One phone app (PWA) + one Supabase project + **three voice engines**:

| Engine id | Where the voice is made | Code |
|---|---|---|
| `pc` | Your own PC (Kokoro code in `server/tts.js`) | `pc-worker/` |
| `kokoro_api` | DeepInfra's hosted Kokoro, called from a Supabase Edge Function | `supabase/functions/ra-engine-kokoro-api/` |
| `modal` | Our own Kokoro on a Modal T4 GPU | `engines/modal/`, `supabase/functions/ra-engine-modal/` |
| `device` | The phone's built-in voice (no audio files, fallback) | `public/js/player.js` |

## Supabase project

- Any Supabase project works, including one you already use for other things.
  The migration only **adds**: everything starts with `ra_` (tables, functions,
  policies) or lives in the private bucket `readaloud`.
- Auth redirect URLs: add your app's URLs; never remove other ones.

## Tables (`supabase/migrations/`)

```
ra_documents   id uuid pk, user_id uuid (auth.uid()), title, file_name, bytes,
               pages int, words int, pdf_path, doc_path, position jsonb {"word":0},
               created_at, opened_at, updated_at
ra_render_jobs id uuid pk, user_id, document_id, engine text, voice text,
               items jsonb  [{ "i": <sentence index>, "text": "<sentence text>" }],
               status text  queued | working | done | error,
               error text, created_at, updated_at
ra_audio       key text pk, user_id, engine, voice, audio_path, format,
               duration_ms int, marks jsonb, created_at
```

RLS on all three: a user sees and writes only rows with `user_id = auth.uid()`.
Engines write with the service role (inside Supabase, or a key in a local `.env`).
Realtime is on for `ra_render_jobs`, `ra_audio`, `ra_documents`.

## Storage (bucket `readaloud`, private)

```
pdfs/{user_id}/{document_id}.pdf
docs/{user_id}/{document_id}.json          parsed words/paragraphs/sentences (made once)
audio/{user_id}/{engine}/{voice}/{key}.mp3
```

## The audio key

`key = sha1(engine + "|" + voice + "|" + text)`, where `text` is the sentence with
all whitespace collapsed to single spaces and trimmed. Same text + voice + engine
= same file, so nothing is made twice.

## Request flow

1. Phone needs sentences i..j. It looks up their keys in `ra_audio`.
2. For missing ones it inserts **one** `ra_render_jobs` row (`items` carries the texts).
3. Engine `pc`: the PC worker hears the insert over Realtime.
   Engines `kokoro_api` / `modal`: the phone calls the Edge Function
   `ra-engine-kokoro-api` or `ra-engine-modal` with `{ "job_id": "…" }` and the
   user's JWT. The function checks the job belongs to that user.
4. The engine sets the job to `working`, then **for each sentence as soon as it is
   ready**: upload the mp3, insert the `ra_audio` row. At the end: `done` (or `error`
   with a short message).
5. The phone hears `ra_audio` inserts over Realtime and plays.

Job size: the phone asks ~3 sentences ahead for `pc` and `kokoro_api`. `modal` may
take bigger jobs (up to ~40 sentences / one chapter) — keep each Edge Function call
under the Supabase wall-clock limit.

## Audio format

MP3, mono, 24 kHz, 32–48 kbps (plays on iPhone and Android).

## Speech marks (`ra_audio.marks`) — same shape as today and as Speechify's

```json
{ "type": "sentence", "value": "<text>", "start": 0, "end": <len>,
  "startTime": 0, "endTime": <ms>, "estimated": true|false,
  "chunks": [ { "type": "word", "value": "Hello", "start": 0, "end": 5,
                "startTime": 120, "endTime": 410 } ] }
```

**Hard rule:** exactly one chunk per whitespace-separated word of `text`
(`text.split(/\s+/)`), in order. Punctuation stays attached to its word. The
player maps chunk *k* to word *k*. `estimated: false` only when the times come
from the model itself.

## Secrets

No key is ever in the code. Each person adds their own keys in the right
dashboard (Supabase → Edge Functions → Secrets, Modal → Secrets) or in a local
`.env` (gitignored). Names: `DEEPINFRA_API_KEY`, `MODAL_ENGINE_URL`,
`MODAL_ENGINE_TOKEN`, and `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
(PC worker `.env` only). The browser only gets the project URL and the
publishable key, from `public/js/supabase-config.js`.
