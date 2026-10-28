// Supabase settings for the cloud version come from `supabase-config.js`
// (gitignored; copy `supabase-config.example.js`). Without that file the app
// still works fully in local mode; only the cloud features are off.
let local = {};
try {
  local = await import("./supabase-config.js");
} catch {}
export const SUPABASE_URL = local.SUPABASE_URL || "";
export const SUPABASE_KEY = local.SUPABASE_KEY || "";
export const CLOUD_READY = /^https:\/\/.+/.test(SUPABASE_URL) && !SUPABASE_URL.includes("YOUR-PROJECT") && SUPABASE_KEY.length > 20;
export const BUCKET = "readaloud";

// The four voice engines (docs/CLOUD-CONTRACT.md).
export const ENGINES = [
  { id: "pc", name: "My PC", note: "Kokoro on your computer. Free. The PC must be on." },
  { id: "kokoro_api", name: "Cloud API", note: "Kokoro at DeepInfra. Works when the PC is off." },
  { id: "modal", name: "Own GPU", note: "Kokoro on a Modal GPU. Fast for whole chapters." },
  { id: "device", name: "Phone voice", note: "The voice built into this device. Works offline." },
];

// Same list as server/tts.js. All three Kokoro engines use these ids.
export const KOKORO_VOICES = [
  { id: "af_heart", name: "Heart", accent: "US" },
  { id: "af_bella", name: "Bella", accent: "US" },
  { id: "af_nicole", name: "Nicole (soft)", accent: "US" },
  { id: "af_sarah", name: "Sarah", accent: "US" },
  { id: "am_michael", name: "Michael", accent: "US" },
  { id: "am_fenrir", name: "Fenrir", accent: "US" },
  { id: "am_puck", name: "Puck", accent: "US" },
  { id: "bf_emma", name: "Emma", accent: "UK" },
  { id: "bm_george", name: "George", accent: "UK" },
  { id: "bm_fable", name: "Fable", accent: "UK" },
];
