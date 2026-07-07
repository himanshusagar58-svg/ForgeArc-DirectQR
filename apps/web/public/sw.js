self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = {}; }
  const title = data.title || 'New DirectQR order';
  const options = {
    body: data.body || 'A customer QR order is waiting for review.',
    icon: '/directqr-icon-192.png',
    badge: '/directqr-icon-192.png',
    tag: data.tag || 'directqr-order',
    renotify: true,
    vibrate: [180, 80, 180, 80, 260],
    data: { url: data.url || '/?view=qr-orders', orderId: data.orderId || null },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/?view=qr-orders', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(target);
        return;
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});
