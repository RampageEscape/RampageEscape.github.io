// 多语言：只支持繁体中文（默认）和英文
// HTML 里用 data-i18n="key" 标记的元素会自动替换；JS 里用 t('key', { 变量 })

const STRINGS = {
  'zh-Hant': {
    pageTitle: 'Heat Rush 警車狂飆',
    langButton: 'English',
    langAria: '切換成英文',
    subtitle: '警車追逐 · 衝刺撞毀',
    helpLanes: '<b>← →</b> 滑動切換車道',
    helpSpeed: '<b>↑ ↓</b> 滑動加速 / 剎車',
    helpDash: '<b>雙擊 / DASH / 空白鍵</b> 衝刺：無敵，撞毀警車',
    helpBust: '別被警車包夾太久，會被捕！',
    start: '開始追逐',
    retry: '再來一次',
    dash: '衝刺',
    dashAria: '衝刺',
    busted: '被捕了！',
    wrecked: '車毀了！',
    stats: '得分 <b>{score}</b><br>距離 {distance} 米 · 摧毀警車 {kills} 輛',
    best: '最高分 {best}',
    combo: '連擊 x{n}',
    lured: '引誘撞毀 +{pts}',
    distance: '{d} 米',
    city: '郊區城市',
    forest: '雪地森林',
  },
  en: {
    pageTitle: 'Heat Rush',
    langButton: '繁體中文',
    langAria: 'Switch to Traditional Chinese',
    subtitle: 'Police Chase · Dash & Smash',
    helpLanes: '<b>← →</b> Swipe to change lanes',
    helpSpeed: '<b>↑ ↓</b> Swipe to speed up / brake',
    helpDash: '<b>Double-tap / DASH / Space</b> Dash: invincible, smash cop cars',
    helpBust: "Don't get boxed in by cops for too long — you'll be busted!",
    start: 'Start Chase',
    retry: 'Play Again',
    dash: 'DASH',
    dashAria: 'Dash',
    busted: 'BUSTED!',
    wrecked: 'WRECKED!',
    stats: 'Score <b>{score}</b><br>Distance {distance} m · Cops wrecked {kills}',
    best: 'Best {best}',
    combo: 'Combo x{n}',
    lured: 'Lured! +{pts}',
    distance: '{d} m',
    city: 'Suburbs',
    forest: 'Snowy Forest',
  },
};

const LANGS = Object.keys(STRINGS);
const KEY = 'heatrush.lang';
const listeners = [];

function loadLang() {
  try {
    const saved = localStorage.getItem(KEY);
    if (LANGS.includes(saved)) return saved;
  } catch { /* 隐私模式读不到就用默认 */ }
  return 'zh-Hant';
}

let lang = loadLang();

export const getLang = () => lang;

export function t(key, vars = {}) {
  const s = STRINGS[lang][key] ?? STRINGS['zh-Hant'][key] ?? key;
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}

export function onLangChange(fn) {
  listeners.push(fn);
}

export function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
  applyStatic();
  for (const fn of listeners) fn(lang);
}

export const toggleLang = () => setLang(lang === 'en' ? 'zh-Hant' : 'en');

/** 把页面上所有带 data-i18n / data-i18n-aria 的元素换成当前语言 */
export function applyStatic() {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant';
  document.title = t('pageTitle');
  for (const el of document.querySelectorAll('[data-i18n]')) el.innerHTML = t(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.dataset.i18nAria));
}
