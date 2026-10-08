/* Service worker minimal : il rend l'app installable (PWA) mais ne met RIEN
   en cache — un jeu temps réel doit toujours charger sa dernière version. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
