// Incrementar CACHE força purga do cache antigo em todos os clientes
const CACHE = "mo-limpezas-v8";

// Apenas assets estáticos são guardados — HTML é sempre da rede
const PRECACHE = ["/offline"];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(PRECACHE))
      .catch(() => {})
  );
  // NÃO skipWaiting() automático: o novo SW fica em "waiting" até a
  // colaboradora tocar em "Atualizar" — evita recarregar a meio de um ponto.
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Quando o SW actualiza, força reload em todos os clientes abertos
self.addEventListener("message", (e) => {
  if (e.data === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;

  const url = new URL(e.request.url);

  // API e autenticação — sempre rede, nunca cachear
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

  // Assets estáticos — cache-first (JS, CSS, imagens, fonts)
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

  // Páginas HTML — sempre da rede, NUNCA guardar em cache
  // Fallback para /offline se sem ligação
  e.respondWith(
    fetch(e.request).catch(() =>
      caches.match("/offline").then((hit) => hit || new Response("Sem ligação", { status: 503 }))
    )
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
