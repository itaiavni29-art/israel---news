// /s/<section> and /latest — lists of recent events, each linking to its own page.
import { archive, page, send, notFound, esc, time, BRAND, CATEGORIES, SITE } from './_lib.js';

// what each section is about, in a sentence of our own
const ABOUT = {
  politics: 'הממשלה, הכנסת, המפלגות והבחירות',
  security: 'צה"ל, מערכת הביטחון, הגבולות והחזיתות',
  economy: 'שוק ההון, יוקר המחיה, העבודה והעסקים',
  sport: 'כדורגל, כדורסל והספורט הישראלי והעולמי',
  world: 'ארצות הברית, אירופה, המזרח התיכון ושאר העולם',
  law: 'בתי המשפט, המשטרה, הפרקליטות והחקירות',
  society: 'בריאות, חינוך, רווחה והחיים בישראל',
  tech: 'הייטק, סטארט-אפים, בינה מלאכותית וחדשנות',
};

export default async function handler(req, res) {
  const cat = new URL(req.url, SITE).searchParams.get('cat');
  if (cat && !CATEGORIES[cat]) return notFound(res, 'המדור לא נמצא');
  const index = await archive('index');
  const events = (index?.events ?? []).filter(e => !cat || e.category === cat).slice(0, 80); // the latest; the archive keeps the rest
  const name = cat ? CATEGORIES[cat] : 'האירועים האחרונים';
  const intro = cat
    ? `כל אירועי ה${esc(name)} שמסוקרים עכשיו באתרי החדשות בישראל: ${esc(ABOUT[cat] ?? name)}. כל 10 דקות נסרקים אתרי החדשות הגדולים, ואירוע שכמה אתרים מדווחים עליו מופיע כאן עם סיכום קצר, מספר האתרים שמסקרים אותו וקישורים לכתבות המקוריות.`
    : 'כל האירועים שזוהו לאחרונה באתרי החדשות בישראל, מהחדש לישן, עם סיכום קצר וקישורים לכתבות המקוריות.';
  const body = `<div class="page-bar"><h1>${cat ? 'חדשות ' + esc(name) : esc(name)}</h1><span>${events.length} אירועים</span></div>
  <main class="screen"><p class="standfirst">${intro}</p>
  ${cat ? `<p class="other-sections">מדורים נוספים: ${Object.entries(CATEGORIES).filter(([id]) => id !== cat).map(([id, n]) => `<a href="/s/${id}">${esc(n)}</a>`).join(' · ')} · <a href="/elections-2026">סקרי הבחירות 2026</a></p>` : ''}
  ${events.length ? `<ul class="stories">${events.map(e => `<li><a class="story" href="/e/${e.day}/${e.id}"><span class="copy">
      <span class="row"><span class="cat">${esc(CATEGORIES[e.category] ?? 'חדשות')}</span></span><h3>${esc(e.title)}</h3>
      <span class="meta">${time(e.at)} · ${e.sources === 1 ? 'מקור אחד' : e.sources + ' מקורות'}</span></span><span class="read-more">קרא עוד</span></a></li>`).join('')}</ul>`
    : '<div class="empty"><p>עדיין אין כאן אירועים.</p></div>'}</main>`;
  send(res, 200, page({
    title: cat ? `חדשות ${name}: מה מסוקר עכשיו בכמה אתרים · ${BRAND}` : `האירועים האחרונים · ${BRAND}`,
    description: cat ? `אירועי ${name} האחרונים שסוקרו באתרי החדשות בישראל, עם סיכום קצר וקישורים לכתבות המקוריות.` : 'האירועים האחרונים שסוקרו באתרי החדשות בישראל, עם סיכום קצר וקישורים לכתבות המקוריות.',
    path: cat ? `/s/${cat}` : '/latest', body,
  }));
}
