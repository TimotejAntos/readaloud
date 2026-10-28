// Pack the phone app for static hosting (Vercel): public/ + the vendor files
// the local server normally serves from node_modules.
//   node scripts/build-web.js   ->  web-dist/

import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "web-dist");
const nm = (...p) => path.join(ROOT, "node_modules", ...p);

// Empty the folder but keep .vercel (the link to the Vercel project).
mkdirSync(OUT, { recursive: true });
for (const name of readdirSync(OUT)) if (name !== ".vercel") rmSync(path.join(OUT, name), { recursive: true, force: true });
cpSync(path.join(ROOT, "public"), OUT, { recursive: true });

const vendor = [
  // Legacy build: the normal one uses Map.getOrInsertComputed and Math.sumPrecise, which Safari lacks.
  [nm("pdfjs-dist", "legacy", "build", "pdf.mjs"), "vendor/pdfjs/pdf.mjs"],
  [nm("pdfjs-dist", "legacy", "build", "pdf.worker.mjs"), "vendor/pdfjs/pdf.worker.mjs"],
  [nm("pdfjs-dist", "standard_fonts"), "vendor/pdfjs-fonts"],
  [nm("pdfjs-dist", "cmaps"), "vendor/pdfjs-cmaps"],
  [nm("@supabase", "supabase-js", "dist", "umd", "supabase.js"), "vendor/supabase/supabase.js"],
];
for (const [from, to] of vendor) cpSync(from, path.join(OUT, to), { recursive: true });

writeFileSync(path.join(OUT, "robots.txt"), "User-agent: *\nDisallow: /\n");
writeFileSync(
  path.join(OUT, "vercel.json"),
  JSON.stringify(
    {
      headers: [
        { source: "/(.*)", headers: [{ key: "X-Robots-Tag", value: "noindex, nofollow" }] },
        { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
        { source: "/(index.html|)", headers: [{ key: "Cache-Control", value: "no-cache" }] },
      ],
    },
    null,
    2,
  ),
);
console.log("built", OUT);
