// Versão atualiza automaticamente a cada deploy via next.config.ts headers
const CACHE = "mo-limpezas-v2";
const STATIC = ["/app", "/offline"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(STATIC)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  // Rede sempre para API e autenticação — nunca cachear
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) {
    e.respondWith(
      fetch(e.request).catch(
        () => new Response(JSON.stringify({ error: "offline" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        })
      )
    );
    return;
  }

  // Cache-first para assets estáticos — só cachear respostas 2xx
  if (/\.(js|css|png|jpg|jpeg|svg|ico|woff2?)$/.test(url.pathname)) {
    e.respondWith(
      caches.match(e.request).then((hit) => {
        if (hit) return hit;
        return fetch(e.request).then((res) => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, clone));
          }
          return res;
        });
      })
    );
    return;
  }

  // Network-first para páginas — só cachear respostas 2xx
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/app")))
  );
});

// Notificações push
self.addEventListener("push", (e) => {
  if (!e.data) return;
  let data = {};
  try { data = e.data.json(); } catch { data = { title: "Mó Limpezas", body: e.data.text() }; }

  e.waitUntil(
    self.registration.showNotification(data.title || "Mó Limpezas", {
      body: data.body || "",
      icon: "/icons/icon.svg",
      badge: "/icons/icon.svg",
      data: { url: data.url || "/app" },
      vibrate: [200, 100, 200],
    })
  );
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const url = e.notification.data?.url || "/app";
  e.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      const existing = list.find((c) => c.url.includes("/app"));
      return existing ? existing.focus() : clients.openWindow(url);
    })
  );
});
