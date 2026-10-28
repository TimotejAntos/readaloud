# ra-engine-kokoro-api

Voice engine `kokoro_api` for ReadAloud: Kokoro-82M hosted by DeepInfra, run
from a Supabase Edge Function. Contract: `docs/CLOUD-CONTRACT.md`.

## Flow

1. Phone inserts an `ra_render_jobs` row (`engine = kokoro_api`) and calls this
   function with `{ job_id }` and the user's JWT.
2. The function checks the user owns the job, then claims it (`queued` -> `working`).
   A second call for the same job does nothing, unless the first run died and left
   it `working` for over 3 minutes.
3. Up to 3 sentences at a time: check the job still exists (the phone deletes jobs
   it no longer needs), compute `key = sha1("kokoro_api|voice|text")`, skip if
   `ra_audio` has it, else call DeepInfra, upload
   `audio/{user}/kokoro_api/{voice}/{key}.mp3`, insert the `ra_audio` row.
   The phone hears each row over Realtime as soon as it lands.
4. Job ends `done`, or `error` with a short message. The HTTP answer carries the
   same result (200, or 502 with `error`).

`{ "ping": true }` answers `200 {"ok":true}` (the phone's "is it deployed?" check).

## DeepInfra call

`POST https://api.deepinfra.com/v1/inference/hexgrad/Kokoro-82M`
`{ text, preset_voice: [voice], output_format: "mp3", return_timestamps: true, sample_rate: 24000 }`

Answer: `{ audio: "data:audio/mpeg;base64,...", words: [{ text, start, end }], inference_status: { cost } }`.
Price: $0.99 per 1M input characters (`cents_per_input_chars: 0.000099` from
`api.deepinfra.com/models/hexgrad/Kokoro-82M`, read 2026-10-28).

## Speech marks (`marks.ts`)

DeepInfra returns its own word times, so marks come from the model
(`estimated: false`). Its words are matched to ours (`text.split(/\s+/)`) on
letters and digits only, so punctuation tokens and split words ("do" + "n't")
still line up. Words the model said differently ("1990" -> "nineteen ninety")
get times filled in between their matched neighbours; that sentence is then
`estimated: true`. No times ever go past the real mp3 length, which is read
from the MP3 frame headers. No phonemizer or silence trimming is needed.

## Files

| File | What |
|---|---|
| `index.ts` | the Edge Function |
| `marks.ts` | word alignment, speech marks, mp3 length (plain TS, runs in Node too) |
| `smoke-test.mjs` | end-to-end test against the deployed function |
| `practice-voice.ps1` | free stand-in voice for `--practice` (Windows voice) |

## Test

```
node --use-system-ca supabase/functions/ra-engine-kokoro-api/smoke-test.mjs af_heart --practice
```

`--practice` costs nothing: the Windows voice speaks the sentences, ffmpeg makes
the mp3, and the test sends them in DeepInfra's reply shape. Only the service key
may use practice mode. Everything after the DeepInfra call is real (upload,
`ra_audio`, marks, job status), and the test always cleans up.
Without `--practice` it calls DeepInfra for real (needs balance on the account).

## Secret

`DEEPINFRA_API_KEY` in Supabase -> Edge Functions -> Secrets.
