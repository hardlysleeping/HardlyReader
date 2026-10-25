/**
 * The installability service worker.
 *
 * Browsers only offer "add to home screen" to a page that has a manifest and a
 * service worker with a fetch handler. This one is that handler and nothing
 * more: it does not cache, so a phone always gets the app the machine is
 * serving rather than a copy of last week's build.
 */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  // No respondWith: the network answers, as it would without this file.
});
