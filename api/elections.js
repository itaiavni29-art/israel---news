// /elections-2026 — the elections section as a page of its own that search engines can read without running the app:
// the forecast, a table of every channel's latest poll per party with the average, and links to each report.
// The numbers are the ones the app shows (elections.json, made by src/elections.js).
import { dataFile, page, send, esc, safeUrl, time, SITE, BRAND } from './_lib.js';

const dayMonth = iso => { const [, m, d] = iso.split('-'); return `${+d}.${+m}`; };

export default async function handler(req, res) {
  const e = await dataFile('elections');
  const path = '/elections-2026';
  const title = 'סקרי הבחירות 2026: ממוצע כל הסקרים ותחזית מנדטים · ' + BRAND;
  if (!e || e.silence || !e.parties) {
    const why = e?.silence ? 'בימים שלפני הבחירות אסור על פי חוק לפרסם סקרים. הסקרים, הממוצע והתחזית יחזרו לכאן אחרי סגירת הקלפיות.' : 'הסקרים עוד לא נטענו. נסו שוב בעוד כמה דקות.';
    return send(res, 200, page({ title, description: 'סקרי המנדטים של ערוצי הטלוויזיה לקראת הבחירות לכנסת 2026: ממוצע ותחזית.', path,
      body: `<div class="page-bar"><h1>סקרי הבחירות 2026</h1></div><main class="screen"><div class="empty"><p>${esc(why)}</p></div></main>` }), { cache: 600 });
  }
  const parties = e.parties.filter(p => p.average > 0 || p.projected > 0).sort((a, b) => b.projected - a.projected || b.average - a.average);
  const [first, second] = parties;
  const channels = e.polls.map(p => p.name).join(', ').replace(/, ([^,]*)$/, ' ו$1');
  const updated = time(e.checkedAt ?? e.updatedAt);
  const description = `ממוצע סקרי המנדטים של ${channels} לקראת הבחירות לכנסת ב-27 באוקטובר 2026: ${first.name} ${first.projected}, ${second.name} ${second.projected}. טבלה לפי ערוץ ותחזית אוטומטית.`;
  const cell = (poll, p) => { const n = poll.seats[p.key] ?? 0; return n ? `<td>${n}</td>` : `<td class="under">${esc(poll.below?.[p.key] ?? '–')}</td>`; };

  const body = `<div class="page-bar"><h1>סקרי הבחירות 2026</h1><span>עודכן: <b>${updated}</b></span></div>
  <section class="forecast" aria-label="התחזית">
    <span class="forecast-label">התחזית של ${BRAND}</span>
    <p class="forecast-kicker">המפלגה הגדולה הצפויה</p>
    <div class="forecast-winner"><h2>${esc(first.name)}</h2><div class="forecast-seats" style="background:${esc(first.color)}"><b>${first.projected}</b><span>מנדטים</span></div></div>
    <ol class="forecast-next">${parties.slice(1, 4).map((p, i) => `<li><span class="place">${i + 2}</span><i style="background:${esc(p.color)}"></i><span class="name">${esc(p.name)}</span><b>${p.projected}</b></li>`).join('')}</ol>
    <p class="forecast-text">${esc(e.forecast?.text ?? '')}</p>
    <p class="forecast-note">התחזית מחושבת אוטומטית מהסקר האחרון של כל ערוץ ומנוסחת על ידי בינה מלאכותית. זו הערכה ולא תחזית מקצועית: סקרים עלולים לטעות.</p>
  </section>
  <main class="screen elections">
    <p class="standfirst">הבחירות לכנסת ה-26 יתקיימו ב-27 באוקטובר 2026. בעמוד הזה מרוכז סקר המנדטים האחרון של כל אחד מערוצי הטלוויזיה (${esc(channels)}), הממוצע של כל מפלגה ותחזית המנדטים של ${BRAND}. העמוד מתעדכן אוטומטית כמה פעמים ביום.</p>
    <h2 class="sub-head">כמה מנדטים נותן כל ערוץ: טבלת הסקרים</h2>
    <div class="table-wrap"><table class="polls-table">
      <thead><tr><th>מפלגה</th>${e.polls.map(p => `<th>${esc(p.name)}<small>${dayMonth(p.date)}</small></th>`).join('')}<th>ממוצע</th><th>תחזית</th></tr></thead>
      <tbody>${parties.map(p => `<tr><th><i style="background:${esc(p.color)}"></i>${esc(p.name)}</th>${e.polls.map(poll => cell(poll, p)).join('')}<td class="avg">${p.average}</td><td class="proj">${p.projected || '–'}</td></tr>`).join('')}</tbody>
    </table></div>
    <p class="ai-note">מספר בסוגריים או באחוזים: המפלגה מתחת לאחוז החסימה (3.25%) באותו סקר. הממוצע הוא ממוצע פשוט של הסקר האחרון מכל ערוץ; בתחזית נכללות רק מפלגות שעוברות את אחוז החסימה ברוב הסקרים.</p>
    <h2 class="sub-head">הסקרים שנכללו</h2>
    <ul class="source-list">${e.polls.map(p => `<li><span class="src-tag">${esc(p.name)}</span><a class="source-item" href="${esc(safeUrl(p.url ?? e.source.url))}" target="_blank" rel="noopener noreferrer"><h3>סקר המנדטים מ-${dayMonth(p.date)}</h3><span class="meta">${p.sample ? p.sample + ' משיבים · ' : ''}<b>לדיווח על הסקר ↗</b></span></a></li>`).join('')}</ul>
    <h2 class="sub-head">שאלות נפוצות</h2>
    <div class="faq">
      <h3>מתי הבחירות לכנסת?</h3><p>ביום שלישי, 27 באוקטובר 2026. הקלפיות נסגרות ב-22:00.</p>
      <h3>מי מובילה בסקרים?</h3><p>לפי ממוצע הסקרים האחרונים ${esc(first.name)} היא המפלגה הגדולה, עם ${first.projected} מנדטים בתחזית, ואחריה ${esc(second.name)} עם ${second.projected}.</p>
      <h3>מאיפה הנתונים?</h3><p>מסקרי המנדטים שפרסמו הערוצים, כפי שהם מרוכזים ב<a href="${esc(e.source.url)}" target="_blank" rel="noopener noreferrer">${esc(e.source.name)}</a>. לכל סקר יש קישור לדיווח המקורי.</p>
      <h3>עד מתי מתפרסמים סקרים?</h3><p>החוק אוסר לפרסם סקרים מיום שישי שלפני הבחירות ועד סגירת הקלפיות, ולכן בימים האלה העמוד לא יציג מספרים.</p>
    </div>
    <a class="list-link" href="/#/elections" style="border-top:1px solid var(--line);font-weight:700">לגרסה עם הגרפים באפליקציה ←</a>
    <a class="list-link" href="/" style="border-top:1px solid var(--line);font-weight:700">לחדשות של עכשיו ←</a>
  </main>`;

  send(res, 200, page({ title, description, path, body,
    jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: 'סקרי הבחירות 2026: ממוצע כל הסקרים ותחזית', description, inLanguage: 'he', url: SITE + path,
      dateModified: new Date(e.updatedAt).toISOString(), isPartOf: { '@type': 'WebSite', name: BRAND, url: SITE },
      about: { '@type': 'Event', name: 'הבחירות לכנסת ה-26', startDate: '2026-10-27', location: { '@type': 'Country', name: 'ישראל' } } } }), { cache: 1800 });
}
