// 离线缓存（Service Worker）：让网站可以“安装”成手机 App，玩过一次之后没网也能打开。
// 策略：网络优先——联网时永远拿最新版本，同时存一份；断网时用存下来的那份。
// 改了这个文件里的 CACHE 名字，旧缓存会在新版本启用时被清掉。
const CACHE = 'rampage-escape-v5';
const CORE = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(CORE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});

// 第一次打开网页时 Service Worker 还没接管，那次下载的文件没进缓存：网页加载完后会把文件列表发过来补存
self.addEventListener('message', (e) => {
  if (e.data?.type !== 'precache') return;
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(e.data.urls.map((u) => c.match(u).then((hit) => hit || c.add(u).catch(() => {}))))));
});
