// Fast unit tests (no network, no model): dates, cleaning, filters, parsing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDate } from '../src/dates.js';
import { cleanTitle } from '../src/text.js';
import { buildFilter } from '../src/filters.js';
import { parseFeed, articleKey } from '../src/feeds.js';
import { loadConfig } from '../src/config.js';

const config = loadConfig();
const src = id => config.sources.find(s => s.id === id);
const NOW = Date.parse('2026-09-28T18:10:00Z');

test('dates: real GMT, +0300 and "GMT that is really Israel time" all normalize to UTC', () => {
  // Maariv / Israel Hayom / Globes: genuine GMT
  assert.equal(normalizeDate('Mon, 28 Sep 2026 16:48:06 GMT', { now: NOW }), Date.parse('2026-09-28T16:48:06Z'));
  // ynet / Haaretz: explicit +0300
  assert.equal(normalizeDate('Mon, 28 Sep 2026 20:35:12 +0300', { now: NOW }), Date.parse('2026-09-28T17:35:12Z'));
  // Walla: "19:20 GMT" in the feed is 19:20+03:00 on the article page (summer time)
  assert.equal(normalizeDate('Mon, 28 Sep 2026 19:20:00 GMT', { labelIsLocalTime: true, now: NOW }), Date.parse('2026-09-28T16:20:00Z'));
  // Winter time: Israel is UTC+2 in January
  assert.equal(normalizeDate('Thu, 15 Jan 2026 10:00:00 GMT', { labelIsLocalTime: true, now: NOW }), Date.parse('2026-01-15T08:00:00Z'));
});

test('dates: future timestamps are clamped to now, garbage is rejected', () => {
  assert.equal(normalizeDate('Mon, 28 Sep 2026 23:37:46 GMT', { now: NOW }), NOW);
  assert.equal(normalizeDate('not a date', { now: NOW }), null);
  assert.equal(normalizeDate('', { now: NOW }), null);
});

test('cleanTitle strips clickbait markers and punctuation, keeps acronyms', () => {
  assert.equal(cleanTitle('"ניסיון לינץ\' מתוכנן": נהג אוטובוס הותקף בירושלים | צפו בתיעוד'), 'ניסיון לינץ מתוכנן נהג אוטובוס הותקף בירושלים');
  assert.equal(cleanTitle('בלעדי: צה"ל נערך לאפשרות חטיפה'), 'צה"ל נערך לאפשרות חטיפה');
  assert.equal(cleanTitle('נשים, נהרו להצביע!'), 'נשים נהרו להצביע');
  assert.equal(cleanTitle('איחוד &quot;הכוחות&quot; &amp; עוד'), 'איחוד הכוחות & עוד');
});

test('filters: Walla sponsored lawyer ads and non-news sections are dropped', () => {
  const reject = buildFilter(src('walla'), config.globalFilters);
  assert.equal(reject({ title: 'עו"ד שרון נהרי, עו"ד פלילי', link: 'https://news.walla.co.il/item/3870015' }), 'excluded-title');
  assert.equal(reject({ title: 'רוד סטיוארט נפרד', link: 'https://e.walla.co.il/item/3870132' }), 'non-news-section');
  assert.equal(reject({ title: 'חידון הבחירות של וואלה', link: 'https://news.walla.co.il/item/3861803' }), 'excluded-title');
  assert.equal(reject({ title: 'משרד האוצר מתנגד לעסקת צים', link: 'https://finance.walla.co.il/item/3870139' }), null);
});

test('filters: Israel Hayom keeps news, drops sport / lifestyle / food', () => {
  const reject = buildFilter(src('israelhayom'), config.globalFilters);
  assert.equal(reject({ title: 'x', link: 'https://www.israelhayom.co.il/news/politics/article/1' }), null);
  assert.equal(reject({ title: 'x', link: 'https://www.israelhayom.co.il/sport/world-soccer/article/1' }), 'non-news-section');
  assert.equal(reject({ title: 'x', link: 'https://www.israelhayom.co.il/food/recipes/article/1' }), 'non-news-section');
  assert.equal(reject({ title: 'x', link: 'https://www.israelhayom.co.il/lifestyle/beauty/article/1' }), 'non-news-section');
});

test('filters: "בשיתוף" inside a real headline is not treated as sponsored', () => {
  const reject = buildFilter(src('maariv'), config.globalFilters);
  assert.equal(reject({ title: 'מנחת מטוסים חדש בירושלים של ארגון "הצלה אייר" בשיתוף מד"א', link: 'https://www.maariv.co.il/news/health/article-1' }), null);
  assert.equal(reject({ title: 'בשיתוף מותג: כך תחסכו', link: 'https://www.maariv.co.il/news/health/article-2' }), 'excluded-title');
});

test('parseFeed reads CDATA, entities, local-time dates and the teaser; saved state never contains teasers', async () => {
  const xml = `<?xml version="1.0" encoding="utf-8"?><rss><channel>
    <item><title><![CDATA[נתניהו &quot;טוען&quot;]]></title><link>https://news.walla.co.il/item/1</link>
      <pubDate>Mon, 28 Sep 2026 19:20:00 GMT</pubDate><description>short teaser text from the site</description></item>
  </channel></rss>`;
  const [it] = parseFeed(xml, src('walla'), { now: NOW });
  assert.deepEqual(Object.keys(it).sort(), ['link', 'publishedAt', 'teaser', 'title']);
  assert.equal(it.teaser, 'short teaser text from the site');
  const { FeedFetcher } = await import('../src/feeds.js');
  const f = new FeedFetcher(config, { error() {} });
  f.state.set('u', { items: [it], etag: 'e' });
  const saved = JSON.parse(JSON.stringify(f.toJSON()));
  assert.equal(saved.u.items[0].teaser, undefined); // the saved state is public
  f.load(saved);
  assert.equal(f.state.get('u').etag, undefined);   // → next request downloads the feed in full again
  assert.equal(it.title, 'נתניהו "טוען"');
  assert.equal(it.publishedAt, Date.parse('2026-09-28T16:20:00Z'));
  assert.throws(() => parseFeed('<html><body>blocked</body></html>', src('ynet')));
});

test('articleKey keeps Globes ?did= ids distinct and drops tracking params', () => {
  const a = articleKey('https://www.globes.co.il/news/article.aspx?did=1001524950');
  const b = articleKey('https://www.globes.co.il/news/article.aspx?did=1001524951');
  assert.notEqual(a, b);
  assert.equal(articleKey('https://www.ynet.co.il/news/article/abc?utm_source=rss'), articleKey('https://ynet.co.il/news/article/abc/'));
});

test('config: defaults and validation', () => {
  assert.equal(config.minSources, 2);
  assert.ok(config.similarityThreshold > 0 && config.similarityThreshold < 1);
  assert.ok(config.scanIntervalMinutes >= 1);
  assert.equal(config.maxEvents, 10);
});

test('lexical guard: shared names count, shared common words do not', async () => {
  const { LexicalIndex } = await import('../src/lexical.js');
  const pool = [
    'ישר מסמנת את שוק השכירות: נגדיל את היצע הההשכרה לטווח ארוך',
    'על רקע עסקת אלטשולר שחם: רשות שוק ההון באזהרה חריפה לסוכני ביטוח',
    'רשות שוק ההון מזהירה את אלטשולר שחם',
    ...Array.from({ length: 60 }, (_, i) => `כותרת כללית מספר ${i} על שוק המניות והכלכלה`),
  ];
  const lex = new LexicalIndex(pool);
  assert.equal(lex.sharesRareWord(pool[0], pool[1]), false); // only "שוק" in common — the real false merge
  assert.equal(lex.sharesRareWord(pool[1], pool[2]), true);  // "אלטשולר" — same story
});

test('archive: events with a summary get a page entry; old days are dropped', async () => {
  const { updateArchive, dayOf, shortId } = await import('../src/archive.js');
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-'));
  const now = Date.now(), ev = (id, at, summary) => ({ id, detectedAt: at, title: 'כותרת ' + id, sourceCount: 2, singleSource: false, category: { id: 'economy', name: 'כלכלה' },
    summary: summary ? { text: summary } : null, articles: [{ sourceName: 'ynet', title: 'א', link: 'https://example.com/a', publishedAt: at }] });
  updateArchive(dir, [ev('aaaaaaaa-1111-2222-3333-444444444444', now, 'סיכום'), ev('bbbbbbbb-1111-2222-3333-444444444444', now, null)], now);
  const index = JSON.parse(fs.readFileSync(path.join(dir, 'archive/index.json'), 'utf8'));
  assert.equal(index.events.length, 1);                       // the one without a summary has no page
  assert.equal(index.events[0].id, shortId('aaaaaaaa-1111-2222-3333-444444444444'));
  const day = JSON.parse(fs.readFileSync(path.join(dir, 'archive', dayOf(now) + '.json'), 'utf8'));
  assert.equal(day.events[index.events[0].id].summary, 'סיכום');
  updateArchive(dir, [], now + 40 * 86400_000);               // a month later the page is still there (pages stay up for a year)
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'archive/index.json'), 'utf8')).events.length, 1);
  updateArchive(dir, [], now + 400 * 86400_000);              // after more than a year the day file and its entry are gone
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'archive/index.json'), 'utf8')).events.length, 0);
  assert.equal(fs.existsSync(path.join(dir, 'archive', dayOf(now) + '.json')), false);
  fs.rmSync(dir, { recursive: true });
});

test('breaking headlines lose "watch the video" cues, and only those', async () => {
  const { withoutMediaCues: w } = await import('../src/text.js');
  assert.equal(w('גשם ראשון באילת, רעמים - וחשש משיטפונות בדרום | תיעוד'), 'גשם ראשון באילת, רעמים - וחשש משיטפונות בדרום');
  assert.equal(w('צה"ל חיסל מפקד פלוגה | צפו ברגע החיסול'), 'צה"ל חיסל מפקד פלוגה');
  assert.equal(w('צפו בתיעוד: השריפה הגדולה בחיפה'), 'השריפה הגדולה בחיפה');
  assert.equal(w('השריפה בכרמל (וידאו)'), 'השריפה בכרמל');
  assert.equal(w('דיווח: וויטקוף וקושנר צפויים להגיע לרוסיה'), 'דיווח: וויטקוף וקושנר צפויים להגיע לרוסיה');
  assert.equal(w('נתניהו - צפוי לנאום הערב'), 'נתניהו - צפוי לנאום הערב');
  assert.equal(w('תיעוד'), 'תיעוד', 'nothing would be left: keep the original');
});
