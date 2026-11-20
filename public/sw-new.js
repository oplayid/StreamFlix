const CACHE_NAME = "streamflix-cache-v2";
const ASSET_CACHE = "streamflix-assets-v2";
const OFFLINE_URL = "/offline";

const PRECACHE_URLS = ["/", OFFLINE_URL, "/browse"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches
        .keys()
        .then((keys) =>
          Promise.all(
            keys.filter((k) => k !== CACHE_NAME && k !== ASSET_CACHE).map((k) => caches.delete(k)),
          ),
        ),
      self.clients.claim(),
    ]),
  );
});

const IMG_EXT = /\.(png|jpg|jpeg|gif|webp|avif|svg|ico)$/i;

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  if (request.method !== "GET") return;

  if (url.hostname === "image.tmdb.org") {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.destination === "image" || IMG_EXT.test(url.pathname)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (
    request.destination === "style" ||
    request.destination === "script" ||
    request.destination === "font"
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(navigationFallback(request));
    return;
  }

  if (url.pathname.startsWith("/api/") || url.pathname.includes("tmdb")) {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(networkFirst(request));
});

async function navigationFallback(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;
    const offlinePage = await caches.match(OFFLINE_URL);
    if (offlinePage) return offlinePage;
    return new Response("Offline", {
      status: 503,
      headers: { "Content-Type": "text/html" },
    });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(ASSET_CACHE);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    return caches.match(OFFLINE_URL);
  }
}

async function networkFirst(request) {
  try {
    const res = await fetch(request);
    if (res.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(request);
    return cached || caches.match(OFFLINE_URL);
  }
}

// Web Push (self-hosted). Payload: { title, body, url, movie_id }
self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "StreamFlix";
  const options = {
    body: data.body || "Something new to watch.",
    icon: "/icon.png",
    badge: "/icon.png",
    tag: data.movie_id ? `release-${data.movie_id}` : "streamflix",
    data: { url: data.url || "/", movie_id: data.movie_id || "" },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url;
  const destination = target && target.startsWith("/") ? new URL(target, self.location.origin).href : target || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin === new URL(destination).origin) {
          client.navigate(destination);
          return client.focus();
        }
      }
      return self.clients.openWindow(destination);
    }),
  );
});
