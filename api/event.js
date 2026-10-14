// /e/<day>/<id> — one event on a page of its own: headline, our summary, and links to the original articles.
import { archive, page, send, notFound, esc, safeUrl, time, SITE, BRAND, CATEGORIES } from './_lib.js';

export default async function handler(req, res) {
  const url = new URL(req.url, SITE), day = url.searchParams.get('day') ?? '', id = url.searchParams.get('id') ?? '';
  if (!/^\d{4}-\d\d-\d\d$/.test(day) || !/^[0-9a-f]{6,12}$/.test(id)) return notFound(res, 'הדף לא נמצא');
  const [dayFile, index] = await Promise.all([archive(day), archive('index')]);
  const ev = dayFile?.events?.[id];
  if (!ev) return notFound(res, 'האירוע כבר לא בארכיון');

  const sources = [...new Set(ev.articles.map(a => a.sourceName))];
  const more = (index?.events ?? []).filter(e => !(e.day === day && e.id === id)).slice(0, 6);
  const names = sources.length < 2 ? sources.join('') : `${sources.slice(0, -1).join(', ')} ו${sources.at(-1)}`;
  const path = `/e/${day}/${id}`, cat = ev.category?.name ?? CATEGORIES[ev.category?.id] ?? 'חדשות';
  // who reported first, and when each site joined: something only we can tell
  const firsts = [...new Map([...ev.articles].filter(a => a.publishedAt).sort((a, b) => a.publishedAt - b.publishedAt).map(a => [a.sourceName, a])).values()];
  const hm = ms => new Intl.DateTimeFormat('he-IL', { timeZone: 'Asia/Jerusalem', hour: '2-digit', minute: '2-digit' }).format(ms);
  const timeline = firsts.length > 1 ? `<h2 class="sub-head">איך התפתח הסיקור</h2>
    <p>הראשון לדווח היה ${esc(firsts[0].sourceName)}, ב-${hm(firsts[0].publishedAt)}. ${firsts.slice(1).map(a => `${esc(a.sourceName)} הצטרף ב-${hm(a.publishedAt)}`).join(', ')}.
    בסך הכול ${sources.length} אתרים פרסמו ${ev.articles.length === 1 ? 'כתבה אחת' : ev.articles.length + ' כתבות'} על האירוע.</p>` : '';
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
    ${timeline}
    <h2 class="sub-head">הכתבות המקוריות (${ev.articles.length})</h2>
    <ul class="source-list">${[...bySource].map(([name, list]) => `<li><span class="src-tag">${esc(name)}</span>${list.map(a =>
      `<a class="source-item" href="${esc(safeUrl(a.link))}" target="_blank" rel="noopener noreferrer"><span class="headline">${esc(a.title)}</span><span class="meta">${a.publishedAt ? time(a.publishedAt) + ' · ' : ''}<b>לכתבה המלאה ↗</b></span></a>`).join('')}</li>`).join('')}</ul>
    ${more.length ? `<h2 class="sub-head">עוד אירועים</h2>
    <ul class="stories">${more.map(e => `<li><a class="story" href="/e/${e.day}/${e.id}"><span class="copy"><span class="row"><span class="cat">${esc(CATEGORIES[e.category] ?? 'חדשות')}</span></span><h3>${esc(e.title)}</h3>
      <span class="meta">${time(e.at)} · ${e.sources === 1 ? 'מקור אחד' : e.sources + ' מקורות'}</span></span><span class="read-more">קרא עוד</span></a></li>`).join('')}</ul>` : ''}
    <a class="list-link" href="/#/elections" style="border-top:1px solid var(--line);font-weight:700">בחירות 2026: הסקרים והתחזית ←</a>
    <a class="list-link" href="/" style="border-top:1px solid var(--line);font-weight:700">לכל החדשות של עכשיו ←</a>
  </main>`;

  send(res, 200, page({
    title: `${ev.title} · ${BRAND}`, description: ev.summary, path, body,
    jsonLd: [{ '@context': 'https://schema.org', '@type': 'NewsArticle', headline: ev.title.slice(0, 110), image: [SITE + '/icons/icon-512.png'], description: ev.summary, inLanguage: 'he',
      datePublished: new Date(ev.detectedAt).toISOString(), dateModified: new Date(ev.updatedAt).toISOString(), mainEntityOfPage: SITE + path,
      author: { '@type': 'Organization', name: BRAND, url: SITE }, publisher: { '@type': 'Organization', name: BRAND, logo: { '@type': 'ImageObject', url: SITE + '/icons/icon-512.png' } },
      citation: ev.articles.map(a => a.link) },
      { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
        { '@type': 'ListItem', position: 1, name: BRAND, item: SITE + '/' },
        ...(ev.category?.id ? [{ '@type': 'ListItem', position: 2, name: cat, item: SITE + '/s/' + ev.category.id }] : []),
        { '@type': 'ListItem', position: ev.category?.id ? 3 : 2, name: ev.title.slice(0, 110), item: SITE + path }] }],
  }));
}
