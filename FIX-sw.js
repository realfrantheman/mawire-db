'use strict';

var CACHE_PREFIX = 'mergers-news-';
var CACHE = CACHE_PREFIX + 'v10';
var SHELL = [
  '/',
  '/style.css?v=20260612-blue-performance',
  '/app.js?v=20260612-blue-performance',
  '/source-taxonomy.js?v=20260612-sources',
  '/charts.js',
  '/manifest.json',
  '/about',
  '/about.js',
  '/ipo',
  '/ipo.js',
  '/contact'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE).then(function(cache) {
      return Promise.all(SHELL.map(function(asset) {
        return fetch(asset, { cache: 'reload' }).then(function(response) {
          if (!response.ok) throw new Error('Failed to precache ' + asset + ': HTTP ' + response.status);
          return cache.put(asset, response);
        });
      }));
    }).then(function() {
      return self.skipWaiting();
    })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) {
          return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE;
        }).map(function(k) { return caches.delete(k); })
      );
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  var req = e.request;
  var url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Public deal artifacts must never be converted into a successful empty dataset.
  // Preserve upstream failures as failures so the UI can show an actionable error.
  if (url.hostname === 'raw.githubusercontent.com') {
    e.respondWith(
      fetch(req, { cache: 'no-store' }).then(function(response) {
        if (!response.ok) return response;
        return response;
      }).catch(function(err) {
        return new Response(JSON.stringify({
          error: 'deal_data_unavailable',
          message: String(err && err.message || 'Unable to reach deal data source')
        }), {
          status: 503,
          statusText: 'Deal data unavailable',
          headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
          }
        });
      })
    );
    return;
  }

  if (url.hostname === 'formspree.io') return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function() {
        return caches.match(req).then(function(cached) {
          return cached || caches.match('/');
        });
      })
    );
    return;
  }

  e.respondWith(
    fetch(req).then(function(res) {
      if (res && res.status === 200) {
        e.waitUntil(caches.open(CACHE).then(function(cache) {
          return cache.put(req, res.clone());
        }));
      }
      return res;
    }).catch(function() {
      return caches.match(req).then(function(cached) {
        if (cached) return cached;
        return new Response('Offline', { status: 503, headers: { 'Cache-Control': 'no-store' } });
      });
    })
  );
});

self.addEventListener('message', function(e) {
  if (!e.data || e.data.type !== 'PURGE_STALE_CACHES') return;

  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) {
          return k.indexOf(CACHE_PREFIX) === 0 && k !== CACHE;
        }).map(function(k) {
          return caches.delete(k);
        })
      );
    })
  );
});
