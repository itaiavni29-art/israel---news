// Shared by the pages that are rendered on the server (event pages, section pages, sitemap).
// They read the archive the scanner publishes to the repository's `data` branch (src/archive.js).
export const SITE = 'https://zmanemetnews.co.il';
export const BRAND = 'זמן אמת';
const DATA = 'https://raw.githubusercontent.com/itaiavni29-art/israel---news/data/archive/';
export const CATEGORIES = { politics: 'פוליטיקה', security: 'ביטחון', economy: 'כלכלה', sport: 'ספורט', world: 'עולם', law: 'משפט ופלילים', society: 'חברה ובריאות', tech: 'טכנולוגיה' };

/** Another file the scanner publishes next to the archive (elections.json …). */
export async function dataFile(name) {
  const r = await fetch(DATA.replace(/archive\/$/, '') + name + '.json', { headers: { 'User-Agent': 'zmanemetnews.co.il' } });
  return r.ok ? r.json() : null;
}

export async function archive(name) {
  const r = await fetch(DATA + name + '.json', { headers: { 'User-Agent': 'zmanemetnews.co.il' } });
  if (!r.ok) return null;
  return r.json();
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const safeUrl = u => (/^https?:\/\//i.test(u) ? u : '#');
export const time = ms => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(ms);

/** A whole page in the app's look (it uses the app's own stylesheet). */
export function page({ title, description, path, body, jsonLd = null, noindex = false }) {
  return `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
${noindex ? '<meta name="robots" content="noindex">' : `<link rel="canonical" href="${SITE}${path}">`}
<meta property="og:type" content="article">
<meta property="og:site_name" content="${BRAND}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${SITE}${path}">
<meta property="og:image" content="${SITE}/icons/icon-512.png">
<meta property="og:locale" content="he_IL">
<meta name="theme-color" content="#1447d6">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;900&display=swap">
<link rel="stylesheet" href="/style.css">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, '\\u003c')}</script>` : ''}
</head>
<body data-screen="page">
<div class="shell" style="padding-bottom:32px">
  <header class="app-header" style="grid-template-columns:1fr"><a class="brand" href="/"><img class="brand-mark" src="/logo-mark-white.svg" alt="" width="26" height="26"><span class="brand-name">${BRAND}</span></a></header>
  <nav class="sections" aria-label="מדורים"><a href="/">ראשי</a><a href="/elections-2026"${path === '/elections-2026' ? ' aria-current="page"' : ''}>בחירות 2026</a>${Object.entries(CATEGORIES).map(([id, name]) => `<a href="/s/${id}"${path === '/s/' + id ? ' aria-current="page"' : ''}>${name}</a>`).join('')}</nav>
  ${body}
  <p class="footnote" style="padding:18px"><a href="/about">אודות ${BRAND}</a> · <a href="/">לעמוד הראשי של ${BRAND}: החדשות שמסוקרות עכשיו בכמה אתרים</a><br>האתר לא מעתיק כתבות: רק כותרות, קישורים לאתרים המקוריים וסיכום אוטומטי.</p>
</div>
</body>
</html>`;
}

export function send(res, status, html, { type = 'text/html; charset=utf-8', cache = 300 } = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', type);
  // the CDN keeps a page for a few minutes and may serve the old copy while it fetches a new one
  res.setHeader('Cache-Control', status === 200 ? `public, s-maxage=${cache}, stale-while-revalidate=86400` : 'public, s-maxage=60');
  res.end(html);
}

export const notFound = (res, what) => send(res, 404, page({ title: `${what} · ${BRAND}`, description: what, path: '/', noindex: true,
  body: `<main class="screen"><div class="empty"><p>${esc(what)}</p><p><a href="/">לחדשות של עכשיו</a></p></div></main>` }));
