// זמן אמת — client. Plain DOM (no framework); all text goes through textContent (no HTML injection).
// Screens follow the Figma file "אפליקציית חדשות": בית · אירוע (כתבה) · מבזקים · נושאים · שמורים.
const app = document.getElementById('app');
const BRAND = 'זמן אמת';
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
// Any other public host (e.g. Vercel) serves only the page itself and reads the same `data` branch.
const LOCAL = ['localhost', '127.0.0.1', '[::1]', ''].includes(location.hostname);
const PAGES = !LOCAL;
const REPO = location.hostname.endsWith('.github.io')
  ? `${location.hostname.split('.')[0]}/${location.pathname.split('/')[1]}`
  : 'itaiavni29-art/israel---news';
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
// Brand mark: two corners framing a red dot ("the moment, here and now").
const brandMark = (src = 'logo-mark-white.svg') => el('img', { class: 'brand-mark', src, alt: '', width: 26, height: 26 });
const icon = name => el('span', { class: `icon i-${name}`, 'aria-hidden': 'true' });
const now = () => Date.now();
const hhmm = ms => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jerusalem' });
const safeUrl = u => (/^https?:\/\//i.test(u) ? u : '#');
const langOf = s => (/[א-ת]/.test(s) ? 'he' : 'en');
const isToday = ms => new Date(ms).toDateString() === new Date().toDateString();

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
const sourcesText = n => (n === 1 ? 'מקור אחד' : `${n} מקורות`);
const joinNames = names => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} ו${names.at(-1)}`);
const catLabel = (c, fallback) => el('span', { class: 'cat' }, c?.name ?? fallback);
const srcLabel = (name, color) => el('span', { class: 'src-tag', style: `--c:${color}` }, name);
const dayLong = d => new Intl.DateTimeFormat('he-IL', { weekday: 'long', timeZone: 'Asia/Jerusalem' }).format(d);
const dayNum = d => new Intl.DateTimeFormat('he-IL', { day: 'numeric', month: 'numeric', timeZone: 'Asia/Jerusalem' }).format(d);
const hotReasons = { 'several-articles': 'האתר פרסם כמה כתבות', 'near-match-elsewhere': 'כותרת דומה באתר נוסף', breaking: 'מבזק' };

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = el('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), 2200);
}

// ---------- shared pieces ----------
// Blue bar with the logo in the middle. `title` adds a grey bar with the screen's name under it;
// `textSize` swaps the search button for "א+" (bigger text on the event screen).
function header({ title = null, back = false, textSize = false } = {}) {
  return [
    el('header', { class: 'app-header' },
      back
        ? el('a', { class: 'icon-btn', href: '#/', 'aria-label': 'חזרה', onclick: e => { if (history.length > 1) { e.preventDefault(); history.back(); } } }, icon('back'))
        : el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'תפריט', onclick: openMenu }, icon('menu')),
      el('a', { class: 'brand', href: '#/', 'aria-label': `${BRAND} — לעמוד הראשי` }, brandMark(), el('span', { class: 'brand-name' }, BRAND)),
      textSize
        ? el('button', { class: 'icon-btn text-size', type: 'button', 'aria-label': 'הגדלת הטקסט', 'aria-pressed': String(bigText()), onclick: toggleBigText }, 'א+')
        : el('a', { class: 'icon-btn', href: '#/topics', 'aria-label': 'חיפוש' }, icon('search'))),
    title && el('div', { class: 'page-bar' }, el('h1', {}, title)),
  ];
}

// "א+": larger reading text, remembered on this device.
const BIG = 'in:big';
const bigText = () => { try { return localStorage.getItem(BIG) === '1'; } catch { return false; } };
function toggleBigText() {
  const on = !bigText();
  try { localStorage.setItem(BIG, on ? '1' : '0'); } catch { /* private mode */ }
  document.documentElement.classList.toggle('big-text', on);
  document.querySelector('.text-size')?.setAttribute('aria-pressed', String(on));
}
document.documentElement.classList.toggle('big-text', bigText());

// The row of sections under the header: "ראשי" and the topics found in today's headlines.
function sectionTabs(active = null) {
  const link = (href, label, on) => el('a', { href, 'aria-current': on ? 'page' : null }, label);
  return el('nav', { class: 'sections', 'aria-label': 'מדורים' },
    link('#/', 'ראשי', active == null), (data?.categories ?? []).map(c => link(`#/topics/${c.id}`, c.name, active === c.id)));
}

function updatedText() {
  if (!data || data.error) return 'אין חיבור. ננסה שוב בעוד רגע.';
  if (!data.lastScanAt) return 'סורקים את אתרי החדשות בפעם הראשונה…';
  return `עודכן ${ago(data.lastScanAt)} · מתעדכן אוטומטית`;
}
const isStale = () => !data || data.error || (data.lastScanAt && now() - data.lastScanAt > 30 * 60_000);

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
      el('a', { class: 'read-more', href, tabindex: '-1', 'aria-hidden': 'true' }, 'קרא עוד')));
}

function headlineRow(h) {
  return el('li', {},
    el('a', { class: 'story', href: safeUrl(h.link), target: '_blank', rel: 'noopener noreferrer', style: 'min-height:0' },
      el('span', { class: 'copy' },
        el('span', { class: 'row', style: 'justify-content:flex-start;gap:8px' }, srcLabel(h.sourceName, h.color)),
        el('h3', { lang: langOf(h.title), style: 'font-size:16px' }, h.title),
        el('span', { class: 'meta' }, `${h.category ? h.category.name + ' · ' : ''}${ago(h.publishedAt)} · פתח כתבה ↗`))));
}

function empty(...lines) { return el('div', { class: 'empty' }, lines.map(l => el('p', {}, l))); }

// ---------- screens ----------
function homeView() {
  document.title = BRAND;
  const latestBreaking = data?.breaking?.[0];
  const events = data?.events ?? [];
  const [lead, ...rest] = events;
  return [
    header(), sectionTabs(),
    latestBreaking && el('a', { class: 'live-strip', href: '#/live', 'aria-label': `מבזק אחרון: ${latestBreaking.title}` },
      el('span', { class: 'live-label' }, 'מבזק'),
      el('time', { datetime: new Date(latestBreaking.publishedAt).toISOString() }, hhmm(latestBreaking.publishedAt)),
      el('span', { class: 'update', lang: langOf(latestBreaking.title) }, latestBreaking.title)),
    isStale() && el('p', { class: 'scan-status stale' }, updatedText()),
    el('main', { class: 'screen home', id: 'main' },
      data?.error && !events.length ? empty('לא הצלחנו לטעון את האירועים.', 'ננסה שוב בעוד דקה.')
        : !lead ? empty(data?.lastScanAt ? 'עדיין לא זוהו אירועים שמסוקרים ביותר ממקור אחד.' : 'סורקים את אתרי החדשות בפעם הראשונה…', 'הדף יתעדכן לבד.')
        : [
          // Where a news site would put its main photo, we show what this app is about: who is covering the story.
          el('a', { class: 'lead', href: `#/event/${lead.id}` },
            el('span', { class: 'coverage' },
              el('span', { class: 'count' }, el('b', {}, lead.singleSource ? 'חם' : String(lead.sourceCount)), lead.singleSource ? 'מקור אחד' : 'אתרים מסקרים עכשיו'),
              el('span', { class: 'names' }, lead.sources.map(s => el('i', { style: `--c:${s.color}` }, s.name)))),
            el('span', { class: 'lead-copy' },
              el('span', { class: 'row' }, catLabel(lead.category, 'חדשות'), lead.lead && el('span', { class: 'badge-new' }, 'הסיפור המרכזי')),
              el('h2', { lang: langOf(lead.title) }, lead.title),
              data?.showSummaries && lead.summary?.text && el('p', { class: 'summary' }, lead.summary.text),
              el('span', { class: 'meta' }, `${sourcesText(lead.sourceCount)} | ${hhmm(lead.detectedAt)} | זוהה ${ago(lead.detectedAt)}`))),
          rest.length && el('div', { class: 'band', 'aria-hidden': 'true' }),
          rest.length && el('ul', { class: 'stories' }, rest.map(ev => storyRow(ev))),
        ],
      el('p', { class: 'footnote' }, `${updatedText()}. האתר לא מעתיק כתבות: רק כותרות וקישורים לאתרים המקוריים.`)),
  ];
}

function eventView(id, tab) {
  const ev = findEvent(id);
  if (!ev) return [header({ back: true }), el('main', { class: 'screen' }, empty('האירוע כבר לא ברשימה.', 'ייתכן שהוחלף באירוע חדש יותר.'))];
  document.title = `${ev.title} · ${BRAND}`;
  remember(ev);
  const bySource = new Map();
  for (const a of ev.articles) bySource.set(a.sourceId, [...(bySource.get(a.sourceId) ?? []), a]);
  const share = async () => {
    const payload = { title: ev.title, text: `${ev.title} — ${coverageText(ev)}`, url: location.href };
    try { if (navigator.share) await navigator.share(payload); else { await navigator.clipboard.writeText(location.href); toast('הקישור הועתק'); } } catch { /* cancelled */ }
  };
  const saved = isSaved(ev.id);
  const live = data?.events.some(e => e.id === ev.id);
  const toSources = () => document.getElementById('sources')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  if (tab === 'sources') setTimeout(toSources, 0);
  const day = isToday(ev.detectedAt) ? 'היום' : new Date(ev.detectedAt).toLocaleDateString('he-IL');

  return [
    header({ back: true, textSize: true }),
    el('main', { class: 'screen article', id: 'main' },
      el('span', { class: 'row' }, catLabel(ev.category, 'חדשות'), ev.singleSource && el('span', { class: 'badge-hot' }, 'חם · מקור אחד')),
      el('h1', { lang: langOf(ev.title) }, ev.title),
      el('p', { class: 'standfirst' }, coverageText(ev) + '.'),
      el('div', { class: 'meta-row' },
        el('span', {}, el('b', {}, ev.singleSource ? ev.sources[0]?.name ?? '' : sourcesText(ev.sourceCount)), ` | ${day} | ${hhmm(ev.detectedAt)}`),
        el('span', {}, live ? `עודכן: ${hhmm(ev.lastUpdatedAt ?? ev.detectedAt)}` : 'כבר לא ברשימה הראשית')),
      // AI summary written from the sources' headlines and teasers — shown only once enabled after review.
      data?.showSummaries && ev.summary?.text && el('section', { class: 'ai-summary', 'aria-label': 'סיכום אוטומטי' },
        // A single-source summary names its source and links straight to the original article.
        el('span', { class: 'ai-label' }, ev.summary.single ? `סיכום אוטומטי · לפי ${ev.articles[0]?.sourceName ?? ''}` : 'סיכום אוטומטי מכמה מקורות'),
        el('p', { class: 'body', lang: 'he' }, ev.summary.text),
        ev.summary.single && ev.articles[0] && el('a', { class: 'open-link', href: safeUrl(ev.articles[0].link), target: '_blank', rel: 'noopener noreferrer' },
          `לכתבה המלאה ב-${ev.articles[0].sourceName} ↗`),
        el('p', { class: 'ai-note' }, ev.summary.single
          ? 'נכתב אוטומטית על ידי בינה מלאכותית, בניסוח עצמאי, על סמך הכותרת והתקציר שפרסם המקור. ייתכנו אי־דיוקים — הכתבה המלאה נמצאת באתר המקורי.'
          : 'נכתב אוטומטית על ידי בינה מלאכותית מתוך הכותרות והתקצירים שפרסמו המקורות. ייתכנו אי־דיוקים — לפרטים המלאים פתחו את הכתבות המקוריות.')),
      el('h2', { class: 'sub-head', id: 'sources' }, `הכתבות המקוריות (${ev.articles.length})`),
      el('ul', { class: 'source-list' }, [...bySource.values()].map(list => el('li', {},
        srcLabel(list[0].sourceName, list[0].color),
        list.map(a => el('a', { class: 'source-item', href: safeUrl(a.link), target: '_blank', rel: 'noopener noreferrer' },
          el('h3', { lang: langOf(a.title) }, a.title),
          el('span', { class: 'meta' }, a.publishedAt ? `${hhmm(a.publishedAt)} · ${ago(a.publishedAt)} · ` : '', el('b', {}, 'לכתבה המלאה ↗'),
            el('span', { class: 'visually-hidden' }, ` (${a.sourceName}, נפתח בחלון חדש)`)))))))),
    // On this screen the bottom bar holds the story's actions instead of the app's navigation.
    el('div', { class: 'action-bar' },
      el('button', { type: 'button', onclick: share }, icon('share'), 'שיתוף'),
      el('button', { type: 'button', 'aria-pressed': String(saved),
        onclick: () => { toast(toggleSave(ev) ? 'נשמר לקריאה אחר כך' : 'הוסר מהשמורים'); route({ refresh: false }); } },
        icon(saved ? 'saved' : 'bookmark'), saved ? 'נשמר' : 'שמירה'),
      el('button', { type: 'button', onclick: toSources }, icon('grid'), `מקורות (${ev.sourceCount})`)),
  ];
}

function liveView() {
  document.title = 'מבזקים · ' + BRAND;
  const items = (data?.breaking ?? []).filter(b => now() - b.publishedAt < 24 * 3600_000);
  const d = new Date();
  return [
    el('header', { class: 'app-header live' },
      el('h1', {}, 'מבזקים'),
      el('span', { class: 'on-air' }, el('span', { class: 'live-dot', 'aria-hidden': 'true' }), 'שידור חי')),
    el('div', { class: 'page-bar' }, el('b', {}, `היום, ${dayLong(d)} ${dayNum(d)}`),
      data?.lastScanAt && el('span', {}, `עדכון אחרון ${hhmm(data.lastScanAt)}`)),
    el('main', { class: 'screen flashes', id: 'main' },
      !items.length ? empty('אין מבזקים מ-24 השעות האחרונות.')
        : el('ol', { class: 'flash-list' }, items.map((b, i) =>
          el('li', { class: i === 0 ? 'first' : null },
            el('a', { href: safeUrl(b.link), target: '_blank', rel: 'noopener noreferrer' },
              el('time', { datetime: new Date(b.publishedAt).toISOString() }, hhmm(b.publishedAt)),
              el('span', { class: 'copy' },
                el('h3', { lang: langOf(b.title) }, b.title),
                el('span', { class: 'meta' }, `${b.sourceName}${b.category ? ' | ' + b.category.name : ''} | `, el('b', {}, 'לכתבה המלאה ↗'))))))),
      el('p', { class: 'footnote' }, 'מבזקים כפי שפורסמו בפידים הרשמיים של האתרים. כל כותרת מובילה לאתר המקורי.')),
  ];
}

const topicState = { q: '', sources: new Set() };
function topicsView(catId) {
  document.title = 'מדורים · ' + BRAND;
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
    header({ title: cat ? cat.name : 'מדורים', back: !!cat }), cat && sectionTabs(cat.id),
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
          el('a', { class: 'list-link', href: `#/topics/${c.id}` }, el('span', { class: 'label' }, el('span', { class: 'cat' }, c.name), `${counts.get(c.id)} כותרות`), icon('more'))))),
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
  document.title = 'שמורים · ' + BRAND;
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
  document.title = 'מצב המקורות · ' + BRAND;
  let s;
  try { s = await (await fetch(dataUrl('status.json'), { cache: 'no-store' })).json(); } catch { s = null; }
  const body = !s ? empty('אין חיבור לשרת.') : [
    el('p', { style: 'color:var(--muted);font-size:13px' }, `מינימום מקורות לאירוע: ${s.settings.minSources} · סף דמיון: ${s.settings.similarityThreshold} · סריקה כל ${s.settings.scanIntervalMinutes} דקות`),
    el('table', { class: 'status-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'מקור'), el('th', {}, 'מצב'), el('th', {}, 'עדכון'), el('th', {}, 'פריטים'))),
      el('tbody', {}, s.sources.flatMap(src => src.feeds.map(f => el('tr', {},
        el('td', {}, srcLabel(src.name, src.color)),
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
      el('a', { class: 'brand on-light', href: '#/', onclick: close, style: 'border:0' }, brandMark('logo-mark.svg'), el('span', { class: 'brand-name' }, BRAND)),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'סגירה', onclick: close }, icon('x'))),
    link('#/', 'house', 'ראשי'), link('#/live', 'zap', 'מבזקים'), link('#/topics', 'grid', 'מדורים'), link('#/saved', 'bookmark', 'שמורים'), link('#/status', 'settings', 'מצב המקורות'),
    el('a', { href: '#', onclick: e => { e.preventDefault(); close(); openInstallGuide(); } }, icon('house'), 'הוספה למסך הבית'),
    el('p', { class: 'about' }, 'האתר סורק אתרי חדשות ישראליים כל כמה דקות, ומציג רק אירועים שמסוקרים בלפחות שני אתרים (או כתבה "חמה" ממקור אחד, מסומנת). מוצגות כותרות וקישורים בלבד, והקריאה עצמה נעשית באתר המקורי.'));
  document.body.append(backdrop, sheet);
  document.addEventListener('keydown', onKey);
  sheet.querySelector('a')?.focus();
}

// ---------- "add to home screen" guide ----------
// Shown on phones on the 1st, 4th, 7th… visit (a visit = a browser session), never inside the installed
// app, and never again after "אל תציג שוב". Always reachable from the menu.
const A2HS = 'in:a2hs';
const a2hs = {
  get() { try { return JSON.parse(localStorage.getItem(A2HS)) ?? {}; } catch { return {}; } },
  set(v) { try { localStorage.setItem(A2HS, JSON.stringify(v)); } catch { /* private mode */ } },
};
const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isAndroid = /Android/.test(navigator.userAgent);
const isInstalled = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null; // Android Chrome hands us its own install dialog when the site qualifies
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; document.querySelector('.guide .one-tap')?.removeAttribute('hidden'); });

// Drawings for the steps: schematic, drawn here (not screenshots of anyone's interface).
const art = body => { const d = el('div', { class: 'guide-art', 'aria-hidden': 'true' }); d.innerHTML = `<svg viewBox="0 0 240 120" xmlns="http://www.w3.org/2000/svg" font-family="Arimo, Arial, sans-serif">${body}</svg>`; return d; };
const SHARE = (x, y) => `<g transform="translate(${x} ${y})" fill="none" stroke="var(--brand)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M-7 -2v11h14v-11"/><path d="M0 3v-15"/><path d="M-5 -8l5 -5 5 5"/></g>`;
const RING = (x, y, r = 17) => `<circle cx="${x}" cy="${y}" r="${r}" fill="var(--live-soft)" stroke="var(--live)" stroke-width="2.5"/>`;
const APP = (x, y, s = 1) => `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-17" y="-17" width="34" height="34" rx="8" fill="#0e1317"/><path d="M-7 -1v-6h6M7 1v6h-6" fill="none" stroke="#fff" stroke-width="2.2"/><circle r="2" fill="#e0282e"/></g>`;
const ROW = (y, label, on) => `<rect x="34" y="${y}" width="172" height="24" rx="7" fill="${on ? 'var(--live-soft)' : 'var(--surface)'}" stroke="${on ? 'var(--live)' : 'var(--line)'}" stroke-width="${on ? 2.5 : 1}"/>` +
  (label ? `<text x="196" y="${y + 16.5}" text-anchor="start" direction="rtl" font-size="11.5" font-weight="700" fill="var(--ink)">${label}</text>` : `<rect x="110" y="${y + 9}" width="84" height="6" rx="3" fill="var(--line)"/>`);
const ART = {
  iosShare: art(`<rect x="20" y="62" width="200" height="44" rx="22" fill="var(--surface)" stroke="var(--line)"/><rect x="74" y="74" width="92" height="20" rx="10" fill="var(--bg)"/><rect x="92" y="81" width="56" height="6" rx="3" fill="var(--line)"/>
    ${RING(46, 84)}<g fill="var(--ink)"><circle cx="39" cy="84" r="2.4"/><circle cx="46" cy="84" r="2.4"/><circle cx="53" cy="84" r="2.4"/></g>
    <path d="M46 62V40h52" fill="none" stroke="var(--live)" stroke-width="2" stroke-dasharray="4 4"/><rect x="100" y="16" width="112" height="34" rx="10" fill="var(--surface)" stroke="var(--line)"/>${SHARE(190, 35)}<text x="174" y="38" text-anchor="start" direction="rtl" font-size="12.5" font-weight="700" fill="var(--ink)">שיתוף</text>`),
  iosRow: art(`<rect x="24" y="6" width="192" height="114" rx="14" fill="var(--bg)" stroke="var(--line)"/>${ROW(16, '')}${ROW(46, 'הוסף למסך הבית', true)}${ROW(76, '')}
    <g transform="translate(50 58)" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linecap="round"><rect x="-8" y="-8" width="16" height="16" rx="4"/><path d="M0 -4v8M-4 0h8"/></g>`),
  iosAdd: art(`<rect x="24" y="8" width="192" height="104" rx="14" fill="var(--surface)" stroke="var(--line)"/>${APP(180, 62)}<text x="154" y="59" text-anchor="start" direction="rtl" font-size="13" font-weight="700" fill="var(--ink)">זמן אמת</text><rect x="74" y="66" width="80" height="6" rx="3" fill="var(--line)"/>
    <rect x="34" y="18" width="58" height="26" rx="13" fill="var(--live-soft)" stroke="var(--live)" stroke-width="2.5"/><text x="63" y="35.5" text-anchor="middle" direction="rtl" font-size="12.5" font-weight="700" fill="var(--brand)">הוסף</text>`),
  andMenu: art(`<rect x="20" y="20" width="200" height="44" rx="12" fill="var(--surface)" stroke="var(--line)"/><rect x="68" y="32" width="136" height="20" rx="10" fill="var(--bg)"/><rect x="118" y="39" width="72" height="6" rx="3" fill="var(--line)"/>
    ${RING(44, 42)}<g fill="var(--ink)"><circle cx="44" cy="35" r="2.4"/><circle cx="44" cy="42" r="2.4"/><circle cx="44" cy="49" r="2.4"/></g>
    <rect x="20" y="76" width="200" height="8" rx="4" fill="var(--line)"/><rect x="60" y="94" width="160" height="8" rx="4" fill="var(--line)"/>`),
  andRow: art(`<rect x="24" y="6" width="192" height="114" rx="14" fill="var(--bg)" stroke="var(--line)"/>${ROW(16, '')}${ROW(46, 'הוספה למסך הבית', true)}${ROW(76, '')}
    <g transform="translate(50 58)" fill="none" stroke="var(--ink)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="-6" y="-9" width="12" height="18" rx="3"/><path d="M0 -3v6M-3 0h6"/></g>`),
  andAdd: art(`<rect x="24" y="8" width="192" height="104" rx="14" fill="var(--surface)" stroke="var(--line)"/>${APP(180, 44)}<text x="154" y="49" text-anchor="start" direction="rtl" font-size="13" font-weight="700" fill="var(--ink)">זמן אמת</text>
    <rect x="34" y="74" width="72" height="28" rx="14" fill="var(--live-soft)" stroke="var(--live)" stroke-width="2.5"/><text x="70" y="92.5" text-anchor="middle" direction="rtl" font-size="12.5" font-weight="700" fill="var(--brand)">התקנה</text><text x="150" y="92.5" text-anchor="middle" direction="rtl" font-size="12" fill="var(--muted)">ביטול</text>`),
  home: () => art(`<rect x="60" y="4" width="120" height="116" rx="16" fill="var(--night)"/>${[0, 1, 2].map(r => [0, 1, 2].map(c => (r === 1 && c === 1 ? RING(120, 62, 21) + APP(120, 62, .9) : `<rect x="${82 + c * 30}" y="${22 + r * 30}" width="20" height="20" rx="6" fill="rgba(255,255,255,.18)"/>`)).join('')).join('')}`),
};
const GUIDE = {
  ios: {
    label: 'אייפון',
    note: 'ב-Safari. הכפתורים יכולים להיראות קצת אחרת לפי גרסת האייפון.',
    steps: [
      [ART.iosShare, 'פותחים את תפריט השיתוף', 'לוחצים על שלוש הנקודות ⋯ ליד שורת הכתובת ואז על "שיתוף". בגרסאות קודמות כפתור השיתוף (ריבוע עם חץ למעלה) נמצא ישר בסרגל התחתון.'],
      [ART.iosRow, 'בוחרים "הוסף למסך הבית"', 'גוללים מטה ברשימה עד שמוצאים את האפשרות.'],
      [ART.iosAdd, 'לוחצים "הוסף"', 'הסמל של זמן אמת יופיע במסך הבית וייפתח כמו אפליקציה, במסך מלא.'],
    ],
  },
  android: {
    label: 'אנדרואיד',
    note: 'ב-Chrome. בדפדפנים אחרים האפשרות נמצאת בתפריט הראשי בשם דומה.',
    steps: [
      [ART.andMenu, 'פותחים את התפריט', 'לוחצים על שלוש הנקודות ⋮ בפינה העליונה של הדפדפן.'],
      [ART.andRow, 'בוחרים "הוספה למסך הבית"', 'לפעמים האפשרות נקראת "התקנת האפליקציה".'],
      [ART.andAdd, 'מאשרים ב"התקנה"', 'הסמל של זמן אמת יופיע במסך הבית וייפתח כמו אפליקציה, במסך מלא.'],
    ],
  },
};

function openInstallGuide() {
  if (document.querySelector('.guide')) return;
  let platform = isAndroid ? 'android' : 'ios';
  const close = () => { backdrop.remove(); box.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  const never = () => { a2hs.set({ ...a2hs.get(), never: true }); close(); };
  const body = el('div', { class: 'guide-body' });
  const tabs = el('div', { class: 'tabs', role: 'tablist' });
  const draw = () => {
    const g = GUIDE[platform];
    tabs.replaceChildren(...Object.entries(GUIDE).map(([key, v]) =>
      el('button', { class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(key === platform), onclick: () => { platform = key; draw(); } }, v.label)));
    body.replaceChildren(
      el('ol', { class: 'guide-steps' }, ...g.steps.map(([pic, title, text], i) =>
        el('li', {}, pic, el('div', {}, el('h3', {}, el('span', { class: 'num' }, String(i + 1)), title), el('p', {}, text))))),
      el('p', { class: 'guide-note' }, g.note));
  };
  const oneTap = el('button', { class: 'guide-btn primary one-tap', type: 'button', hidden: !installPrompt, onclick: async () => { const p = installPrompt; installPrompt = null; close(); p?.prompt(); } }, 'התקנה בלחיצה אחת');
  const backdrop = el('div', { class: 'sheet-backdrop', onclick: close });
  const box = el('section', { class: 'guide', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'guide-title' },
    el('div', { class: 'guide-head' },
      ART.home(),
      el('div', {}, el('h2', { id: 'guide-title' }, `${BRAND} במסך הבית`), el('p', {}, 'שלושה צעדים, והאתר נפתח כמו אפליקציה: סמל במסך הבית ומסך מלא.')),
      el('button', { class: 'icon-btn', type: 'button', 'aria-label': 'סגירה', onclick: close }, icon('x'))),
    tabs, body,
    el('div', { class: 'guide-actions' },
      oneTap,
      el('button', { class: 'guide-btn primary', type: 'button', onclick: close }, 'הבנתי'),
      el('button', { class: 'guide-btn', type: 'button', onclick: never }, 'אל תציג שוב')));
  draw();
  document.body.append(backdrop, box);
  document.addEventListener('keydown', onKey);
}

function maybeInstallGuide() {
  if (!(isIOS || isAndroid) || isInstalled()) return;
  const s = a2hs.get();
  if (s.never) return;
  let counted = false;
  try { counted = sessionStorage.getItem(A2HS) === '1'; sessionStorage.setItem(A2HS, '1'); } catch { /* private mode */ }
  if (counted) return; // a reload inside the same visit
  s.visits = (s.visits ?? 0) + 1;
  a2hs.set(s);
  if (s.visits % 3 === 1) openInstallGuide();
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
  document.body.dataset.screen = hash.startsWith('#/event/') ? 'event' : nav;
  const y = window.scrollY;
  app.replaceChildren(...[view].flat(Infinity).filter(Boolean));
  app.querySelector('.sections [aria-current]')?.scrollIntoView({ inline: 'center', block: 'nearest' });
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
maybeInstallGuide();
checkAppVersion();
setInterval(tick, REFRESH_MS);
setInterval(checkAppVersion, 10 * 60_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); checkAppVersion(); } });
window.addEventListener('pageshow', e => { if (e.persisted) tick(); });
window.addEventListener('online', tick);
window.addEventListener('focus', tick);
