// חדשות ישראל — client. Plain DOM (no framework); all text goes through textContent (no HTML injection).
const app = document.getElementById('app');
const statusEl = document.getElementById('scan-status');
const NEW_MS = 10 * 60_000;

let data = null; // last events.json

// Where the scan results live. On GitHub Pages (<owner>.github.io/<repo>/) the scan workflow publishes
// them to the repository's `data` branch; locally, server.js writes them next to this page.
//
// The branch URL (raw.githubusercontent.com/<repo>/data/…) is served from a CDN that can return copies
// that are hours old. So we first ask the GitHub API for the branch's current commit and then download
// the file by that commit id — a URL that can never be stale.
// Unauthenticated API calls are limited to 60/hour per visitor, but a conditional request answered with
// 304 ("not changed") does not count. So we check every 30 seconds with the last ETag and download only
// when a new scan was published (every ~3 minutes ≈ 20 counted calls per hour).
const PAGES = location.hostname.endsWith('.github.io');
const REPO = PAGES ? `${location.hostname.split('.')[0]}/${location.pathname.split('/')[1]}` : null;
const REFRESH_MS = 30_000;
let dataRef = 'data';
let refEtag = null;

/** @returns {Promise<boolean>} true when there may be new data to download */
async function resolveRef() {
  if (!PAGES) return true;
  try {
    const headers = { Accept: 'application/vnd.github.sha' };
    if (refEtag) headers['If-None-Match'] = refEtag;
    const r = await fetch(`https://api.github.com/repos/${REPO}/commits/data`, { headers, cache: 'no-store' });
    if (r.status === 304) return false;
    if (r.ok) { dataRef = (await r.text()).trim(); refEtag = r.headers.get('ETag'); return true; }
  } catch { /* network hiccup: keep the last known ref */ }
  return data == null; // rate-limited or offline: only try the download if we have nothing yet
}
const dataUrl = name => (PAGES ? `https://raw.githubusercontent.com/${REPO}/${dataRef}/${name}` : `${name}?t=${Date.now()}`);

// ---------- helpers ----------
function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style') n.style.cssText = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) n.append(c instanceof Node ? c : String(c));
  return n;
}
const now = () => Date.now();
const hhmm = ms => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
const safeUrl = u => (/^https?:\/\//i.test(u) ? u : '#');
const langOf = s => (/[א-ת]/.test(s) ? 'he' : 'en');

function ago(ms) {
  const m = Math.max(0, Math.round((now() - ms) / 60_000));
  if (m < 1) return 'לפני פחות מדקה';
  if (m === 1) return 'לפני דקה';
  if (m === 2) return 'לפני שתי דקות';
  if (m < 60) return `לפני ${m} דקות`;
  const h = Math.floor(m / 60);
  if (h === 1) return 'לפני שעה';
  if (h === 2) return 'לפני שעתיים';
  return `לפני ${h} שעות`;
}
const sourcesText = n => (n === 1 ? 'מקור אחד' : `${n} מקורות`);
// A multi-source event says how many sites covered it; a "hot" single-source story says so plainly.
const HOT_REASON = { 'several-articles': 'האתר פרסם כמה כתבות על זה', 'near-match-elsewhere': 'כותרת דומה מופיעה באתר נוסף', breaking: 'מבזק' };
const coverage = ev => ev.singleSource
  ? el('p', { class: 'coverage single' }, 'מקור אחד בלבד · עדיין לא סוקר באתר נוסף',
      ev.hot?.length ? el('span', { class: 'hot-why' }, ` (${ev.hot.map(r => HOT_REASON[r] ?? r).join(', ')})`) : null)
  : el('p', { class: 'coverage' }, `סוקר ב-${sourcesText(ev.sourceCount)}`);
const dot = color => el('span', { class: 'dot', style: `background:${color}`, 'aria-hidden': 'true' });

// ---------- data ----------
async function load() {
  try {
    if (!(await resolveRef()) && data && !data.error) return; // nothing new since the last check
    const r = await fetch(dataUrl('events.json'), { cache: 'no-store' });
    if (r.status === 404) { data = { events: [], lastScanAt: null }; return; } // first scan not finished yet
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    if (!data) data = { error: e.message, events: [] };
  }
}

function renderStatus() {
  if (!data || data.error) { statusEl.textContent = data?.error ? 'אין חיבור. ננסה שוב בעוד רגע.' : ''; return; }
  statusEl.textContent = data.lastScanAt
    ? `עודכן ${ago(data.lastScanAt)} · הסריקה רצה אוטומטית כל כמה דקות`
    : 'סורקים את אתרי החדשות בפעם הראשונה…';
  statusEl.classList.toggle('stale', !!data.lastScanAt && now() - data.lastScanAt > 30 * 60_000);
}

// ---------- views ----------
function homeView() {
  document.title = 'חדשות ישראל';
  if (data?.error && !data.events.length) return el('div', { class: 'error-box' }, 'לא הצלחנו לטעון את האירועים. ננסה שוב בעוד דקה.');
  if (!data?.events.length)
    return el('div', { class: 'empty' },
      el('p', {}, data?.lastScanAt ? 'עדיין לא זוהו אירועים שמסוקרים ביותר ממקור אחד.' : 'סורקים את אתרי החדשות בפעם הראשונה…'),
      el('p', {}, 'הדף יתעדכן לבד.'));

  return el('ol', { class: 'cards', 'aria-label': 'אירועים מהחדשים לוותיקים' },
    data.events.map(ev => {
      const isNew = now() - ev.detectedAt < NEW_MS;
      const href = `#/event/${ev.id}`;
      return el('li', { class: 'card' },
        el('div', { class: 'card-meta' },
          isNew && el('span', { class: 'badge-new' }, 'חדש'),
          ev.singleSource && el('span', { class: 'badge-hot' }, 'חם'),
          el('time', { datetime: new Date(ev.detectedAt).toISOString(), title: `זוהה בשעה ${hhmm(ev.detectedAt)}` },
            `זוהה ${ago(ev.detectedAt)} · ${hhmm(ev.detectedAt)}`)),
        el('h2', { lang: langOf(ev.title) }, el('a', { href }, ev.title)),
        coverage(ev),
        el('ul', { class: 'chips', 'aria-label': 'מקורות' }, ev.sources.map(s => el('li', { class: 'chip' }, dot(s.color), s.name))),
        el('a', { class: 'btn', href, 'aria-label': `לקריאת המקורות: ${ev.title}` }, 'לקריאת המקורות'));
    }));
}

function eventView(id, tab) {
  const ev = data?.events.find(e => e.id === id);
  const back = el('a', { class: 'back', href: '#/' }, '→ חזרה לכל האירועים');
  if (!ev) return el('div', {}, back, el('div', { class: 'empty' },
    el('p', {}, 'האירוע כבר לא ברשימה.'), el('p', {}, 'ייתכן שהוא הוחלף באירוע חדש יותר.')));

  document.title = `${ev.title} · חדשות ישראל`;

  const whatHappened = el('section', { class: 'panel', id: 'panel-what', role: 'tabpanel', 'aria-labelledby': 'tab-what' },
    el('h3', {}, 'כותרות המקורות'),
    el('ul', { class: 'headline-list' }, ev.articles.map(a =>
      el('li', {}, el('div', { class: 'src-name' }, dot(a.color), a.sourceName), el('div', { lang: langOf(a.title) }, a.title)))));

  // One entry per site (in order of first coverage); a site with several articles lists them all.
  const bySource = new Map();
  for (const a of ev.articles) bySource.set(a.sourceId, [...(bySource.get(a.sourceId) ?? []), a]);
  const sources = el('section', { class: 'panel', id: 'panel-sources', role: 'tabpanel', 'aria-labelledby': 'tab-sources' },
    el('ul', { class: 'source-list' }, [...bySource.values()].map(list =>
      el('li', { class: 'source-item', style: `--src:${list[0].color}` },
        el('div', { class: 'site' }, dot(list[0].color), ' ', list[0].sourceName),
        list.map(a => el('div', { class: 'source-article' },
          el('p', { class: 'headline', lang: langOf(a.title) }, a.title),
          a.publishedAt && el('div', { class: 'when' }, `פורסם ${ago(a.publishedAt)} · ${hhmm(a.publishedAt)}`),
          el('a', { class: 'open-link', href: safeUrl(a.link), target: '_blank', rel: 'noopener noreferrer' },
            'פתח כתבה ↗', el('span', { class: 'visually-hidden' }, ` (${a.sourceName}, נפתח בחלון חדש)`))))))));

  const current = tab === 'sources' ? 'sources' : 'what';
  const tabBtn = (key, label) => el('button', {
    class: 'tab', role: 'tab', id: `tab-${key}`, 'aria-controls': `panel-${key}`,
    'aria-selected': String(current === key), tabindex: current === key ? '0' : '-1',
    onclick: () => { location.replace(`#/event/${id}${key === 'sources' ? '/sources' : ''}`); },
    onkeydown: e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { location.replace(`#/event/${id}${key === 'sources' ? '' : '/sources'}`); } },
  }, label);

  return el('div', {},
    back,
    el('article', { class: 'event-head' },
      el('div', { class: 'card-meta' }, el('time', { datetime: new Date(ev.detectedAt).toISOString() }, `זוהה ${ago(ev.detectedAt)} · ${hhmm(ev.detectedAt)}`)),
      el('h2', { lang: langOf(ev.title) }, ev.title),
      coverage(ev),
      el('ul', { class: 'chips', 'aria-label': 'מקורות' }, ev.sources.map(s => el('li', { class: 'chip' }, dot(s.color), s.name)))),
    el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'תצוגת אירוע' }, tabBtn('what', 'מה קרה?'), tabBtn('sources', `מקורות (${ev.sourceCount})`)),
    current === 'what' ? whatHappened : sources);
}

async function statusView() {
  document.title = 'מצב המקורות · חדשות ישראל';
  let s;
  try { s = await (await fetch(dataUrl('status.json'), { cache: 'no-store' })).json(); } catch { return el('div', { class: 'error-box' }, 'אין חיבור לשרת.'); }
  const rows = s.sources.flatMap(src => src.feeds.map(f => el('tr', {},
    el('td', {}, el('span', { class: 'src-name' }, dot(src.color), src.name)),
    el('td', {}, f.lastError ? el('span', { class: 'bad' }, `שגיאה: ${f.lastError}`) : f.lastOkAt ? el('span', { class: 'ok' }, 'תקין') : '—'),
    el('td', {}, f.lastOkAt ? ago(f.lastOkAt) : '—'),
    el('td', {}, String(f.items)))));
  const st = s.settings;
  return el('div', {},
    el('a', { class: 'back', href: '#/' }, '→ חזרה לכל האירועים'),
    el('h2', {}, 'מצב המקורות'),
    el('p', {}, `מינימום מקורות לאירוע: ${st.minSources} · סף דמיון: ${st.similarityThreshold} · סריקה כל ${st.scanIntervalMinutes} דקות · מודל: ${st.model}`),
    el('table', { class: 'status-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'מקור'), el('th', {}, 'מצב'), el('th', {}, 'עדכון אחרון'), el('th', {}, 'פריטים'))),
      el('tbody', {}, rows)));
}

// Windows has no flag-emoji glyphs (🇮🇱 shows as "IL"). Detect that and draw the flag as SVG instead.
function fixFlag() {
  const c = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!c) return;
  c.font = '16px sans-serif';
  const flagWidth = c.measureText('🇮🇱').width, lettersWidth = c.measureText('\u{1F1EE}').width * 2;
  if (flagWidth < lettersWidth * 0.9) return; // one combined glyph → the emoji renders fine
  document.querySelector('.flag')?.replaceChildren(Object.assign(document.createElement('img'),
    { src: 'flag-il.svg', alt: '', className: 'flag-img', width: 30, height: 22 }));
}
fixFlag();

// ---------- router ----------
async function route({ refresh = true } = {}) {
  const hash = location.hash || '#/';
  if (refresh) await load();
  renderStatus();
  let view;
  const m = hash.match(/^#\/event\/([\w-]+)(\/sources)?$/);
  if (m) view = eventView(m[1], m[2] ? 'sources' : 'what');
  else if (hash === '#/status') view = await statusView();
  else view = homeView();
  const y = window.scrollY;
  app.replaceChildren(view);
  return y;
}

window.addEventListener('hashchange', async () => {
  const prevTab = document.activeElement?.id;
  await route({ refresh: false });
  if (prevTab?.startsWith('tab-')) document.querySelector('[aria-selected="true"].tab')?.focus();
  else { window.scrollTo(0, 0); app.focus({ preventScroll: true }); }
});

let busy = false;
async function tick() {
  if (busy) return;
  busy = true;
  try {
    const y = await route();
    window.scrollTo(0, y); // automatic refresh keeps the reader's place
  } finally { busy = false; }
}

// When a new version of the site itself is published, reload so nobody is stuck on old code.
let appVersion = null;
async function checkAppVersion() {
  try {
    const r = await fetch('app.js', { method: 'HEAD', cache: 'no-store' });
    const v = r.headers.get('ETag') ?? r.headers.get('Last-Modified');
    if (appVersion && v && v !== appVersion) location.reload();
    appVersion ??= v;
  } catch { /* offline */ }
}

// Pull new events automatically: every 30 s, and right away when the page comes back into view
// (switching tabs, unlocking the phone, reopening the home-screen app, reconnecting).
await route();
checkAppVersion();
setInterval(tick, REFRESH_MS);
setInterval(checkAppVersion, 10 * 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); checkAppVersion(); } });
window.addEventListener('pageshow', e => { if (e.persisted) tick(); });
window.addEventListener('online', tick);
window.addEventListener('focus', tick);

