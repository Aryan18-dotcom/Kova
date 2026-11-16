const CACHE = "kova-shell-v1";
const SHELL = ["/","/index.html","/styles.css","/app.js","/manifest.json","/icon.svg"];
self.addEventListener("install", event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(()=>self.skipWaiting()));
});
self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith("kova-") && k!==CACHE && k!=="kova-shared-v1").map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    if (url.hostname === "cdn.jsdelivr.net" && url.pathname.includes("/jsqr@1.4.0/")) {
      event.respondWith((async()=>{
        const cache = await caches.open("kova-vendor-v1");
        const cached = await cache.match(event.request);
        if (cached) return cached;
        try {
          const response = await fetch(event.request);
          if (response.ok || response.type === "opaque") await cache.put(event.request, response.clone());
          return response;
        } catch {
          return (await cache.match(event.request)) || new Response("QR engine unavailable offline", {status:503});
        }
      })());
    }
    return;
  }
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith((async()=>{
      try {
        const form = await event.request.formData();
        const file = form.get("qr_image");
        if (file && file.size && file.type.startsWith("image/")) {
          const cache = await caches.open("kova-shared-v1");
          await cache.put("/__kova_shared_image__", new Response(file, {headers:{"Content-Type":file.type}}));
        }
        const clientList = await self.clients.matchAll({type:"window",includeUncontrolled:true});
        if (clientList.length) clientList[0].navigate("/?shared=1");
        return Response.redirect("/?shared=1",303);
      } catch {
        return Response.redirect("/?shared=1",303);
      }
    })());
    return;
  }
  if (event.request.method !== "GET") return;
  event.respondWith((async()=>{
    const cached = await caches.match(event.request);
    if (cached) return cached;
    try {
      const response = await fetch(event.request);
      if (response.ok && response.type === "basic") {
        const cache = await caches.open(CACHE); cache.put(event.request,response.clone());
      }
      return response;
    } catch {
      if (event.request.mode === "navigate") return caches.match("/index.html");
      return new Response("Offline", {status:503,statusText:"Offline"});
    }
  })());
});