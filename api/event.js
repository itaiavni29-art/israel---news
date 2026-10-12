// /e/<day>/<id> — one event on a page of its own: headline, our summary, and links to the original articles.
import { archive, page, send, notFound, esc, safeUrl, time, SITE, BRAND, CATEGORIES } from './_lib.js';

export default async function handler(req, res) {
  const url = new URL(req.url, SITE), day = url.searchParams.get('day') ?? '', id = url.searchParams.get('id') ?? '';
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !/^[0-9a-f]{6,12}$/.test(id)) return notFound(res, 'הדף לא נמצא');
  const ev = (await archive(day))?.events?.[id];
  if (!ev) return notFound(res, 'האירוע כבר לא בארכיון');

  const sources = [...new Set(ev.articles.map(a => a.sourceName))];
  const names = sources.length < 2 ? sources.join('') : `${sources.slice(0, -1).join(', ')} ו${sources.at(-1)}`;
  const path = `/e/${day}/${id}`, cat = ev.category?.name ?? CATEGORIES[ev.category?.id] ?? 'חדשות';
  const bySource = new Map();
  for (const a of ev.articles) bySource.set(a.sourceName, [...(bySource.get(a.sourceName) ?? []), a]);

  const body = `<main class="screen article">
    <span class="row"><a class="cat" href="${ev.category?.id ? '/s/' + esc(ev.category.id) : '/'}" style="text-decoration:none">${esc(cat)}</a></span>
    <h1>${esc(ev.title)}</h1>
    <p class="standfirst">${ev.single ? `פורסם ב${esc(names)}.` : `סוקר ב-${sources.length} מקורות: ${esc(names)}.`}</p>
    <div class="meta-row"><span><b>${sources.length === 1 ? esc(names) : sources.length + ' מקורות'}</b> | <time datetime="${new Date(ev.detectedAt).toISOString()}">${time(ev.detectedAt)}</time></span><span>עודכן: ${time(ev.updatedAt)}</span></div>
    <section class="ai-summary" aria-label="סיכום אוטומטי">
      <span class="ai-label">${ev.single ? 'סיכום אוטומטי' : 'סיכום אוטומטי מכמה מקורות'}</span>
      <p class="body">${esc(ev.summary)}</p>
      <p class="ai-note">נכתב אוטומטית על ידי בינה מלאכותית מתוך הכותרות והתקצירים שפרסמו המקורות. ייתכנו אי־דיוקים — לפרטים המלאים פתחו את הכתבות המקוריות.</p>
    </section>
    <h2 class="sub-head">הכתבות המקוריות (${ev.articles.length})</h2>
    <ul class="source-list">${[...bySource].map(([name, list]) => `<li><span class="src-tag">${esc(name)}</span>${list.map(a =>
      `<a class="source-item" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer"><h3>${esc(a.title)}</h3><span class="meta">${a.publishedAt ? time(a.publishedAt) + ' · ' : ''}<b>לכתבה המלאה ↗</b></span></a>`).join('')}</li>`).join('')}</ul>
  </main>`;

  send(res, 200, page({
    title: `${ev.title} · ${BRAND}`, description: ev.summary, path, body,
    jsonLd: { '@context': 'https://schema.org', '@type': 'Article', headline: ev.title.slice(0, 110), description: ev.summary, inLanguage: 'he',
      datePublished: new Date(ev.detectedAt).toISOString(), dateModified: new Date(ev.updatedAt).toISOString(), mainEntityOfPage: SITE + path,
      author: { '@type': 'Organization', name: BRAND, url: SITE }, publisher: { '@type': 'Organization', name: BRAND, logo: { '@type': 'ImageObject', url: SITE + '/icons/icon-512.png' } },
      citation: ev.articles.map(a => a.link) },
  }));
}
