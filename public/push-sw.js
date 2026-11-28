/* Service Worker Notification Handler (Works natively without VAPID; supports optional Web Push too) */

function resolveScopedUrl(relativePath) {
  try {
    const scope = (self.registration && self.registration.scope) || self.location.origin + '/';
    return new URL(relativePath, scope).href;
  } catch {
    return relativePath;
  }
}

function buildTargetUrl(tab, homeworkId) {
  const query = homeworkId
    ? `?tab=${encodeURIComponent(tab || 'main')}&hw=${encodeURIComponent(homeworkId)}`
    : `?tab=${encodeURIComponent(tab || 'main')}`;
  return resolveScopedUrl(query);
}

function buildNotificationOptions(payload) {
  const defaultIcon = resolveScopedUrl('pwa-192x192.png');
  const targetUrl = buildTargetUrl(payload.tab, payload.homeworkId);
  return {
    body: payload.body || '',
    icon: payload.icon || defaultIcon,
    badge: payload.badge || defaultIcon,
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
}

// Optional server-sent Web Push handler (when VAPID backend is enabled)
self.addEventListener('push', (event) => {
  let payload = {
    title: '📚 แจ้งเตือนการบ้าน',
    body: 'คุณมีงานใกล้ครบกำหนดส่ง กรุณาตรวจสอบรายการงานของคุณ',
    tag: 'homework-reminder',
    tab: 'main',
    homeworkId: undefined,
  };

  if (event.data) {
    try {
      const parsed = event.data.json();
      payload = { ...payload, ...parsed };
    } catch {
      try {
        const text = event.data.text();
        if (text) payload.body = text;
      } catch {
        // fallback to default payload
      }
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, buildNotificationOptions(payload))
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = event.notification.data || {};
  const targetUrl = data.url || resolveScopedUrl('');

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
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  if (msg.type === 'SHOW_NOTIFICATION') {
    const delayMs = Math.max(0, Math.min(30000, Number(msg.delaySeconds || 0) * 1000));
    const showPromise = new Promise((resolve) => setTimeout(resolve, delayMs)).then(() =>
      self.registration.showNotification(
        msg.title || '🔔 แจ้งเตือนการบ้าน',
        buildNotificationOptions({
          body: msg.body || '',
          icon: msg.icon,
          badge: msg.badge,
          tag: msg.tag || `local-notif-${Date.now()}`,
          tab: msg.tab || 'main',
          homeworkId: msg.homeworkId,
        })
      )
    );
    if (typeof event.waitUntil === 'function') {
      event.waitUntil(showPromise);
    }
  }
});
