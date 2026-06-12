'use strict';

(function() {
  var CACHE_PREFIX = 'mergers-news-';

  function purgeAppCaches(keepCurrent) {
    if (!('caches' in window)) return Promise.resolve();

    return caches.keys().then(function(keys) {
      return Promise.all(keys.filter(function(key) {
        return key.indexOf(CACHE_PREFIX) === 0 && key !== keepCurrent;
      }).map(function(key) {
        return caches.delete(key);
      }));
    }).catch(function() {
      // Cache maintenance must never block page rendering.
    });
  }

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
      var navigation = performance.getEntriesByType &&
        performance.getEntriesByType('navigation')[0];

      // A user-initiated refresh should always begin from fresh app assets.
      if (navigation && navigation.type === 'reload') {
        purgeAppCaches();
      }

      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then(function(registration) {
          registration.update().catch(function() {
            // A first-time registration may still be transitioning to active.
          });
          if (registration.active) {
            registration.active.postMessage({ type: 'PURGE_STALE_CACHES' });
          }
        })
        .catch(function() {
          // The site remains fully functional without service-worker support.
        });
    });
  }

  // Browsers cannot reliably distinguish a closed tab from navigation. This
  // best-effort cleanup prevents app caches surviving after either event.
  window.addEventListener('pagehide', function(event) {
    if (!event.persisted) purgeAppCaches();
  });
})();
