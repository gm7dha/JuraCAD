/*
 * PartSmith's offline helper (a "service worker").
 *
 * It keeps a copy of the app on this computer so PartSmith opens even
 * without an internet connection:
 *  - The page itself is fetched fresh when online (so updates arrive), and
 *    the saved copy is used when offline.
 *  - Everything else (scripts, styles, the geometry engine) has a unique
 *    name per version, so the saved copy is used straight away.
 */
const CACHE = "partsmith-v1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(["./", "./manifest.webmanifest", "./favicon.svg", "./icon-192.png", "./icon-512.png"]))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    // The page: fresh when online, saved copy when offline.
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./", copy));
          return res;
        })
        .catch(() => caches.match("./").then((r) => r || Response.error())),
    );
    return;
  }

  // Everything else: saved copy if we have it, otherwise fetch and save.
  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
