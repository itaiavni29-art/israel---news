// /sitemap.xml — the home page, the sections and every event page in the archive.
import { archive, send, SITE, CATEGORIES } from './_lib.js';

export default async function handler(req, res) {
  const index = await archive('index');
  const url = (loc, lastmod, freq) => `<url><loc>${SITE}${loc}</loc>${lastmod ? `<lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}${freq ? `<changefreq>${freq}</changefreq>` : ''}</url>`;
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${[
    url('/', null, 'always'), url('/elections-2026', null, 'hourly'), url('/latest', index?.generatedAt, 'hourly'),
    ...Object.keys(CATEGORIES).map(c => url('/s/' + c, null, 'hourly')),
    ...(index?.events ?? []).map(e => url(`/e/${e.day}/${e.id}`, e.updatedAt ?? e.at)),
  ].join('\n')}\n</urlset>\n`;
  send(res, 200, xml, { type: 'application/xml; charset=utf-8', cache: 600 });
}
