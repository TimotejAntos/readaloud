# ReadAloud

A Speechify-style reader you run yourself. Upload a PDF, press play, and a
natural AI voice (Kokoro-82M) reads it while each word lights up.

- **Local version:** everything runs on your own computer. No account, no cloud.
- **Cloud version (optional):** a phone app (PWA) with your library in Supabase,
  reading position synced across devices, and a choice of voice engines.

> **No keys are included.** This repo is code only. Every account, key and
> secret below is yours to create. Never commit them: `.env` files and
> `public/js/supabase-config.js` are gitignored.

## Features

- **Library:** drop PDFs on the page. Each book remembers where you stopped.
- **AI voice:** Kokoro-82M, 10 English voices (US + UK). Audio is cached, so re-reading is instant.
- **Follow along:** the current word and sentence light up, on the real PDF page
  (Original view) or in clean text (Text view). Click any word to read from there.
- **Your highlights:** select words (or tap ☆ to save the sentence you hear) in
  8 colors plus your own. Each color has a 1–3 word meaning you choose, like
  "Love this" or "Don't get it". Add notes.
- **Highlights vault:** every highlight with its exact place (book › chapter ›
  page › paragraph), search, filter by meaning, "Open here", and Markdown export.
- **Highlight reel:** listen to only your highlighted words, one after another.
- **Tutor (cloud):** ask about a book or all your books. It answers like a teacher,
  only from your books, with a numbered source for each point that opens the
  exact page or reads it aloud. Flag words "Don't get it" and it explains them
  at once. Quizzes (ABCD, scored, with the page for every answer) after a book
  or whenever you ask. See `docs/TUTOR.md`.
- **Speed:** 0.5× to 3.5×. The pitch stays natural.
- **Text format:** font, size, line spacing, width, light / sepia / dark theme.
- **Keys:** Space = play/pause · ← → = sentence · ↑ ↓ = speed.
- **Cloud extras:** install on your phone, lock-screen controls, sleep timer,
  download a chapter for offline, and continue on another device.

## 1. Local version (Windows, macOS, Linux)

You need [Node.js](https://nodejs.org) 22.15 or newer (`start.cmd` uses `--use-system-ca`).

```bash
npm install
npm start
```

Then open http://localhost:5520. On Windows you can also double-click `start.cmd`.

The first start downloads the voice model (about 330 MB, one time).

If `npm install` or the model download fails with a certificate error, an
antivirus or company proxy is reading your HTTPS traffic. Point the
`NODE_EXTRA_CA_CERTS` environment variable at its root certificate (a `.pem` file).

## 2. Cloud version (optional)

```
PHONE ──job──► SUPABASE ──► voice engine (your PC, DeepInfra, or Modal GPU)
  ▲                              │
  └──── audio + word timings ◄───┘   (saved once, played on every device)
```

### 2.1 Supabase (required for cloud)

1. Make a free project at [supabase.com](https://supabase.com). An existing
   project also works: everything this app adds starts with `ra_`.
2. Run both migrations in `supabase/migrations/`, oldest first
   (`20261028120000_ra_readaloud_base.sql`, `20261029120000_ra_highlights.sql`, `20261031120000_ra_tutor.sql`, `20261031130000_ra_tutor_openai.sql`, then `20261031140000_ra_quizzes.sql`):
   paste each into **SQL Editor → Run**, or use `supabase db push`.
3. Make your login: **Authentication → Users → Add user** (email + password).
   The app does not let strangers sign up.
4. **Authentication → URL Configuration:** add `http://localhost:5520` and your
   hosted app URL as redirect URLs.
5. Copy `public/js/supabase-config.example.js` to `public/js/supabase-config.js`,
   then fill in your **Project URL** and **publishable key**
   (Project Settings → API Keys). Only the publishable key goes here, **never**
   the service role key.

Now open http://localhost:5520, then account button → Library: **Cloud**, and sign in.

### 2.2 Host the phone app (optional)

```bash
node scripts/build-web.js      # makes web-dist/
```

Deploy `web-dist/` to any static host, for example `vercel deploy --prod` from
inside `web-dist/`. On your phone, open the URL → Share → **Add to Home Screen**.

### 2.3 Voice engines (pick any)

| Engine | Where the voice is made | Cost | Word timing | Set up |
|---|---|---|---|---|
| **My PC** | your computer | free | estimated | 2.3a |
| **Cloud API** | DeepInfra (hosted Kokoro) | about $0.99 per 1M characters | from the model | 2.3b |
| **Own GPU** | your Modal account (T4 GPU) | about $0.21 per book in big batches; Modal gives monthly free credit | from the model (about 55 ms) | 2.3c |
| **Phone voice** | the phone itself | free | exact | nothing |

Prices were read on 2026-10-28. Check the providers' pages before you rely on them.

**2.3a My PC**
1. Install [ffmpeg](https://ffmpeg.org) (Windows: `winget install Gyan.FFmpeg`).
2. Copy `pc-worker/.env.example` to `pc-worker/.env`. Fill in `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`. That key can do everything: keep it on this PC only.
3. Run `npm start` (or `start.cmd`). The PC must stay on while you listen with this engine.

**2.3b Cloud API (DeepInfra)**
1. Make a [DeepInfra](https://deepinfra.com) account, add some balance, and create an API key.
2. Supabase → **Edge Functions → Secrets:** add `DEEPINFRA_API_KEY`.
3. Deploy: `supabase functions deploy ra-engine-kokoro-api`.

Details: `supabase/functions/ra-engine-kokoro-api/README.md`.

**2.3c Own GPU (Modal)**
1. Make a [Modal](https://modal.com) account, then `pip install modal` and `modal token new`.
2. Make a long random token. Save it as the Modal secret `readaloud-engine` with the
   key `MODAL_ENGINE_TOKEN`.
3. `modal deploy engines/modal/kokoro_worker.py`. It prints your endpoint URL.
4. Supabase → **Edge Functions → Secrets:** add `MODAL_ENGINE_URL` (that URL) and
   `MODAL_ENGINE_TOKEN` (the same token).
5. Deploy: `supabase functions deploy ra-engine-modal`.

Details, measurements and cost tips: `engines/modal/README.md`.

### Where each secret lives

| Secret | Where you put it | Never put it in |
|---|---|---|
| Supabase publishable key | `public/js/supabase-config.js` | (it is safe in the browser) |
| Supabase service role key | `pc-worker/.env` | the browser, git, chat |
| `DEEPINFRA_API_KEY` | Supabase Edge Function secrets | the browser, git |
| `MODAL_ENGINE_TOKEN` | Modal secret + Supabase Edge Function secrets | the browser, git |
| `OPENAI_API_KEY` (tutor) | Supabase Edge Function secrets | the browser, git |

## How it works

```
PDF ──pdf.js──► words + boxes ──► sentences ──► voice engine ──► audio
                                                    │
     highlight ◄── word at time t ◄── speech marks ◄┘  (start/end time per word)
```

| File | Job |
|---|---|
| `server/server.js`, `server/tts.js`, `server/library.js` | Local server, Kokoro voice, PDFs on disk |
| `public/js/document.js` | PDF → words, paragraphs, sentences |
| `public/js/player.js` | Plays sentences, reads ahead, finds the spoken word |
| `public/js/reader.js` | Original + Text views, highlights, autoscroll |
| `public/js/app.js` | Library, controls, settings |
| `public/js/cloud.js` | Supabase data layer (cloud version) |
| `public/js/highlights.js`, `server/highlights.js` | Highlights, color meanings, exact paths, export |
| `pc-worker/worker.js` | Engine "My PC" |
| `supabase/functions/ra-engine-kokoro-api/` | Engine "Cloud API" |
| `engines/modal/`, `supabase/functions/ra-engine-modal/` | Engine "Own GPU" |
| `docs/CLOUD-CONTRACT.md` | The rules all engines follow |
| `FINDINGS.md` | How Speechify does this, from a reverse-engineering study |

## Known limits

- The local and "My PC" voices **estimate** word timings (that Kokoro build gives
  none). They track well, but can drift by a word in long, number-heavy sentences.
- Scanned PDFs (pictures of text) need OCR, which is not built yet.
- Headers, footers and page numbers are read aloud.

## Ideas for next steps

1. Skip headers, footers and page numbers.
2. OCR for scanned PDFs.
3. More formats: EPUB, Word, web pages, pasted text.

## License

MIT, see `LICENSE`. The voice model (Kokoro-82M) and PDF.js have their own
licenses (both Apache-2.0).

ReadAloud is an independent project. It is not affiliated with Speechify.
