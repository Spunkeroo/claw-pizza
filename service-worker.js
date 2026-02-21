const CACHE_NAME = 'claw-pizza-v1';

const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
  'https://cdn.jsdelivr.net/npm/cannon-es@0.20.0/dist/cannon-es.js'
];

// ---------- INSTALL ----------
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
});

// ---------- ACTIVATE ----------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name.startsWith('claw-pizza-') && name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    }).then(() => self.clients.claim())
  );
});

// ---------- FETCH ----------
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Network-first for Firebase / API calls
  if (
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseapp.com') ||
    url.pathname.startsWith('/api/')
  ) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // Cache-first for everything else (assets, pages, CDN scripts)
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok && request.method === 'GET') {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    // Offline fallback: return cached index for navigation requests
    if (request.mode === 'navigate') {
      return caches.match('/index.html');
    }
    throw err;
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response(
      JSON.stringify({ error: 'offline', message: 'You are currently offline.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

// ---------- BACKGROUND SYNC ----------
self.addEventListener('sync', (event) => {
  if (event.tag === 'sync-plays') {
    event.waitUntil(syncOfflinePlays());
  }
  if (event.tag === 'sync-claims') {
    event.waitUntil(syncOfflineClaims());
  }
});

async function syncOfflinePlays() {
  try {
    const db = await openIDB();
    const tx = db.transaction('offline-plays', 'readonly');
    const store = tx.objectStore('offline-plays');
    const plays = await idbGetAll(store);

    for (const play of plays) {
      try {
        const response = await fetch('/api/play', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(play.data)
        });

        if (response.ok) {
          const delTx = db.transaction('offline-plays', 'readwrite');
          delTx.objectStore('offline-plays').delete(play.id);
        }
      } catch (e) {
        // Will retry on next sync
      }
    }
  } catch (e) {
    console.error('[SW] syncOfflinePlays failed:', e);
  }
}

async function syncOfflineClaims() {
  try {
    const db = await openIDB();
    const tx = db.transaction('offline-claims', 'readonly');
    const store = tx.objectStore('offline-claims');
    const claims = await idbGetAll(store);

    for (const claim of claims) {
      try {
        const response = await fetch('/api/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(claim.data)
        });

        if (response.ok) {
          const delTx = db.transaction('offline-claims', 'readwrite');
          delTx.objectStore('offline-claims').delete(claim.id);
        }
      } catch (e) {
        // Will retry on next sync
      }
    }
  } catch (e) {
    console.error('[SW] syncOfflineClaims failed:', e);
  }
}

function openIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('claw-pizza-offline', 1);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('offline-plays')) {
        db.createObjectStore('offline-plays', { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('offline-claims')) {
        db.createObjectStore('offline-claims', { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGetAll(store) {
  return new Promise((resolve, reject) => {
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------- PUSH NOTIFICATIONS ----------
self.addEventListener('push', (event) => {
  let data = { title: 'claw.pizza', body: 'You have a notification!', icon: '/manifest.json' };

  if (event.data) {
    try {
      data = event.data.json();
    } catch (e) {
      data.body = event.data.text();
    }
  }

  const options = {
    body: data.body || 'Check out what is happening on claw.pizza!',
    icon: data.icon || generateIconDataURI(),
    badge: data.badge || generateIconDataURI(),
    vibrate: [100, 50, 100],
    data: {
      url: data.url || '/',
      dateOfArrival: Date.now()
    },
    actions: []
  };

  // Win alert
  if (data.type === 'win') {
    options.body = data.body || 'You grabbed a prize! Come claim it now!';
    options.actions = [
      { action: 'claim', title: 'Claim Prize' },
      { action: 'share', title: 'Share Win' }
    ];
    options.tag = 'win-notification';
    options.renotify = true;
  }

  // Daily faucet reminder
  if (data.type === 'faucet') {
    options.body = data.body || 'Your daily free tokens are ready! Claim them now.';
    options.actions = [
      { action: 'claim-faucet', title: 'Claim Tokens' }
    ];
    options.tag = 'faucet-reminder';
    options.renotify = true;
  }

  event.waitUntil(self.registration.showNotification(data.title || 'claw.pizza', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  let targetUrl = '/';

  if (event.notification.data && event.notification.data.url) {
    targetUrl = event.notification.data.url;
  }

  if (event.action === 'claim' || event.action === 'claim-faucet') {
    targetUrl = '/#prizes';
  } else if (event.action === 'share') {
    targetUrl = '/#share';
  }

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes('claw.pizza') && 'focus' in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});

function generateIconDataURI() {
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 192 192'%3E%3Crect width='192' height='192' rx='24' fill='%230a0a0f'/%3E%3Cpath d='M96 30 L40 140 L152 140 Z' fill='%23FFB703'/%3E%3C/svg%3E";
}
