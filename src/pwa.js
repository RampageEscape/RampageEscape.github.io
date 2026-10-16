// 「安装成 App」：注册离线缓存 + 标题画面的「安装到手机」按钮。
//   安卓 Chrome / 电脑版 Chrome、Edge：浏览器支持一键安装 → 按钮直接弹出系统的安装窗口
//   iPhone / iPad：苹果不允许网页弹安装窗口 → 按钮显示「分享 → 加入主画面」的图文说明
//   已经是从主画面打开的 App：不显示按钮

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('[pwa] 离线缓存注册失败', e));
    // 等主角车模型这些后台资源也下载完，再把本次用到的所有站内文件交给离线缓存
    setTimeout(async () => {
      const reg = await navigator.serviceWorker.ready;
      const urls = performance.getEntriesByType('resource').map((r) => r.name).filter((u) => u.startsWith(location.origin));
      reg.active?.postMessage({ type: 'precache', urls: [...new Set(urls)] });
    }, 15000);
  });
}

const installed = () => matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || navigator.standalone === true;
const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

let deferred = null; // 浏览器给的“安装”事件，留到玩家点按钮时再用

const button = document.getElementById('install-btn');
const hint = document.getElementById('install-hint');

if (!installed()) {
  if (isIOS) button.classList.remove('hidden');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    button.classList.remove('hidden');
  });
}
window.addEventListener('appinstalled', () => {
  deferred = null;
  button.classList.add('hidden');
});

button.addEventListener('click', async () => {
  if (deferred) {
    deferred.prompt();
    const { outcome } = await deferred.userChoice;
    deferred = null;
    if (outcome === 'accepted') button.classList.add('hidden');
  } else {
    hint.classList.remove('hidden');
  }
});
hint.addEventListener('click', (e) => {
  if (e.target === hint || e.target.id === 'install-hint-close') hint.classList.add('hidden');
});
