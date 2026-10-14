// /news-sitemap.xml — a Google News sitemap: the event pages of the last two days, with their headlines
// (Google News reads only the last 48 hours of a news sitemap).
import { archive, send, SITE, BRAND } from './_lib.js';

const xmlEsc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

export default async function handler(req, res) {
  const index = await archive('index');
  const since = Date.now() - 48 * 3600_000;
  const urls = (index?.events ?? []).filter(e => e.at >= since).slice(0, 1000).map(e => `<url><loc>${SITE}/e/${e.day}/${e.id}</loc><news:news>
<news:publication><news:name>${BRAND}</news:name><news:language>he</news:language></news:publication>
<news:publication_date>${new Date(e.at).toISOString()}</news:publication_date><news:title>${xmlEsc(e.title)}</news:title></news:news></url>`);
  send(res, 200, `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:news="http://www.google.com/schemas/sitemap-news/0.9">\n${urls.join('\n')}\n</urlset>\n`,
    { type: 'application/xml; charset=utf-8', cache: 600 });
}
