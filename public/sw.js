// זמן אמת: a service worker that deliberately caches nothing — every request goes to the network as usual,
// so the news is always fresh. It exists because some browsers only offer "add to home screen" to sites that have one.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
