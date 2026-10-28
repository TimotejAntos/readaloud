// One-off probe: how fast is Kokoro on this CPU, per dtype?
import { KokoroTTS } from "kokoro-js";
import os from "node:os";
console.log("cpus", os.cpus().length, os.cpus()[0].model);
const text = "Reading out loud helps you remember more, because you hear the words while your eyes follow them on the page.";
for (const dtype of [process.argv[2] || "q8"]) {
  const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype, device: "cpu" });
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    const a = await tts.generate(text, { voice: "af_heart" });
    const sec = a.audio.length / 24000;
    console.log(dtype, "run", i, "gen ms", Date.now() - t, "audio s", sec.toFixed(2), "x realtime", (sec * 1000 / (Date.now() - t)).toFixed(2));
  }
}
