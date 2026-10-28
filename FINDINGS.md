# How Speechify reads — REA teardown (2026-10-26)

Goal: learn how Speechify turns text into speech with a moving word highlight,
so ReadAloud can copy the *technique* (not code or assets).

## What I did

1. Opened `https://app.speechify.com/` in a throwaway headless Chrome (empty
   profile, no login). It redirects to `/auth`, but the page still loads the
   whole app bundle, including the reader SDK.
2. REA `analyze_web_bundle` — 106 scripts parsed, 0 failures, 41 routes and
   69 endpoints found. Evidence `ev_6b483ad7…8437e2`.
3. REA `inspect_web_page` with script sources (10 MB), then
   `export_evidence_bundle` + `export_web_scripts` to read the code on disk.
   Evidence `ev_0ce153a5…7f5f9d`.
4. Searched the reader SDK (`multiplatform-sdk-*.js`, Kotlin compiled to JS)
   for timing, speed and chunking code.

The scripts were static files. REA parsed them; nothing was run, and no
account or paid feature was touched.

## What I found (observed in their code)

| Question | Answer | Where |
|---|---|---|
| What does the voice server send back? | `AudioServerResponse { audioData, audioFormat, speechMarks, contextToken }` | SDK serializer `com.speechify.client.api.services.audio.AudioServerResponse` |
| What are speech marks? | `{ type: "sentence", value, start, end, startTime, endTime, chunks: [...] }`, one chunk per word, with char offsets + ms times | audio merge helper in `SheetHeader-*.js` |
| How does a time become a highlight? | `getCharacterIndexAtTime(t)`: take the first chunk whose `endTime >= t`, then interpolate the char index inside it | `SpeechMarksImpl` in the SDK |
| How is speed done? | A speed factor (old setting was WPM, converted with `wpmToSpeedFactor`) passed as `playbackRate` to the audio player. Audio is **not** made again. | `setSpeedFactor`, `hdAudioPlayerFn(text, playbackRate, audio)` |
| Does it read ahead? | Yes. A prefetch policy that depends on `playbackRate` and voice (`maxLookahead`, `bufferTargetSeconds`) | playback state machine |
| Is there an offline voice? | Yes. `AdaptiveMediaSynthesisService`: "Server synthesis failed, falling back to on-device", plus a `localAudioPlayerFn` path | SDK |
| Streaming? | `StreamChunk { chunkIndex, audioData, audioDurationMs, speechMarks, isFinal }` and an `AudioContext` merge of chunks into one WAV | SDK + merge helper |
| Player events | `AUDIO_PROGRESSED { playableId, charIndex }`, `AUDIO_PLAYBACK_ENDED`, `AUDIO_CHUNK_NOT_READY` | playback state machine |
| UI | autoscroll button that turns off when you scroll; `wakeLock("screen")` while reading | app bundle |

## What ReadAloud copies

- Same response shape (`audioData`, `audioFormat`, `speechMarks`) from our local server.
- Sentence-sized utterances, 3 sentences fetched ahead.
- Time → word lookup every frame.
- Speed = `playbackRate` with pitch kept.
- A second, on-device engine (the browser/Windows voices) as fallback.
- Autoscroll that stops when you scroll by hand, with a "back to reading" button.

## What is different (and why)

- Speechify's cloud voices return **real** word timings. Kokoro's model only
  returns audio, so ReadAloud **estimates** word times from phoneme counts,
  punctuation pauses and the real start/end of speech. Close, not perfect.
- Speechify streams audio in chunks. ReadAloud makes one WAV per sentence.

## Unknowns

- Their server-side voice models and how they compute marks (not in the client).
- Their PDF text extraction (it runs after login; not observed).
