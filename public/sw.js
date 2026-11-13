// זמן אמת: the service worker. It caches nothing — every request goes to the network as usual, so the news is
// always fresh (some browsers only offer "add to home screen" to sites that have one). It shows the push
// notifications: the story's headline, how many sites cover it, and a tap opens the story's page.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});

self.addEventListener('push', e => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'זמן אמת', {
    body: m.body || 'סיפור גדול מסוקר עכשיו בכמה אתרים',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    tag: m.tag || 'zman-emet',
    renotify: true,
    dir: 'rtl',
    lang: 'he',
    data: { url: m.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = wins.find(w => new URL(w.url).origin === self.location.origin);
    if (open) { await open.focus(); return open.navigate(url).catch(() => self.clients.openWindow(url)); }
    return self.clients.openWindow(url);
  })());
});
