/**
 * Service Worker for MumbleChat push notifications.
 */

self.addEventListener('push', (event) => {
  let data = { title: 'MumbleChat', body: 'New notification' };
  try {
    if (event.data) {
      data = event.data.json();
    }
  } catch (_) {
    if (event.data) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || '',
    icon: '/assets/icon-192.png',
    badge: '/assets/icon-192.png',
    tag: data.data?.type || 'general',
    data: {
      url: data.url || '/',
      ...data.data,
    },
    requireInteraction: data.data?.type === 'dm',
  };

  event.waitUntil(
    self.registration.showNotification(data.title || 'MumbleChat', options)
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const url = event.notification.data?.url || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // Focus existing window if available
      for (const client of windowClients) {
        if (client.url.includes('voice.alex-dyakin.com') && 'focus' in client) {
          return client.focus();
        }
      }
      // Open new window
      return clients.openWindow(url);
    })
  );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
