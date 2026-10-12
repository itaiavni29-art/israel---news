// /s/<section> and /latest — lists of recent events, each linking to its own page.
import { archive, page, send, notFound, esc, time, BRAND, CATEGORIES, SITE } from './_lib.js';

export default async function handler(req, res) {
  const cat = new URL(req.url, SITE).searchParams.get('cat');
  if (cat && !CATEGORIES[cat]) return notFound(res, 'המדור לא נמצא');
  const index = await archive('index');
  const events = (index?.events ?? []).filter(e => !cat || e.category === cat).slice(0, 80);
  const name = cat ? CATEGORIES[cat] : 'האירועים האחרונים';
  const body = `<div class="page-bar"><h1>${esc(name)}</h1></div>
  <main class="screen">${events.length ? `<ul class="stories">${events.map(e => `<li><a class="story" href="/e/${e.day}/${e.id}"><span class="copy">
      <span class="row"><span class="cat">${esc(CATEGORIES[e.category] ?? 'חדשות')}</span></span><h3>${esc(e.title)}</h3>
      <span class="meta">${time(e.at)} · ${e.sources === 1 ? 'מקור אחד' : e.sources + ' מקורות'}</span></span><span class="read-more">קרא עוד</span></a></li>`).join('')}</ul>`
    : '<div class="empty"><p>עדיין אין כאן אירועים.</p></div>'}</main>`;
  send(res, 200, page({
    title: cat ? `חדשות ${name}: מה מסוקר עכשיו בכמה אתרים · ${BRAND}` : `האירועים האחרונים · ${BRAND}`,
    description: cat ? `אירועי ${name} האחרונים שסוקרו באתרי החדשות בישראל, עם סיכום קצר וקישורים לכתבות המקוריות.` : 'האירועים האחרונים שסוקרו באתרי החדשות בישראל, עם סיכום קצר וקישורים לכתבות המקוריות.',
    path: cat ? `/s/${cat}` : '/latest', body,
  }));
}
