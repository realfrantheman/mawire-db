'use strict';

var CACHE = 'mergers-news-v5';
var SHELL = [
  '/index.html',
  '/style.css',
  '/app.js',
  '/charts.js',
  '/manifest.json',
  '/about.html',
  '/about.js',
  '/ipo.html',
  '/ipo.js',
  '/contact.html'
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
        keys.filter(function(k) { return k !== CACHE; })
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

  // HTML navigation — network first, then cached page, then index
  if (req.headers.get('accept') && req.headers.get('accept').includes('text/html')) {
    e.respondWith(
      fetch(req).catch(function() {
        return caches.match(req).then(function(cached) {
          return cached || caches.match('/index.html');
        });
      })
    );
    return;
  }

  // Static assets — cache first, update cache from network in background
  e.respondWith(
    caches.match(req).then(function(cached) {
      var network = fetch(req).then(function(res) {
        if (res && res.status === 200) {
          caches.open(CACHE).then(function(cache) { cache.put(req, res.clone()); });
        }
        return res;
      });
      return cached || network;
    })
  );
});
