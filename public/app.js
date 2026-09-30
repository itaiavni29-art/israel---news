// חדשות ישראל — client. Plain DOM (no framework); all text goes through textContent (no HTML injection).
// Screens follow the Figma file "אפליקציית חדשות": בית · אירוע (כתבה) · מבזקים · נושאים · שמורים.
const app = document.getElementById('app');
const NEW_MS = 10 * 60_000;

let data = null; // last events.json

// ---------- where the data lives ----------
// On GitHub Pages (<owner>.github.io/<repo>/) the scan workflow publishes events.json to the repository's
// `data` branch; locally, server.js writes it next to this page.
// The branch URL (raw.githubusercontent.com/<repo>/data/…) is served from a CDN that can return copies
// that are hours old, so we ask the GitHub API for the branch's current commit and download the file by
// that commit id — a URL that can never be stale. Unauthenticated API calls are limited to 60/hour per
// visitor, but a conditional request answered with 304 ("not changed") does not count, so we can check
// every 30 seconds and download only when a new scan was published.
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

async function load() {
  try {
    if (!(await resolveRef()) && data && !data.error) return; // nothing new since the last check
    const r = await fetch(dataUrl('events.json'), { cache: 'no-store' });
    if (r.status === 404) { data = { events: [], breaking: [], headlines: [], sources: [], categories: [], lastScanAt: null }; return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
    data.breaking ??= []; data.headlines ??= []; data.sources ??= []; data.categories ??= [];
  } catch (e) {
    if (!data) data = { error: e.message, events: [], breaking: [], headlines: [], sources: [], categories: [] };
  }
}

// ---------- device storage (saved events, reading history) ----------
const store = {
  get(key) { try { return JSON.parse(localStorage.getItem(key)) ?? []; } catch { return []; } },
  set(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* private mode / full */ } },
};
const SAVED = 'in:saved', HISTORY = 'in:history';
const isSaved = id => store.get(SAVED).some(s => s.event.id === id);
function toggleSave(ev) {
  const list = store.get(SAVED);
  const i = list.findIndex(s => s.event.id === ev.id);
  if (i >= 0) list.splice(i, 1); else list.unshift({ savedAt: Date.now(), event: ev });
  store.set(SAVED, list.slice(0, 100));
  return i < 0;
}
function remember(ev) {
  const list = store.get(HISTORY).filter(h => h.event.id !== ev.id);
  list.unshift({ viewedAt: Date.now(), event: ev });
  store.set(HISTORY, list.slice(0, 30));
}
// An event may have left the list (only 10 are kept); saved/viewed copies still open.
const findEvent = id => data?.events.find(e => e.id === id)
  ?? store.get(SAVED).find(s => s.event.id === id)?.event
  ?? store.get(HISTORY).find(h => h.event.id === id)?.event;

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
const icon = name => el('span', { class: `icon i-${name}`, 'aria-hidden': 'true' });
const now = () => Date.now();
const hhmm = ms => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
const safeUrl = u => (/^https?:\/\//i.test(u) ? u : '#');
const langOf = s => (/[א-ת]/.test(s) ? 'he' : 'en');
const isToday = ms => new Date(ms).toDateString() === new Date().toDateString();
const dayName = d => new Intl.DateTimeFormat('he-IL', { weekday: 'short', timeZone: 'Asia/Jerusalem' }).format(d);
const dayMonth = d => new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'long', timeZone: 'Asia/Jerusalem' }).format(d);

function ago(ms) {
  const m = Math.max(0, Math.round((now() - ms) / 60_000));
  if (m < 1) return 'לפני פחות מדקה';
  if (m === 1) return 'לפני דקה';
  if (m === 2) return 'לפני שתי דקות';
  if (m < 60) return `לפני ${m} דקות`;
  const h = Math.floor(m / 60);
  if (h === 1) return 'לפני שעה';
  if (h === 2) return 'לפני שעתיים';
  if (h < 24) return `לפני ${h} שעות`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'אתמול' : `לפני ${d} ימים`;
}
function greeting() {
  const h = +new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Asia/Jerusalem' }).format(new Date());
  return h < 5 ? 'לילה טוב' : h < 12 ? 'בוקר טוב' : h < 17 ? 'צהריים טובים' : h < 21 ? 'ערב טוב' : 'לילה טוב';
}
const sourcesText = n => (n === 1 ? 'מקור אחד' : `${n} מקורות`);
const joinNames = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ו${names.at(-1)}`);
const catStyle = c => (c ? `--c:${c.color}` : null);
const catLabel = (c, fallback) => el('span', { class: 'cat', style: catStyle(c) }, c?.name ?? fallback);
const hotReasons = { 'several-articles': 'האתר פרסם כמה כתבות', 'near-match-elsewhere': 'כותרת דומה באתר נוסף', breaking: 'מבזק' };

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

// ---------- shared pieces ----------
function header({ title, brand = false, dark = false, back = false, share = null }) {
  return el('header', { class: `app-header${dark ? ' dark' : ''}` },
    back
      ? el('a', { class: 'icon-btn', href: '#/', 'aria-label': 'חזרה', onclick: e => { if (history.length > 1) { e.preventDefault(); history.back(); } } }, icon('back'))
      : el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'תפריט', onclick: openMenu }, icon('menu')),
    brand
      ? el('a', { class: 'brand', href: '#/' }, el('span', { class: 'brand-mark', 'aria-hidden': 'true' }), el('span', { class: 'brand-name' }, 'חדשות ישראל'))
      : el('span', { class: 'screen-title' }, title),
    share
      ? el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'שיתוף', onclick: share }, icon('share'))
      : el('a', { class: 'icon-btn', href: '#/saved', 'aria-label': 'השמורים שלי' }, icon('user')));
}

function updatedLine() {
  if (!data || data.error) return el('p', { class: 'scan-status' }, 'אין חיבור. ננסה שוב בעוד רגע.');
  if (!data.lastScanAt) return el('p', { class: 'scan-status' }, 'סורקים את אתרי החדשות בפעם הראשונה…');
  const stale = now() - data.lastScanAt > 30 * 60_000;
  return el('p', { class: `scan-status${stale ? ' stale' : ''}` }, `עודכן ${ago(data.lastScanAt)} · מתעדכן אוטומטית`);
}

// Where the design shows a photo, we show how widely the story is covered.
// The event's photo, loaded straight from the source site (as published in its own feed; never copied).
// If a photo cannot load, the lead/hero fall back to the colored panel and rows to the coverage tile.
function photo(image, cls) {
  // Photos are shown only when the published data allows it (showPhotos), so events saved on the device
  // before photos were turned off do not keep showing them.
  if (!data?.showPhotos || !image?.url || !/^https:\/\//.test(image.url)) return null;
  return el('img', {
    class: cls, src: image.url, alt: '', loading: 'lazy', decoding: 'async', referrerpolicy: 'no-referrer',
    onerror: e => { const box = e.target.closest('[data-has-photo]'); if (box) box.removeAttribute('data-has-photo'); e.target.remove(); },
  });
}
const credit = image => (image?.sourceName ? el('span', { class: 'credit' }, `צילום: ${image.sourceName}`) : null);

function thumb(ev, tall = false) {
  const tile = coverageTile(ev, tall);
  const img = photo(ev.image, 'thumb-img');
  if (!img) return tile;
  const box = el('div', { class: `thumb${tall ? ' tall' : ''}`, 'aria-hidden': 'true' }, img,
    el('span', { class: `thumb-badge${ev.singleSource ? ' hot' : ''}` }, ev.singleSource ? 'חם' : sourcesText(ev.sourceCount)));
  img.addEventListener('error', () => box.replaceWith(tile));
  return box;
}

function coverageTile(ev, tall = false) {
  if (ev.singleSource) return el('div', { class: `tile hot${tall ? ' tall' : ''}`, 'aria-hidden': 'true' }, el('b', {}, '1'), el('span', {}, 'מקור · חם'));
  return el('div', { class: `tile${tall ? ' tall' : ''}`, 'aria-hidden': 'true' },
    el('b', {}, String(ev.sourceCount)), el('span', {}, 'מקורות'),
    el('span', { class: 'dots' }, ev.sources.map(s => el('i', { style: `background:${s.color}` }))));
}

function coverageText(ev) {
  if (ev.singleSource) {
    const why = (ev.hot ?? []).map(r => hotReasons[r] ?? r);
    return `מקור אחד בלבד (${ev.sources[0]?.name ?? ''}) · עדיין לא סוקר באתר נוסף${why.length ? ` · ${why.join(', ')}` : ''}`;
  }
  return `סוקר ב-${sourcesText(ev.sourceCount)}: ${joinNames(ev.sources.map(s => s.name))}`;
}

function storyRow(ev, { saved = null } = {}) {
  const href = `#/event/${ev.id}`;
  const fresh = now() - ev.detectedAt < NEW_MS;
  const meta = saved
    ? `${saved.removable ? "נשמר" : "נצפה"} ${ago(saved.savedAt)} · ${sourcesText(ev.sourceCount)}`
    : `זוהה ${ago(ev.detectedAt)} · ${hhmm(ev.detectedAt)} · ${ev.singleSource ? ev.sources[0]?.name : sourcesText(ev.sourceCount)}`;
  return el('li', {},
    el('div', { class: 'story' },
      el('a', { href, class: 'copy', style: 'text-decoration:none;color:inherit' },
        el('span', { class: 'row', style: 'justify-content:flex-start;gap:8px' },
          catLabel(ev.category, 'חדשות'),
          ev.singleSource && el('span', { class: 'badge-hot' }, 'חם'),
          fresh && !saved && el('span', { class: 'badge-new' }, 'חדש')),
        el('h3', { lang: langOf(ev.title) }, ev.title),
        el('span', { class: 'meta' }, meta)),
      // (a button may not sit inside a link, so "unsave" is a sibling of the story link)
      saved?.removable && el('button', { class: 'unsave', type: 'button', 'aria-label': `הסרה מהשמורים: ${ev.title}`,
        onclick: () => { toggleSave(ev); toast('הוסר מהשמורים'); route({ refresh: false }); } }, icon('saved')),
      el('a', { href, tabindex: '-1', 'aria-hidden': 'true', style: 'text-decoration:none' }, thumb(ev, !!saved))));
}

function headlineRow(h) {
  return el('li', {},
    el('a', { class: 'story', href: safeUrl(h.link), target: '_blank', rel: 'noopener noreferrer', style: 'min-height:0' },
      el('span', { class: 'copy' },
        el('span', { class: 'row', style: 'justify-content:flex-start;gap:8px' }, catLabel({ name: h.sourceName, color: h.color })),
        el('h3', { lang: langOf(h.title), style: 'font-size:16px' }, h.title),
        el('span', { class: 'meta' }, `${h.category ? h.category.name + ' · ' : ''}${ago(h.publishedAt)} · פתח כתבה ↗`))));
}

function empty(...lines) { return el('div', { class: 'empty' }, lines.map(l => el('p', {}, l))); }

// ---------- screens ----------
function homeView() {
  document.title = 'חדשות ישראל';
  const latestBreaking = data?.breaking?.[0];
  const events = data?.events ?? [];
  const [lead, ...rest] = events;
  const d = new Date();
  return [
    header({ brand: true }),
    latestBreaking && el('a', { class: 'live-strip', href: '#/live', 'aria-label': `מבזק אחרון: ${latestBreaking.title}` },
      el('span', { class: 'live-label' }, 'חי'), el('span', { class: 'live-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'update', lang: langOf(latestBreaking.title) }, latestBreaking.title),
      el('time', { datetime: new Date(latestBreaking.publishedAt).toISOString() }, hhmm(latestBreaking.publishedAt))),
    el('main', { class: 'screen', id: 'main' },
      el('div', { class: 'edition' }, el('h1', {}, greeting()), el('span', { class: 'date' }, `${dayName(d)}, ${dayMonth(d)}`)),
      el('p', { class: 'tagline' }, 'החדשות שמסוקרות עכשיו במספר מקורות'),
      updatedLine(),
      data?.error && !events.length ? empty('לא הצלחנו לטעון את האירועים.', 'ננסה שוב בעוד דקה.')
        : !lead ? empty(data?.lastScanAt ? 'עדיין לא זוהו אירועים שמסוקרים ביותר ממקור אחד.' : 'סורקים את אתרי החדשות בפעם הראשונה…', 'הדף יתעדכן לבד.')
        : [
          el('a', { class: 'lead', href: `#/event/${lead.id}`, style: catStyle(lead.category), 'data-has-photo': lead.image ? '' : null },
            photo(lead.image, 'bg-photo'), credit(lead.image),
            el('span', { class: 'badge', style: catStyle(lead.category) }, lead.singleSource ? 'חם · מקור אחד' : lead.category?.name ?? 'חדשות'),
            el('h2', { lang: langOf(lead.title) }, lead.title),
            el('p', { class: 'summary' }, `${coverageText(lead)} · זוהה ${ago(lead.detectedAt)}`)),
          rest.length && el('div', { class: 'section-head' }, el('h2', {}, 'עוד בכותרות'), el('a', { class: 'action', href: '#/topics' }, 'לכל הכותרות')),
          rest.length && el('ul', { class: 'stories' }, rest.map(ev => storyRow(ev))),
        ],
      el('p', { class: 'footnote' }, 'האתר לא מעתיק כתבות: רק כותרות וקישורים לאתרים המקוריים.')),
  ];
}

function eventView(id, tab) {
  const ev = findEvent(id);
  if (!ev) return [header({ title: 'אירוע', back: true }), el('main', { class: 'screen' }, empty('האירוע כבר לא ברשימה.', 'ייתכן שהוחלף באירוע חדש יותר.'))];
  document.title = `${ev.title} · חדשות ישראל`;
  remember(ev);
  const bySource = new Map();
  for (const a of ev.articles) bySource.set(a.sourceId, [...(bySource.get(a.sourceId) ?? []), a]);
  const current = tab === 'sources' ? 'sources' : 'what';
  const go = key => location.replace(`#/event/${id}${key === 'sources' ? '/sources' : ''}`);
  const tabBtn = (key, label) => el('button', {
    class: 'tab', role: 'tab', type: 'button', id: `tab-${key}`, 'aria-controls': `panel-${key}`, 'aria-selected': String(current === key),
    tabindex: current === key ? '0' : '-1', onclick: () => go(key),
    onkeydown: e => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') go(key === 'sources' ? 'what' : 'sources'); },
  }, label);
  const share = async () => {
    const payload = { title: ev.title, text: `${ev.title} — ${coverageText(ev)}`, url: location.href };
    try { if (navigator.share) await navigator.share(payload); else { await navigator.clipboard.writeText(location.href); toast('הקישור הועתק'); } } catch { /* cancelled */ }
  };
  const saved = isSaved(ev.id);
  const live = data?.events.some(e => e.id === ev.id);

  const whatHappened = el('section', { class: 'screen', style: 'padding-top:0', id: 'panel-what', role: 'tabpanel', 'aria-labelledby': 'tab-what' },
    el('div', { class: 'quote', style: catStyle(ev.category) }, el('p', { lang: langOf(ev.title) }, ev.title)),
    el('ul', { class: 'headline-list' }, ev.articles.map(a =>
      el('li', {}, el('span', { class: 'src' }, catLabel({ name: a.sourceName, color: a.color })), el('p', { lang: langOf(a.title) }, a.title)))));

  const sources = el('section', { class: 'screen', style: 'padding-top:0', id: 'panel-sources', role: 'tabpanel', 'aria-labelledby': 'tab-sources' },
    el('ul', { class: 'stories' }, [...bySource.values()].map(list => el('li', {},
      el('div', { style: 'padding:12px 0;display:flex;flex-direction:column;gap:6px' },
        catLabel({ name: list[0].sourceName, color: list[0].color }),
        list.map(a => el('div', {},
          el('h3', { lang: langOf(a.title), style: 'font-size:17px;line-height:1.28' }, a.title),
          el('div', { class: 'row', style: 'display:flex;justify-content:space-between;align-items:center;gap:8px' },
            el('span', { class: 'meta', style: 'color:var(--muted);font-size:12px' }, a.publishedAt ? `פורסם ${ago(a.publishedAt)} · ${hhmm(a.publishedAt)}` : ''),
            el('a', { class: 'open-link', href: safeUrl(a.link), target: '_blank', rel: 'noopener noreferrer' },
              'פתח כתבה ↗', el('span', { class: 'visually-hidden' }, ` (${a.sourceName}, נפתח בחלון חדש)`))))))))));

  return [
    el('div', { class: 'article-chrome' }, header({ title: 'אירוע', dark: true, back: true, share })),
    el('section', { class: 'hero', style: catStyle(ev.category), 'data-has-photo': ev.image ? '' : null },
      photo(ev.image, 'bg-photo'), credit(ev.image),
      el('span', { class: 'badge', style: catStyle(ev.category) }, ev.singleSource ? 'חם · מקור אחד' : ev.category?.name ?? 'חדשות'),
      el('h1', { lang: langOf(ev.title) }, ev.title)),
    el('main', { class: 'screen', id: 'main' },
      el('p', { class: 'standfirst' }, coverageText(ev) + '.'),
      el('div', { class: 'byline' },
        el('div', { class: 'who' },
          el('b', {}, ev.singleSource ? 'כתבה חמה ממקור אחד' : 'זוהה אוטומטית בכמה אתרים'),
          el('span', {}, `${isToday(ev.detectedAt) ? 'היום' : new Date(ev.detectedAt).toLocaleDateString('he-IL')} · ${hhmm(ev.detectedAt)} · ${live ? `עודכן ${ago(ev.lastUpdatedAt ?? ev.detectedAt)}` : 'כבר לא ברשימה הראשית'}`)),
        el('span', { class: 'stack', 'aria-hidden': 'true' }, ev.sources.map(s => el('i', { style: `background:${s.color}` })))),
      el('div', { class: 'divider' }),
      el('div', { class: 'actions' },
        el('button', { class: 'action-btn', type: 'button', 'aria-pressed': String(saved),
          onclick: () => { toast(toggleSave(ev) ? 'נשמר לקריאה אחר כך' : 'הוסר מהשמורים'); route({ refresh: false }); } },
          icon(saved ? 'saved' : 'save'), saved ? 'נשמר' : 'שמירה'),
        el('button', { class: 'action-btn', type: 'button', onclick: share }, icon('share'), 'שיתוף'),
        el('a', { class: 'action-btn', href: `#/event/${id}/sources` }, `${ev.articles.length} כתבות`))),
    el('div', { style: 'padding:0 var(--gutter)' },
      el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'תצוגת אירוע' }, tabBtn('what', 'מה קרה?'), tabBtn('sources', `מקורות (${ev.sourceCount})`))),
    el('div', { style: 'height:12px' }),
    current === 'what' ? whatHappened : sources,
  ];
}

function liveView() {
  document.title = 'מבזקים · חדשות ישראל';
  const items = (data?.breaking ?? []).filter(b => now() - b.publishedAt < 24 * 3600_000);
  const names = [...new Set(items.map(b => b.sourceName))];
  return [
    header({ title: 'מבזקים חיים' }),
    el('main', { class: 'screen', id: 'main' },
      el('section', { class: 'night-card' },
        el('div', { class: 'top' }, el('h2', {}, 'החדשות, בזמן אמת'),
          data?.lastScanAt && el('span', { class: 'note' }, icon('bell'), `עודכן ${ago(data.lastScanAt)}`)),
        el('p', {}, `מבזקים כפי שפורסמו בפידים הרשמיים${names.length ? ` של ${joinNames(names)}` : ''}. כל כותרת מובילה לאתר המקורי.`)),
      el('div', { class: 'section-head' }, el('h2', {}, `היום, ${dayMonth(new Date())}`)),
      !items.length ? empty('אין מבזקים מ-24 השעות האחרונות.')
        : el('ol', { class: 'timeline' }, items.map((b, i) => {
          const fresh = now() - b.publishedAt < 15 * 60_000;
          return el('li', { class: `tl-item${fresh || i === 0 ? ' fresh' : ''}` },
            el('div', { class: 'tl-marker', 'aria-hidden': 'true' },
              el('time', {}, hhmm(b.publishedAt)), el('span', { class: 'point' }), i < items.length - 1 && el('span', { class: 'rail' })),
            el('div', { class: 'tl-body' },
              el('div', { class: 'tl-meta' }, fresh && el('span', { class: 'badge-new' }, 'חדש'), el('span', {}, b.category?.name ?? 'מבזק'), el('span', { style: `color:${b.color}` }, `· ${b.sourceName}`)),
              el('h3', { lang: langOf(b.title) }, el('a', { href: safeUrl(b.link), target: '_blank', rel: 'noopener noreferrer' }, b.title)),
              el('p', { class: 'detail' }, el('time', { class: 'visually-hidden', datetime: new Date(b.publishedAt).toISOString() }, hhmm(b.publishedAt)), `${ago(b.publishedAt)} · פתח ב-${b.sourceName} ↗`)));
        }))),
  ];
}

const topicState = { q: '', sources: new Set() };
function topicsView(catId) {
  document.title = 'נושאים · חדשות ישראל';
  const all = data?.headlines ?? [];
  const cats = data?.categories ?? [];
  const cat = catId ? cats.find(c => c.id === catId) : null;
  const q = topicState.q.trim();
  const filtered = all.filter(h =>
    (!cat || h.category?.id === cat.id) &&
    (!topicState.sources.size || topicState.sources.has(h.sourceId)) &&
    (!q || h.title.includes(q)));
  const counts = new Map();
  for (const h of all) if (h.category) counts.set(h.category.id, (counts.get(h.category.id) ?? 0) + 1);
  const ranked = cats.filter(c => counts.get(c.id)).sort((a, b) => counts.get(b.id) - counts.get(a.id));
  const perSource = new Map();
  for (const h of all) perSource.set(h.sourceId, (perSource.get(h.sourceId) ?? 0) + 1);
  const browsing = !cat && !q && !topicState.sources.size;

  const results = el('ul', { class: 'stories', id: 'results' }, filtered.slice(0, 60).map(headlineRow));
  const input = el('input', {
    type: 'search', value: topicState.q, placeholder: 'חיפוש כותרת, נושא או מקום', 'aria-label': 'חיפוש בכותרות',
    oninput: e => { topicState.q = e.target.value; rerenderKeepingFocus(); },
  });

  return [
    header({ title: cat ? cat.name : 'נושאים', back: !!cat }),
    el('main', { class: 'screen', id: 'main' },
      el('label', { class: 'search' }, input, icon('search')),
      el('div', { class: 'section-head' }, el('h2', {}, 'המקורות'),
        topicState.sources.size ? el('button', { class: 'action', type: 'button', onclick: () => { topicState.sources.clear(); route({ refresh: false }); } }, 'ניקוי') : el('span', { class: 'action', style: 'color:var(--faint)' }, 'סינון לפי אתר')),
      el('ul', { class: 'chips' }, (data?.sources ?? []).map(s => {
        const on = topicState.sources.has(s.id);
        return el('li', {}, el('button', { class: 'chip', type: 'button', 'aria-pressed': String(on || !topicState.sources.size),
          onclick: () => { on ? topicState.sources.delete(s.id) : topicState.sources.add(s.id); route({ refresh: false }); } },
          el('span', { class: 'dot', style: `background:${s.color}` }), `${s.name} · ${perSource.get(s.id) ?? 0}`, on && icon('x')));
      })),
      browsing && ranked.length >= 3 && [
        el('div', { class: 'section-head' }, el('h2', {}, 'לגלות עוד'), el('span', { class: 'rule', 'aria-hidden': 'true' })),
        el('div', { class: 'mosaic' }, ranked.slice(0, 3).map((c, i) =>
          el('a', { class: `topic-tile${i === 2 ? ' wide' : ''}`, href: `#/topics/${c.id}`, style: `--c:${c.color}` },
            el('span', { class: 'name' }, c.name), el('span', { class: 'count' }, `${counts.get(c.id)} כותרות ב-24 שעות`)))),
        el('ul', { class: 'stories' }, ranked.slice(3).map(c => el('li', {},
          el('a', { class: 'list-link', href: `#/topics/${c.id}` }, el('span', { class: 'label' }, el('span', { class: 'cat', style: `--c:${c.color}` }, c.name), `${counts.get(c.id)} כותרות`), icon('more'))))),
      ],
      el('div', { class: 'section-head' }, el('h2', {}, browsing ? 'כל הכותרות' : `${filtered.length} כותרות`)),
      filtered.length ? results : empty('לא נמצאו כותרות.', 'נסו מילה אחרת או הסירו את הסינון.')),
  ];
}
// Typing in the search box re-renders the list without losing the cursor.
function rerenderKeepingFocus() {
  const pos = document.activeElement?.selectionStart;
  route({ refresh: false });
  const input = app.querySelector('.search input');
  if (input) { input.focus(); if (pos != null) input.setSelectionRange(pos, pos); }
}

function savedView(tab) {
  document.title = 'שמורים · חדשות ישראל';
  const saved = store.get(SAVED), hist = store.get(HISTORY);
  const current = tab === 'history' ? 'history' : 'saved';
  const list = current === 'saved' ? saved : hist;
  const tabLink = (key, label) => el('a', { class: 'tab', role: 'tab', href: key === 'saved' ? '#/saved' : '#/saved/history', 'aria-selected': String(current === key) }, label);
  return [
    header({ title: 'האזור שלי' }),
    el('main', { class: 'screen', id: 'main' },
      el('section', { class: 'profile-card' },
        el('div', { class: 'details' },
          el('h2', {}, 'השמורים שלך'),
          el('p', { class: 'sub' }, 'נשמרים במכשיר הזה בלבד · בלי חשבון ובלי הרשמה'),
          el('p', { class: 'stats' }, el('span', {}, `${saved.length} שמורים`), el('span', {}, `${hist.length} נצפו לאחרונה`))),
        el('span', { class: 'avatar', 'aria-hidden': 'true' }, icon('saved'))),
      el('nav', { class: 'tabs', role: 'tablist', 'aria-label': 'שמורים והיסטוריה' }, tabLink('saved', 'שמורים'), tabLink('history', 'היסטוריה')),
      el('div', { class: 'section-head' }, el('h2', {}, current === 'saved' ? 'לקריאה אחר כך' : 'נצפו לאחרונה'),
        list.length ? el('button', { class: 'action', type: 'button', onclick: () => { if (confirm(current === 'saved' ? 'למחוק את כל השמורים?' : 'לנקות את ההיסטוריה?')) { store.set(current === 'saved' ? SAVED : HISTORY, []); route({ refresh: false }); } } }, 'ניקוי') : null),
      !list.length ? empty(current === 'saved' ? 'עדיין לא שמרת אירועים.' : 'עדיין לא פתחת אירועים.', current === 'saved' ? 'במסך של אירוע לוחצים "שמירה".' : '')
        : el('ul', { class: 'stories' }, list.map(s => storyRow(s.event, { saved: current === 'saved' ? { ...s, removable: true } : { savedAt: s.viewedAt } }))),
      el('a', { class: 'list-link', href: '#/status' }, el('span', { class: 'label' }, icon('settings'), 'מצב המקורות והגדרות הסריקה'), icon('more'))),
  ];
}

async function statusView() {
  document.title = 'מצב המקורות · חדשות ישראל';
  let s;
  try { s = await (await fetch(dataUrl('status.json'), { cache: 'no-store' })).json(); } catch { s = null; }
  const body = !s ? empty('אין חיבור לשרת.') : [
    el('p', { style: 'color:var(--muted);font-size:13px' }, `מינימום מקורות לאירוע: ${s.settings.minSources} · סף דמיון: ${s.settings.similarityThreshold} · סריקה כל ${s.settings.scanIntervalMinutes} דקות`),
    el('table', { class: 'status-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'מקור'), el('th', {}, 'מצב'), el('th', {}, 'עדכון'), el('th', {}, 'פריטים'))),
      el('tbody', {}, s.sources.flatMap(src => src.feeds.map(f => el('tr', {},
        el('td', {}, catLabel({ name: src.name, color: src.color })),
        el('td', {}, f.lastError ? el('span', { class: 'bad' }, `שגיאה: ${f.lastError}`) : f.lastOkAt ? el('span', { class: 'ok' }, 'תקין') : '—'),
        el('td', {}, f.lastOkAt ? ago(f.lastOkAt) : '—'),
        el('td', {}, String(f.items))))))),
  ];
  return [header({ title: 'מצב המקורות', back: true }), el('main', { class: 'screen', id: 'main' }, body)];
}

// ---------- menu ----------
function openMenu() {
  const close = () => { backdrop.remove(); sheet.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const link = (href, ic, label) => el('a', { href, onclick: close }, icon(ic), label);
  const backdrop = el('div', { class: 'sheet-backdrop', onclick: close });
  const sheet = el('aside', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'תפריט' },
    el('div', { class: 'sheet-head' },
      el('a', { class: 'brand', href: '#/', onclick: close, style: 'border:0' }, el('span', { class: 'brand-mark' }), el('span', { class: 'brand-name', style: 'font-size:20px' }, 'חדשות ישראל')),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'סגירה', onclick: close }, icon('x'))),
    link('#/', 'house', 'בית'), link('#/live', 'radio', 'מבזקים'), link('#/topics', 'grid', 'נושאים'), link('#/saved', 'bookmark', 'שמורים'), link('#/status', 'settings', 'מצב המקורות'),
    el('p', { class: 'about' }, 'האתר סורק אתרי חדשות ישראליים כל כמה דקות, ומציג רק אירועים שמסוקרים בלפחות שני אתרים (או כתבה "חמה" ממקור אחד, מסומנת). מוצגות כותרות וקישורים בלבד, והקריאה עצמה נעשית באתר המקורי.'));
  document.body.append(backdrop, sheet);
  document.addEventListener('keydown', onKey);
  sheet.querySelector('a')?.focus();
}

// ---------- router ----------
function setNav(key) {
  for (const a of document.querySelectorAll('.nav-item')) {
    if (a.dataset.nav === key) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  }
}

async function route({ refresh = true } = {}) {
  if (refresh) await load();
  // Read the address only after loading: the reader may have tapped elsewhere while data was loading.
  const hash = location.hash || '#/';
  let view, nav = 'home', m;
  if ((m = hash.match(/^#\/event\/([\w-]+)(\/sources)?$/))) view = eventView(m[1], m[2] ? 'sources' : 'what');
  else if (hash === '#/live') { view = liveView(); nav = 'live'; }
  else if ((m = hash.match(/^#\/topics(?:\/(\w+))?$/))) { view = topicsView(m[1]); nav = 'topics'; }
  else if ((m = hash.match(/^#\/saved(\/history)?$/))) { view = savedView(m[1] ? 'history' : 'saved'); nav = 'saved'; }
  else if (hash === '#/status') { view = await statusView(); nav = 'saved'; }
  else view = homeView();
  setNav(nav);
  const y = window.scrollY;
  app.replaceChildren(...[view].flat(Infinity).filter(Boolean));
  return y;
}

let lastHash = location.hash;
window.addEventListener('hashchange', async () => {
  const prevTab = document.activeElement?.id;
  const sameScreen = lastHash.split('/').slice(0, 3).join('/') === location.hash.split('/').slice(0, 3).join('/');
  lastHash = location.hash;
  await route({ refresh: false });
  if (prevTab?.startsWith('tab-') && sameScreen) document.querySelector('.tab[aria-selected="true"]')?.focus();
  else window.scrollTo(0, 0);
});

let busy = false;
async function tick() {
  if (busy || app.querySelector('.search input') === document.activeElement) return; // don't disturb typing
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

// ---------- fixed app scale ----------
// The app keeps one size no matter what: iOS Safari ignores user-scalable=no, so pinch gestures and
// desktop Ctrl+wheel / Ctrl +/- are blocked here as well. (Double-tap zoom is off via CSS touch-action,
// which — unlike a JS double-tap filter — never swallows a real tap.)
{
  const block = e => e.preventDefault();
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, block, { passive: false });
  document.addEventListener('touchmove', e => { if (e.touches.length > 1 || (e.scale && e.scale !== 1)) e.preventDefault(); }, { passive: false });
  document.addEventListener('wheel', e => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && ['+', '=', '-', '_', '0'].includes(e.key)) e.preventDefault();
  });
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
