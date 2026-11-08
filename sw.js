/* Finanvô — Service Worker v8 */
const CACHE_NAME = 'finanvo-v8';
const CACHE_CDN  = 'finanvo-cdn-v8';

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

  if (url.hostname.includes('firestore.googleapis.com')
    || url.hostname.includes('identitytoolkit.googleapis.com')
    || url.hostname.includes('securetoken.googleapis.com')
    || url.hostname.includes('firebase.googleapis.com')) return;

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
  e.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(e.request);
      const fetchPromise = fetch(e.request).then(resp => {
        if (resp && resp.status === 200) cache.put(e.request, resp.clone());
        return resp;
      }).catch(() => cached);
      return cached || fetchPromise;
    })
  );
});

// ── Push recebido do FCM ─────────────────────────────────────────
self.addEventListener('push', e => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: 'Finanvô', body: e.data?.text() || '' }; }
  const title = data.notification?.title || data.title || 'Finanvô 💰';
  const body  = data.notification?.body  || data.body  || '';
  const icon  = data.notification?.icon  || '/logo.svg';
  e.waitUntil(
    self.registration.showNotification(title, {
      body, icon,
      badge: '/logo.svg',
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
