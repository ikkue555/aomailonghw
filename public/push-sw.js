/* Custom Web Push Service Worker Handler (iOS Safari 16.4+ & Android Chrome compatible) */

self.addEventListener('push', (event) => {
  let payload = {
    title: '📚 แจ้งเตือนการบ้าน',
    body: 'คุณมีงานใกล้ครบกำหนดส่ง กรุณาตรวจสอบรายการงานของคุณ',
    icon: '/pwa-192x192.png',
    badge: '/pwa-192x192.png',
    tag: 'homework-reminder',
    url: '/',
    tab: 'main',
    homeworkId: undefined,
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = {
        ...payload,
        ...parsed,
      };
    } catch {
      try {
        const text = event.data.text();
        if (text) payload.body = text;
      } catch {
        // fallback to default payload
      }
    }
  }

  const targetUrl = payload.homeworkId
    ? `/?tab=${encodeURIComponent(payload.tab || 'main')}&hw=${encodeURIComponent(payload.homeworkId)}`
    : `/?tab=${encodeURIComponent(payload.tab || 'main')}`;

  const notificationOptions = {
    body: payload.body,
    icon: payload.icon || '/pwa-192x192.png',
    badge: payload.badge || '/pwa-192x192.png',
    tag: payload.tag || 'homework-reminder',
    renotify: true,
    vibrate: [200, 100, 200],
    data: {
      url: targetUrl,
      tab: payload.tab || 'main',
      homeworkId: payload.homeworkId || null,
      timestamp: Date.now(),
    },
  };

  event.waitUntil(
    self.registration.showNotification(payload.title, notificationOptions)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = data.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ('focus' in client) {
          client.focus();
          client.postMessage({
            type: 'PUSH_NOTIFICATION_CLICK',
            tab: data.tab || 'main',
            homeworkId: data.homeworkId || null,
          });
          return;
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow(targetUrl);
      }
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
