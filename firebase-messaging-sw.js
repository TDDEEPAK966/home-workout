importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.8.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: 'AIzaSyBDXjoAZMgVu3SoqK913Ub4_qS_kmLVSvQ',
  authDomain: 'home-workout-planner-4e10f.firebaseapp.com',
  databaseURL: 'https://home-workout-planner-4e10f-default-rtdb.asia-southeast1.firebasedatabase.app',
  projectId: 'home-workout-planner-4e10f',
  storageBucket: 'home-workout-planner-4e10f.firebasestorage.app',
  messagingSenderId: '588693721178',
  appId: '1:588693721178:web:3b532282fd027d52a98863',
  measurementId: 'G-B1XCF5G27Q'
});

const messaging = firebase.messaging();

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

messaging.onBackgroundMessage(payload => {
  const notice = payload.data || {};
  self.registration.showNotification(notice.title || 'Workout time', {
    body: notice.body || 'Your daily exercise workout starts now.',
    icon: './logo.png',
    data: { url: notice.url || '/' }
  });
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = new URL(event.notification.data.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus();
        if ('navigate' in client) await client.navigate(targetUrl);
        return;
      }
    }
    await self.clients.openWindow(targetUrl);
  })());
});
