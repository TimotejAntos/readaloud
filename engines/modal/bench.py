"""Test and measure the deployed `modal` engine with synthetic text.

  modal run engines/modal/bench.py            # T4 + L4 + word-time check
  modal run engines/modal/bench.py --skip-l4

Reads MODAL_ENGINE_URL / MODAL_ENGINE_TOKEN from engines/modal/.env (gitignored).
Writes engines/modal/bench-out/results.json and a few sample MP3s.

Word-time check: an independent model (faster-whisper, word timestamps, CPU)
listens to the MP3s and we compare its word start times with our marks.
"""

import base64
import difflib
import json
import pathlib
import re
import statistics
import time
import urllib.request

import modal

HERE = pathlib.Path(__file__).parent
OUT = HERE / "bench-out"

# Original synthetic text: plain prose plus numbers, quotes, dashes and abbreviations.
SENTENCES = [
    "The lighthouse keeper climbed the stairs at dusk, counting each step out loud.",
    "There were one hundred and twelve of them, and he knew every crack by heart.",
    "Tonight the sea was calm, but the radio said a storm would arrive before dawn.",
    "He wiped the big lens, checked the oil, and wrote the time in his notebook: 6:45 p.m.",
    "Far below, a small boat was still heading out, its engine coughing like an old dog.",
    "“Turn back,” he whispered, although nobody could hear him from up here.",
    "In 1987 a ship called the Margaret had ignored the same kind of warning.",
    "Only three of the twenty-four sailors on board made it back to the harbor.",
    "His grandmother had told him the story so often that he could recite it word for word.",
    "She always ended it the same way — with a long pause and a cup of very sweet tea.",
    "The wind changed direction around eight o'clock and began to push from the north.",
    "Clouds rolled in quickly, swallowing the last strip of orange light on the horizon.",
    "He switched on the lamp, and the beam swept across the water every ten seconds.",
    "Somewhere out there, the little boat turned slowly and started back toward shore.",
    "Relief washed over him; he hadn't noticed how tightly he was gripping the railing.",
    "Dr. Ellis, the village doctor, would later say the keeper saved two lives that night.",
    "The keeper himself never talked about it, not even when the newspaper called.",
    "Rain arrived at 9:30, heavy and loud, drumming on the iron roof above the lamp room.",
    "By midnight the waves were taller than the harbor wall, white and furious.",
    "He made himself a sandwich, sat by the window, and watched the beam go round and round.",
    "Was he afraid? Perhaps a little, but mostly he felt awake, more awake than in years.",
    "At 3 a.m. the power failed, and the backup generator rattled into life after a moment.",
    "The light kept turning, steady as a heartbeat, while the tower shook in the gusts.",
    "When morning came, the storm had moved east and left behind a strange, glassy calm.",
    "Seaweed covered the rocks, and a broken crate had washed up on the tiny beach.",
    "Inside the crate he found forty-two tins of peaches, every single one unopened.",
    "He laughed for the first time in days and carried them up the stairs, two at a time.",
    "Later that week, a letter arrived from the fisherman's daughter, written in pencil.",
    "It said only: “Thank you for keeping the light on. We saw it the whole way home.”",
    "He pinned the letter above his desk, right next to his grandmother's old photograph.",
    "Years passed, the lighthouse was automated, and the keeper moved to a cottage inland.",
    "Still, on stormy nights, he would wake at three and listen for the generator.",
]

WORDS = sum(len(s.split()) for s in SENTENCES)


def load_env():
    env = {}
    for line in (HERE / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip()
    return env


def post_stream(url, token, voice, items):
    """POST to the web endpoint, return (seconds to first sentence, seconds total, lines)."""
    req = urllib.request.Request(
        url, method="POST", data=json.dumps({"voice": voice, "items": items}).encode(),
        headers={"authorization": f"Bearer {token}", "content-type": "application/json"})
    t = time.time()
    first = None
    lines = []
    with urllib.request.urlopen(req, timeout=600) as res:
        for raw in res:
            if raw.strip():
                if first is None:
                    first = time.time() - t
                lines.append(json.loads(raw))
    return first, time.time() - t, lines


app = modal.App("readaloud-bench")

whisper_image = (
    modal.Image.debian_slim(python_version="3.12")
    .apt_install("ffmpeg")
    .pip_install("faster-whisper==1.1.1", "huggingface_hub<1.0", "requests")
    .run_commands("python -c \"from faster_whisper import WhisperModel; WhisperModel('small.en', device='cpu', compute_type='int8')\"")
)


@app.function(image=whisper_image, cpu=4, memory=4096, timeout=900)
def whisper_words(mp3s: list[bytes]) -> list[list[dict]]:
    import subprocess

    import numpy as np
    from faster_whisper import WhisperModel

    def pcm16k(mp3):  # decode with ffmpeg (PyAV's API changed under faster-whisper)
        raw = subprocess.run(["ffmpeg", "-v", "quiet", "-i", "pipe:0", "-f", "f32le", "-ac", "1", "-ar", "16000", "pipe:1"],
                             input=mp3, capture_output=True, check=True).stdout
        return np.frombuffer(raw, dtype=np.float32)

    model = WhisperModel("small.en", device="cpu", compute_type="int8")
    out = []
    for b in mp3s:
        segs, _ = model.transcribe(pcm16k(b), word_timestamps=True, beam_size=5, language="en")
        out.append([{"w": w.word.strip(), "start": float(w.start) * 1000, "end": float(w.end) * 1000}
                    for s in segs for w in (s.words or [])])
    return out


def norm(w):
    return re.sub(r"[^a-z0-9]", "", w.lower())


def compare(marks, heard):
    """Match our words with Whisper's words; return start-time differences in ms."""
    ours = [c for c in marks["chunks"] if norm(c["value"])]
    a = [norm(c["value"]) for c in ours]
    b = [norm(h["w"]) for h in heard]
    diffs = []
    for blk in difflib.SequenceMatcher(None, a, b, autojunk=False).get_matching_blocks():
        for k in range(blk.size):
            diffs.append(ours[blk.a + k]["startTime"] - heard[blk.b + k]["start"])
    return diffs, len(ours)


def estimate_like_pc(marks):
    """The PC engine's method (server/tts.js, letter fallback): share the speech
    window by word length plus punctuation pauses. Same window as the model's."""
    ch = marks["chunks"]
    lo, hi = ch[0]["startTime"], ch[-1]["endTime"]
    w = [max(1, len(re.sub(r"[^\w]", "", c["value"]))) * 0.8 + 1.2 for c in ch]
    pz = [5 if re.search(r"[.!?…][\"')\]”]*$", c["value"]) else 3 if re.search(r"[,;:—–][\"')\]”]*$", c["value"]) else 0 for c in ch]
    unit = (hi - lo) / (sum(w) + sum(pz[:-1]))
    t, out = lo, []
    for k, c in enumerate(ch):
        out.append({**c, "startTime": round(t)})
        t += (w[k] + (pz[k] if k < len(ch) - 1 else 0)) * unit
    return {**marks, "chunks": out}


def stats(diffs):
    ad = sorted(abs(x) for x in diffs)
    return {"median_abs_ms": round(statistics.median(ad)), "p90_abs_ms": round(ad[int(len(ad) * 0.9)]),
            "within_100ms_pct": round(100 * sum(x <= 100 for x in ad) / len(ad))}


def save(results):
    (OUT / "results.json").write_text(json.dumps(results, indent=2))


@app.local_entrypoint()
def main(skip_l4: bool = False, check_only: bool = False):
    OUT.mkdir(exist_ok=True)
    env = load_env()
    url, token = env["MODAL_ENGINE_URL"], env["MODAL_ENGINE_TOKEN"]
    items = [{"i": i, "text": s} for i, s in enumerate(SENTENCES)]
    results = {"sentences": len(SENTENCES), "words": WORDS}
    if check_only and (OUT / "results.json").exists():
        results = json.loads((OUT / "results.json").read_text())
    Kokoro = modal.Cls.from_name("readaloud-kokoro", "Kokoro")

    # 1. Wake-up from zero, through the real HTTPS endpoint (what the Edge Function sees).
    if check_only:
        _, _, lines = post_stream(url, token, "am_michael", items[:12])
        full = [l for l in lines if l.get("ok")]
        return word_check(results, full)
    first, total, lines = post_stream(url, token, "af_heart", items[:4])
    results["t4_cold"] = {"first_sentence_s": round(first, 2), "four_sentences_s": round(total, 2),
                          "load_ms": lines[-1].get("load_ms")}
    print("T4 cold:", results["t4_cold"])
    save(results)

    # 2. Warm: same size request again.
    first, total, _ = post_stream(url, token, "af_heart", items[4:8])
    results["t4_warm"] = {"first_sentence_s": round(first, 2), "four_sentences_s": round(total, 2)}
    print("T4 warm:", results["t4_warm"])
    save(results)

    # 3. Throughput on T4: the whole text, warm.
    t = time.time()
    first, total, lines = post_stream(url, token, "am_michael", items)
    done = lines[-1]
    results["t4_full"] = {"wall_s": round(total, 2), "gen_s": round(done["gen_ms"] / 1000, 2),
                          "audio_s": round(done["audio_ms"] / 1000, 1),
                          "x_realtime_gpu": round(done["audio_ms"] / max(1, done["gen_ms"]), 1),
                          "x_realtime_wall": round(done["audio_ms"] / 1000 / total, 1)}
    print("T4 full:", results["t4_full"])
    save(results)
    full = [l for l in lines if l.get("ok")]

    # 4. L4 for comparison (same class, other GPU).
    if not skip_l4:
        l4 = Kokoro.with_options(gpu="L4")()
        t = time.time()
        r = l4.batch.remote("af_heart", items[:4])
        cold = time.time() - t
        t = time.time()
        r = l4.batch.remote("am_michael", items)
        wall = time.time() - t
        d = r[-1]
        results["l4"] = {"cold_four_sentences_s": round(cold, 2), "full_wall_s": round(wall, 2),
                         "gen_s": round(d["gen_ms"] / 1000, 2),
                         "x_realtime_gpu": round(d["audio_ms"] / max(1, d["gen_ms"]), 1)}
        print("L4:", results["l4"])
        save(results)

    word_check(results, full)


def word_check(results, full):
    """5. Do the word times match the audio? Ask an independent listener."""
    sample = full[:12]
    mp3s = [base64.b64decode(l["mp3"]) for l in sample]
    for k, (l, b) in enumerate(zip(sample[:4], mp3s[:4])):
        (OUT / f"sample-{k}.mp3").write_bytes(b)
        (OUT / f"sample-{k}.marks.json").write_text(json.dumps(l["marks"], indent=1))
    heard = whisper_words.remote(mp3s)
    diffs, base, total_words, est_words = [], [], 0, 0
    for l, h in zip(sample, heard):
        d, n = compare(l["marks"], h)
        diffs += d
        base += compare(estimate_like_pc(l["marks"]), h)[0]
        total_words += n
        est_words += l["marks"].get("estimatedWords", 0)
    ad = sorted(abs(x) for x in diffs)
    results["word_check"] = {
        "sentences": len(sample), "words": total_words, "matched": len(diffs),
        "estimated_words": est_words,
        "median_abs_ms": round(statistics.median(ad)),
        "p90_abs_ms": round(ad[int(len(ad) * 0.9)]),
        "mean_signed_ms": round(statistics.mean(diffs)),
        "within_100ms_pct": round(100 * sum(x <= 100 for x in ad) / len(ad)),
        "old_estimate_for_comparison": stats(base),
    }
    print("Word check:", results["word_check"])
    save(results)
    print("Saved", OUT / "results.json")
