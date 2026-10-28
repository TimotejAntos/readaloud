// Service worker: keeps the app shell on the device, so ReadAloud opens
// without internet. Books and audio are kept by the app itself (Cache
// Storage "ra-files"); this file never touches Supabase or /api requests.

const VERSION = "ra-shell-v6";
const SHELL = [
  "/",
  "/index.html",
  "/styles.css",
  "/manifest.webmanifest",
  "/js/app.js",
  "/js/cloud.js",
  "/js/config.js",
  "/js/document.js",
  "/js/offline.js",
  "/js/pdf.js",
  "/js/pdf-worker.mjs",
  "/js/stream-polyfill.js",
  "/js/player.js",
  "/js/reader.js",
  "/vendor/supabase/supabase.js",
  "/vendor/pdfjs/pdf.mjs",
  "/vendor/pdfjs/pdf.worker.mjs",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  // supabase-config.js is optional (local-only installs have none), so it is
  // cached on a best-effort basis and never blocks the install.
  e.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(SHELL).then(() => c.add("/js/supabase-config.js").catch(() => {})))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("ra-shell-") && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Files the app saved for offline (PDFs, docs, audio).
  if (url.pathname.startsWith("/_ra/")) {
    e.respondWith(caches.match(e.request).then((hit) => hit || new Response("not saved", { status: 404 })));
    return;
  }
  // App shell: fresh from the network when online, the saved copy when not.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && (SHELL.includes(url.pathname) || url.pathname.startsWith("/vendor/"))) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || caches.match("/index.html"))),
  );
});
