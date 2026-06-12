'use strict';

var CACHE_PREFIX = 'mergers-news-';
var CACHE = CACHE_PREFIX + 'v9';
var SHELL = [
  '/',
  '/style.css?v=20260612-blue-performance',
  '/app.js?v=20260612-blue-performance',
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
      return cache.addAll(SHELL);
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
        })
            .map(function(k) { return caches.delete(k); })
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

  // GitHub raw data — network only, JSON array fallback
  if (url.hostname === 'raw.githubusercontent.com') {
    e.respondWith(
      fetch(req).catch(function() {
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } });
      })
    );
    return;
  }

  // Formspree form submissions — pass through
  if (url.hostname === 'formspree.io') return;

  // HTML navigation — always network first; SW never intercepts nav on the
  // same URL twice in quick succession to prevent the double-click download bug.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(function() {
        return caches.match(req)
          .then(function(c) { return c || caches.match('/'); });
      })
    );
    return;
  }

  // Static assets — network first so a hard refresh never renders stale CSS/JS.
  e.respondWith(
    fetch(req).then(function(res) {
        if (res && res.status === 200) {
          caches.open(CACHE).then(function(cache) { cache.put(req, res.clone()); });
        }
        return res;
      }).catch(function() {
        return caches.match(req);
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
