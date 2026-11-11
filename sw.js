/* Finanvô — Service Worker — network-first para shell + notificação de update */
// M23 FIX: versão sincronizada com APP_VERSION via query param (?v=<ver>).
// O browser re-registra o SW quando a URL muda, limpando caches antigos.
const _SW_VER   = new URL(self.location.href).searchParams.get('v') || 'v5.5';
const CACHE_NAME = 'finanvo-' + _SW_VER;
// M29 FIX: cache do CDN com nome fixo (sem versão) — bibliotecas raramente mudam
// e não precisam ser re-baixadas a cada deploy do app.
const CACHE_CDN  = 'finanvo-cdn';

const SHELL = [self.registration.scope + 'finapp.html'];

const CDN_ORIGINS = [
  'https://www.gstatic.com',
  'https://cdn.jsdelivr.net',
  'https://cdnjs.cloudflare.com',
  'https://fonts.googleapis.com',
  'https://fonts.gstatic.com'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== CACHE_NAME && k !== CACHE_CDN).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);

  // Nunca interceptar requisições Firebase
  if (url.hostname.includes('firestore.googleapis.com')
    || url.hostname.includes('identitytoolkit.googleapis.com')
    || url.hostname.includes('securetoken.googleapis.com')
    || url.hostname.includes('firebase.googleapis.com')) return;

  // CDN: cache-first (bibliotecas raramente mudam)
  const isCdn = CDN_ORIGINS.some(o => url.href.startsWith(o));
  if (isCdn) {
    e.respondWith(
      caches.open(CACHE_CDN).then(async cache => {
        const hit = await cache.match(e.request);
        if (hit) return hit;
        try {
          const resp = await fetch(e.request);
          if (resp && resp.status === 200) cache.put(e.request, resp.clone());
          return resp;
        } catch(err) { return hit || new Response('', { status: 503 }); }
      })
    );
    return;
  }

  if (url.origin !== self.location.origin) return;

  // M34 FIX: Shell (finapp.html): network-first PURO — sem fallback para cache do shell.
  // O app não funciona sem a rede para autenticar mesmo assim, e o cache do shell
  // estava impedindo que versões novas chegassem ao usuário.
  // Fallback para cache APENAS se a rede falhar (modo offline real).
  const isShell = url.pathname.endsWith('finapp.html') || url.pathname === self.registration.scope;
  if (isShell) {
    e.respondWith((async () => {
      try {
        // Sempre busca da rede primeiro, sem cache de resposta intermediária
        const networkResp = await fetch(e.request, { cache: 'no-store' });
        if (networkResp && networkResp.status === 200) {
          // Atualiza o cache com a versão mais recente
          const cache = await caches.open(CACHE_NAME);
          cache.put(e.request, networkResp.clone());
          return networkResp;
        }
        throw new Error('bad response');
      } catch(err) {
        // Só usa cache em modo offline
        const cache = await caches.open(CACHE_NAME);
        const cached = await cache.match(e.request);
        return cached || new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }

  // Outros recursos do mesmo origem: network-first com fallback para cache
  // e notificação de update quando versão nova está disponível
  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      try {
        const networkResp = await fetch(e.request);
        if (networkResp && networkResp.status === 200) {
          // Comparar com versão em cache para detectar atualização
          const cached = await cache.match(e.request);
          if (cached) {
            // Verifica se o conteúdo mudou pelo header ETag ou Last-Modified
            const cachedDate = cached.headers.get('last-modified') || cached.headers.get('etag');
            const networkDate = networkResp.headers.get('last-modified') || networkResp.headers.get('etag');
            if (cachedDate && networkDate && cachedDate !== networkDate) {
              // Nova versão detectada — notificar clientes
              self.clients.matchAll({ type: 'window' }).then(clients => {
                clients.forEach(c => c.postMessage({ type: 'SW_UPDATE_AVAILABLE' }));
              });
            }
          }
          cache.put(e.request, networkResp.clone());
          return networkResp;
        }
        // Resposta inválida: usa cache
        const fallback = await cache.match(e.request);
        return fallback || networkResp;
      } catch(err) {
        // Sem rede: usa cache
        const cached = await cache.match(e.request);
        return cached || new Response('Offline — sem conexão', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })
  );
});

// ── M31 FIX: responde SKIP_WAITING para ativar imediatamente ────────
self.addEventListener('message', function(evt) {
  if (evt.data && evt.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ── Push recebido do FCM ─────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Finanvô', body: e.data?.text() || '' }; }
  const title = data.notification?.title || data.title || 'Finanvô 💰';
  const body  = data.notification?.body  || data.body  || '';
  // M12 FIX: Android exige PNG para icon/badge — SVG é ignorado na bandeja de notificações
  const icon  = data.notification?.icon  || '/icons/icon-192.png';
  e.waitUntil(
    self.registration.showNotification(title, {
      body, icon,
      badge: '/icons/icon-192.png',
      tag: 'finanvo-push',
      requireInteraction: false,
      data: { url: data.url || '/finapp.html' }
    })
  );
});

// ── Clique na notificação ────────────────────────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/finapp.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url.includes('finapp') && 'focus' in c) return c.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
