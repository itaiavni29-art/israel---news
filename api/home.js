// "/" — the app's page (public/app.html; on GitHub Pages the workflow copies it to index.html) with the latest events already in it, as real links to their own
// pages. Search engines get a full home page without running the app; people see the same list until the
// app starts and takes over (it replaces the contents of #app).
import fs from 'node:fs';
import path from 'node:path';
import { archive, send, esc, time, CATEGORIES } from './_lib.js';

let shell = null;
const readShell = () => (shell ??= fs.readFileSync(path.join(process.cwd(), 'public', 'app.html'), 'utf8'));

export default async function handler(req, res) {
  const index = await archive('index').catch(() => null);
  const events = (index?.events ?? []).slice(0, 24);
  const list = events.map(e => `<li><a class="story" href="/e/${e.day}/${e.id}"><span class="copy"><span class="row"><span class="cat">${esc(CATEGORIES[e.category] ?? 'חדשות')}</span></span><h3>${esc(e.title)}</h3>
      <span class="meta">${time(e.at)} · ${e.sources === 1 ? 'מקור אחד' : e.sources + ' מקורות'}</span></span><span class="read-more">קרא עוד</span></a></li>`).join('');
  const body = `<main class="screen">
        <h1 class="home-h1">זמן אמת חדשות – מה מסוקר עכשיו בכל אתרי החדשות</h1>
        <p class="standfirst">כל 10 דקות נסרקים אתרי החדשות הגדולים בישראל. אירוע שכמה אתרים מסקרים מופיע כאן עם סיכום קצר משלנו, רשימה של מי מדווח עליו וקישורים לכתבות המקוריות.</p>
        <p><a href="/elections-2026"><b>סקרי הבחירות 2026: ממוצע כל הסקרים ותחזית מנדטים ←</b></a></p>
        <nav class="home-sections" aria-label="מדורים">${Object.entries(CATEGORIES).map(([id, name]) => `<a href="/s/${id}">חדשות ${esc(name)}</a>`).join(' · ')} · <a href="/latest">כל האירועים האחרונים</a> · <a href="/about">אודות</a></nav>
        ${list ? `<h2 class="sub-head">האירועים של עכשיו</h2><ul class="stories">${list}</ul>` : ''}
      </main>`;
  const html = readShell().replace(/<div id="app">[\s\S]*?<\/div>\s*<\/div>/, `<div id="app">\n      ${body}\n    </div>\n  </div>`);
  send(res, 200, html, { cache: 120 });
}
