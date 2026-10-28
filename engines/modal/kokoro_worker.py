"""ReadAloud voice engine `modal`: Kokoro-82M (official Python package) on a Modal GPU.

Unlike the ONNX build in server/tts.js, the Python KPipeline returns per-token
start/end times taken from the model's own predicted phoneme durations. We merge
them into exactly one chunk per whitespace word (docs/CLOUD-CONTRACT.md), so the
phone can highlight the word that is really being spoken.

Endpoint: POST <url>  Authorization: Bearer <MODAL_ENGINE_TOKEN>
  body   {"voice": "af_heart", "items": [{"i": 3, "text": "Hello there."}, ...]}
  answer NDJSON, one line per item as soon as it is ready:
         {"i": 3, "ok": true, "mp3": "<base64>", "duration_ms": 1234,
          "marks": {...}, "gen_ms": 85}
         or {"i": 3, "ok": false, "error": "..."}
         A last line {"done": true, "gen_ms": ..., "audio_ms": ...} closes it.

Deploy:  modal deploy engines/modal/kokoro_worker.py
"""

import base64
import hmac
import json
import os
import re
import time

import modal

APP_NAME = "readaloud-kokoro"
REPO_ID = "hexgrad/Kokoro-82M"
SAMPLE_RATE = 24000
MP3_KBPS = 48

# Same ids as VOICES in server/tts.js. First letter = Kokoro language ('a' US, 'b' UK).
VOICES = [
    "af_heart", "af_bella", "af_nicole", "af_sarah", "am_michael",
    "am_fenrir", "am_puck", "bf_emma", "bm_george", "bm_fable",
]


def _prefetch():
    """Runs once at image build: puts weights, voices and the spaCy model in the image."""
    from kokoro import KModel, KPipeline

    model = KModel(repo_id=REPO_ID)
    for lang in ("a", "b"):
        pipe = KPipeline(lang_code=lang, repo_id=REPO_ID, model=model)
        for v in VOICES:
            if v[0] == lang:
                pipe.load_voice(v)
        # One tiny run so every lazy download (spaCy, espeak data) happens now.
        list(pipe("Warm up.", voice=next(v for v in VOICES if v[0] == lang)))


image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("espeak-ng")
    .pip_install(
        "kokoro==0.9.4",
        "soundfile",
        "lameenc==1.8.1",
        "fastapi[standard]",
    )
    .env({"HF_HOME": "/models/hf", "HF_HUB_DISABLE_TELEMETRY": "1"})
    .run_function(_prefetch)
    .env({"HF_HUB_OFFLINE": "1"})  # never download on wake-up
)

app = modal.App(APP_NAME, image=image)

with image.imports():  # only inside the container
    from fastapi import Request
    from fastapi.responses import JSONResponse, StreamingResponse


# ---------------------------------------------------------------- speech marks

_NORMAL = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"',
                         "–": "-", "—": "-", "…": "."})
_PUNCT = re.compile(r"^[\W_]+$", re.UNICODE)


def build_marks(text, tokens_with_offset, duration_ms):
    """Merge Kokoro tokens into one chunk per whitespace word of `text`.

    tokens_with_offset: [(token_text, start_s|None, end_s|None, offset_s)]
    Words with no model time get an estimate between their neighbours and are
    flagged with "estimated": true on the chunk.
    """
    words = [{"value": m.group(0), "start": m.start(), "end": m.end()} for m in re.finditer(r"\S+", text)]
    word_at = [-1] * len(text)
    for k, w in enumerate(words):
        for c in range(w["start"], w["end"]):
            word_at[c] = k

    norm = text.translate(_NORMAL)  # 1:1 char replacement, positions stay the same
    spoken = [[] for _ in words]  # times of word tokens
    punct = [[] for _ in words]   # times of punctuation tokens (fallback)
    cursor = 0
    for tok, s, e, off in tokens_with_offset:
        t = (tok or "").translate(_NORMAL).strip()
        if not t:
            continue
        # Look a little ahead only, so one odd token cannot drag the cursor away.
        p = norm.find(t, cursor, cursor + len(t) + 40)
        if p < 0:
            continue
        cursor = p + len(t)
        k = word_at[p]
        if k < 0 or s is None or e is None:
            continue
        (punct if _PUNCT.match(t) else spoken)[k].append(((s + off) * 1000, (e + off) * 1000))

    times = []
    for k in range(len(words)):
        got = spoken[k] or punct[k]
        times.append((min(a for a, _ in got), max(b for _, b in got)) if got else None)

    # Fill gaps: share the space between known neighbours by letter count.
    filled = 0
    k = 0
    while k < len(words):
        if times[k] is not None:
            k += 1
            continue
        j = k
        while j < len(words) and times[j] is None:
            j += 1
        lo = times[k - 1][1] if k > 0 else 0.0
        hi = times[j][0] if j < len(words) else float(duration_ms)
        if hi < lo:
            hi = lo
        weights = [max(1, len(re.sub(r"[\W_]", "", words[n]["value"]))) for n in range(k, j)]
        total = sum(weights)
        t = lo
        for n, wgt in zip(range(k, j), weights):
            nt = t + (hi - lo) * wgt / total
            times[n] = (t, nt, "est")
            t = nt
            filled += 1
        k = j

    chunks = []
    prev = 0
    for w, tm in zip(words, times):
        start = max(prev, int(round(tm[0])))
        end = max(start, int(round(tm[1])))
        prev = start
        c = {"type": "word", "value": w["value"], "start": w["start"], "end": w["end"],
             "startTime": start, "endTime": min(end, duration_ms)}
        if len(tm) == 3:
            c["estimated"] = True
        chunks.append(c)

    marks = {"type": "sentence", "value": text, "start": 0, "end": len(text),
             "startTime": 0, "endTime": duration_ms, "estimated": False, "chunks": chunks}
    if filled:
        marks["estimatedWords"] = filled
    if filled == len(words):
        marks["estimated"] = True  # nothing came from the model
    return marks


# ---------------------------------------------------------------- the engine

@app.cls(
    gpu="T4",
    scaledown_window=60,   # stay warm 60 s after the last request, then scale to zero
    max_containers=1,      # one GPU at most: caps the bill
    timeout=600,
    secrets=[modal.Secret.from_name("readaloud-engine")],
)
class Kokoro:
    @modal.enter()
    def load(self):
        t = time.time()
        import torch
        from kokoro import KModel, KPipeline

        self.torch = torch
        self.device = "cuda" if torch.cuda.is_available() else "cpu"
        self.model = KModel(repo_id=REPO_ID).to(self.device).eval()
        self.pipes = {lang: KPipeline(lang_code=lang, repo_id=REPO_ID, model=self.model) for lang in ("a", "b")}
        for v in VOICES:
            self.pipes[v[0]].load_voice(v)
        list(self.pipes["a"]("Ready.", voice="af_heart"))  # first CUDA run is slow; do it here
        self.load_ms = int((time.time() - t) * 1000)
        print(f"[kokoro] loaded on {self.device} in {self.load_ms} ms")

    def render(self, text, voice):
        import lameenc
        import numpy as np

        t = time.time()
        pipe = self.pipes[voice[0]]
        parts, toks, offset = [], [], 0.0
        with self.torch.inference_mode():
            for r in pipe(text, voice=voice, speed=1, split_pattern=None):
                if r.audio is None:
                    continue
                audio = r.audio.detach().cpu().numpy().astype(np.float32)
                for tk in r.tokens or []:
                    toks.append((tk.text, tk.start_ts, tk.end_ts, offset))
                parts.append(audio)
                offset += len(audio) / SAMPLE_RATE
        if not parts:
            raise ValueError("no audio")
        samples = np.concatenate(parts)
        duration_ms = int(round(len(samples) / SAMPLE_RATE * 1000))
        pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2").tobytes()

        enc = lameenc.Encoder()
        enc.set_bit_rate(MP3_KBPS)
        enc.set_in_sample_rate(SAMPLE_RATE)
        enc.set_channels(1)
        enc.set_quality(2)
        mp3 = enc.encode(pcm) + enc.flush()

        marks = build_marks(text, toks, duration_ms)
        return mp3, duration_ms, marks, int((time.time() - t) * 1000)

    def stream(self, voice, items):
        gen_ms = audio_ms = 0
        for it in items:
            i = it.get("i")
            text = re.sub(r"\s+", " ", str(it.get("text") or "")).strip()
            if not text:
                yield json.dumps({"i": i, "ok": False, "error": "empty text"}) + "\n"
                continue
            try:
                mp3, dur, marks, ms = self.render(text, voice)
                gen_ms += ms
                audio_ms += dur
                yield json.dumps({"i": i, "ok": True, "mp3": base64.b64encode(mp3).decode(),
                                  "duration_ms": dur, "marks": marks, "gen_ms": ms}) + "\n"
            except Exception as e:  # one bad sentence must not kill the batch
                yield json.dumps({"i": i, "ok": False, "error": str(e)[:300]}) + "\n"
        yield json.dumps({"done": True, "gen_ms": gen_ms, "audio_ms": audio_ms, "load_ms": self.load_ms}) + "\n"

    @modal.fastapi_endpoint(method="POST", label="readaloud-kokoro")
    async def synth(self, request: "Request"):
        expected = os.environ.get("MODAL_ENGINE_TOKEN", "")
        given = (request.headers.get("authorization") or "").removeprefix("Bearer ").strip()
        if not expected or not hmac.compare_digest(given, expected):
            return JSONResponse({"error": "unauthorized"}, status_code=401)
        try:
            body = await request.json()
        except Exception:
            return JSONResponse({"error": "body must be JSON"}, status_code=400)

        voice = body.get("voice")
        items = body.get("items")
        if voice not in VOICES:
            return JSONResponse({"error": f"unknown voice {voice!r}"}, status_code=400)
        if not isinstance(items, list) or not items or len(items) > 60:
            return JSONResponse({"error": "items must be a list of 1-60"}, status_code=400)
        return StreamingResponse(self.stream(voice, items), media_type="application/x-ndjson")

    @modal.method()
    def batch(self, voice, items):
        """Same work as the web endpoint, for tests and benchmarks (no HTTP)."""
        return [json.loads(line) for line in self.stream(voice, items)]
