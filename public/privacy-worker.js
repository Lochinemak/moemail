// Remove old caches that held private API responses and authenticated pages.
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(names => Promise.all(
    names.filter(name => name !== "moemail-static-v2" && !name.startsWith("workbox-precache"))
      .map(name => caches.delete(name))
  )))
})
