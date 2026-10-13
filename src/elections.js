// "בחירות 2026": the TV channels' seat polls, an average per party and a forecast.
//
// The numbers come from Wikipedia's table of polls ("Opinion polling for the 2026 Israeli legislative election"),
// read through the MediaWiki API — an open, structured source that volunteers update daily and that cites every
// channel's own report. We never fetch the channels' pages. Published as <publishDir>/elections.json:
//   polls     the latest poll of each channel (seats per party, date, link to the channel's report)
//   parties   name, colour, whether it is in the outgoing government, average seats, projected seats
//   forecast  blocs against the 61 needed, and a short text written by the model from these numbers only
// Israeli law (חוק הבחירות (דרכי תעמולה), 16ה) forbids publishing polls from the Friday before election day
// until the polls close: during that window the file carries no numbers at all.
import fs from 'node:fs';
import path from 'node:path';
import { spellingProblem } from './summarizer.js';

const API = 'https://en.wikipedia.org/w/api.php';
const UA = 'zman-emet-news/1.0 (https://zmanemetnews.co.il; headline aggregator; reads the polls table a few times a day)';
export const DEFAULTS = {
  page: 'Opinion polling for the 2026 Israeli legislative election',
  section: '2026',
  electionDay: '2026-10-27',
  silenceFrom: '2026-10-23T00:00:00+03:00', // the Friday before election day
  silenceUntil: '2026-10-27T22:00:00+02:00', // the polls close
  refreshHours: 3,
  maxPollAgeDays: 21,
};
// The publishers the page follows. `match` is tested against the publisher cell of the table.
export const CHANNELS = [
  { id: 'n12', name: 'חדשות 12', match: /HaHadashot 12|Channel 12/i },
  { id: 'reshet13', name: 'רשת 13', match: /Channel 13/i },
  { id: 'kan11', name: 'כאן 11', match: /\bKan 11\b|\[\[Kan\b|Kan News/i },
  { id: 'ch14', name: 'ערוץ 14', match: /Channel 14/i },
  { id: 'i24', name: 'i24NEWS', match: /i24/i },
];
// Hebrew names and colours of the parties we are sure of; anything else is looked up on Wikipedia (langlinks).
const KNOWN = {
  'Likud': ['הליכוד', '#1f5aa5'], 'Religious Zionist Party': ['הציונות הדתית', '#0e7c7b'], 'Zehut': ['זהות', '#0e7c7b'],
  'Otzma Yehudit': ['עוצמה יהודית', '#f0a202'], 'Blue and White (political party)': ['כחול לבן', '#3aa0e6'], 'Shas': ['ש"ס', '#1a1a1a'],
  'United Torah Judaism': ['יהדות התורה', '#4a4e69'], 'Yisrael Beiteinu': ['ישראל ביתנו', '#0b6fa4'], "Ra'am": ['רע"ם', '#2a9d4b'],
  'Joint List': ['הרשימה המשותפת', '#c0392b'], 'The Democrats (Israel)': ['הדמוקרטים', '#e63946'],
  'The Reservists (political party)': ['המילואימניקים', '#5b7c3a'], 'New Economic Party': ['הכלכלית החדשה', '#5b7c3a'],
};
const PALETTE = ['#7b2cbf', '#d4a100', '#00838f', '#c2185b', '#5d6470', '#8d5524', '#3d5a80'];
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// ---------- wikitext ----------
/** Remove every {{name|…}} template (nested braces included). */
function dropTemplate(text, name) {
  const re = new RegExp('\\{\\{\\s*' + name + '\\s*[|}]', 'i');
  for (let m; (m = re.exec(text));) {
    let depth = 0, i = m.index;
    for (; i < text.length; i++) { if (text.startsWith('{{', i)) { depth++; i++; } else if (text.startsWith('}}', i)) { depth--; i++; if (!depth) break; } }
    text = text.slice(0, m.index) + text.slice(i + 1);
  }
  return text;
}
const noRefs = s => dropTemplate(s.replace(/<ref[^>]*\/>/g, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, ''), 'efn');
const plain = s => noRefs(s).replace(/\{\{\s*small\s*\|([^{}]*)\}\}/gi, '$1').replace(/\{\{[^{}]*\}\}/g, '').replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
  .replace(/'{2,}/g, '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').trim();
/** "attrs | content" → { attrs, content }; a cell without attributes has attrs ''. */
function splitCell(raw) {
  const m = /^([^|[\]{}<]*=[^|[\]{}<]*)\|(?!\|)([\s\S]*)$/.exec(raw);
  return m ? { attrs: m[1], content: m[2].trim() } : { attrs: '', content: raw.trim() };
}
const span = attrs => +(/colspan\s*=\s*"?(\d+)/i.exec(attrs)?.[1] ?? 1);
const cellsOf = (row, mark) => ('\n' + row).split(new RegExp('\\n\\' + mark)).slice(1).map(splitCell);

/**
 * The seat-projection table of one year → { columns, polls }.
 * columns: [{ key, titles, span, gov }] — the parties, in the table's order.
 * polls: [{ date, firm, publisher, url, sample, seats: {key: n}, below: {key: '(1.9%)'}, total }] newest first.
 */
export function parsePolls(wikitext, section = '2026') {
  const from = wikitext.indexOf('== Seat projections');
  const start = wikitext.indexOf(`=== ${section} ===`, Math.max(0, from));
  if (start < 0) throw new Error(`section "${section}" not found`);
  const open = wikitext.indexOf('{|', start), close = wikitext.indexOf('\n|}', open);
  if (open < 0 || close < 0) throw new Error('polls table not found');
  const rows = wikitext.slice(open, close).split(/\n\|-[^\n]*/);

  // header: Fieldwork date · Polling firm · Publisher · Sample size · the parties… · Others · Gov.
  const head = cellsOf(rows[0], '!'), columns = [];
  const first = head.findIndex(c => /Sample/i.test(c.content));
  if (first < 0) throw new Error('unexpected table header');
  for (const c of head.slice(first + 1)) {
    if (/^Others\b/i.test(plain(c.content))) break;
    const titles = [...noRefs(c.content).matchAll(/\[\[([^\]|]+)/g)].map(m => m[1].trim());
    if (!titles.length) throw new Error('party column without a link: ' + c.content.slice(0, 60));
    columns.push({ key: titles[0], titles, span: span(c.attrs), gov: /D9D9F8/i.test(c.attrs) });
  }
  const width = columns.reduce((n, c) => n + c.span, 0);
  const at = pos => { let p = 0; for (const c of columns) { if (pos < p + c.span) return c; p += c.span; } return null; };

  const polls = [];
  for (const row of rows.slice(2)) {
    const cells = cellsOf(row, '|');
    if (cells.length < 8) continue; // a note that spans the table (an event, a deadline)
    const d = /\{\{\s*Opdrts\s*\|\s*(\d*)\s*\|\s*(\d+)\s*\|\s*(\w+)\s*\|\s*(\d{4})/i.exec(cells[0].content);
    if (!d || !(d[3].slice(0, 3).toLowerCase() in MONTHS)) continue;
    const date = new Date(Date.UTC(+d[4], MONTHS[d[3].slice(0, 3).toLowerCase()], +d[2])).toISOString().slice(0, 10);
    const poll = { date, firm: plain(cells[1].content), publisher: plain(cells[2].content), publisherRaw: cells[2].content,
      url: /\burl\s*=\s*(https?:\/\/[^\s|}]+)/.exec(cells[2].content)?.[1] ?? null, sample: +plain(cells[3].content).replace(/\D/g, '') || null, seats: {}, below: {}, total: 0 };
    let pos = 0, ok = true;
    for (const c of cells.slice(4)) {
      if (pos >= width) break;
      const col = at(pos), text = plain(c.content); pos += span(c.attrs);
      if (/^\d{1,3}$/.test(text)) { poll.seats[col.key] = (poll.seats[col.key] ?? 0) + +text; poll.total += +text; }
      else if (/[\d<]/.test(text) && /[(%]/.test(text)) { poll.seats[col.key] ??= 0; poll.below[col.key] = text; } // under the threshold: "(1.9%)"
      else if (/^[–—-]?$/.test(text)) poll.seats[col.key] ??= 0;                                                    // not polled / no details
      else ok = false;
    }
    if (ok && pos >= width) polls.push(poll);
  }
  return { columns, polls };
}

// ---------- numbers ----------
/** Largest-remainder rounding of weights to whole seats that add up to `total`. */
export function allocate(weights, total = 120) {
  const sum = Object.values(weights).reduce((a, b) => a + b, 0);
  if (!sum) return {};
  const exact = Object.entries(weights).map(([k, w]) => [k, w * total / sum]);
  const out = Object.fromEntries(exact.map(([k, x]) => [k, Math.floor(x)]));
  let left = total - Object.values(out).reduce((a, b) => a + b, 0);
  for (const [k] of exact.sort((a, b) => (b[1] % 1) - (a[1] % 1))) { if (left-- <= 0) break; out[k]++; }
  return out;
}

/**
 * @param {{columns: object[], polls: object[]}} table
 * @param {object} names {key: hebrewName}
 */
export function summarize(table, names = {}, { now = Date.now(), maxPollAgeDays = 21 } = {}) {
  const oldest = new Date(now - maxPollAgeDays * 86400_000).toISOString().slice(0, 10);
  const polls = [];
  for (const ch of CHANNELS) {
    const p = table.polls.find(p => ch.match.test(p.publisherRaw) && p.total === 120 && p.date >= oldest);
    if (p) polls.push({ channel: ch.id, name: ch.name, date: p.date, firm: p.firm, sample: p.sample, url: p.url, seats: p.seats, below: p.below });
  }
  let spare = 0;
  const parties = table.columns.map(c => {
    const values = polls.map(p => p.seats[c.key] ?? 0), passed = values.filter(v => v > 0).length;
    const [knownName, knownColor] = KNOWN[c.key] ?? [];
    const name = c.titles.map(t => KNOWN[t]?.[0] ?? names[t] ?? t.replace(/\s*\(.*\)$/, '')).join('–');
    return { key: c.key, name, color: knownColor ?? PALETTE[spare++ % PALETTE.length], gov: c.gov,
      average: values.length ? +(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1) : 0,
      // passes the threshold in the forecast only if most of the channels' polls give it seats
      passes: values.length > 0 && passed * 2 > values.length,
      meanWhenIn: passed ? values.reduce((a, b) => a + b, 0) / passed : 0 };
  });
  const projected = allocate(Object.fromEntries(parties.filter(p => p.passes).map(p => [p.key, p.meanWhenIn])));
  for (const p of parties) { p.projected = projected[p.key] ?? 0; delete p.meanWhenIn; }
  const sum = f => parties.filter(f).reduce((n, p) => n + p.projected, 0);
  const leader = [...parties].sort((a, b) => b.projected - a.projected)[0];
  const blocs = { government: sum(p => p.gov), others: sum(p => !p.gov), needed: 61 };
  return { polls, parties, blocs, leader: leader ? { key: leader.key, name: leader.name, seats: leader.projected } : null };
}

// ---------- the forecast text ----------
const PROMPT = `אתה פרשן סקרים זהיר. לפניך ממוצע של סקרי המנדטים האחרונים שפרסמו ערוצי הטלוויזיה בישראל לקראת הבחירות לכנסת.
כתוב תחזית קצרה בעברית: 3 עד 4 משפטים, עד 80 מילים.
כללים:
- השתמש רק במספרים ובשמות שמופיעים בנתונים שלמטה. אל תוסיף מספרים, שמות של אנשים, סיבות או אירועים.
- ציין איזו מפלגה צפויה להיות הגדולה, כמה מנדטים מקבלות מפלגות הממשלה היוצאת וכמה שאר המפלגות, ומה זה אומר ביחס ל-61 המנדטים הדרושים לרוב.
- הדגש שזו הערכה לפי סקרים בלבד, שסקרים עלולים לטעות ושמפלגות קרובות לאחוז החסימה יכולות לשנות את התמונה.
- כתוב בניסוח ניטרלי, בלי לתמוך באף צד. בלי כותרת, בלי רשימות ובלי הדגשות.`;

export function fallbackText({ leader, blocs }) {
  const g = blocs.government, o = blocs.others;
  const verdict = g >= 61 ? `למפלגות הממשלה היוצאת יש רוב של ${g} מנדטים` : o >= 61 ? `מפלגות הממשלה היוצאת מקבלות ${g} מנדטים, פחות מ-61 הדרושים לרוב, ושאר המפלגות מקבלות יחד ${o}` : `אף צד לא מגיע ל-61 מנדטים (${g} מול ${o})`;
  return `לפי ממוצע הסקרים האחרונים, המפלגה הגדולה צפויה להיות ${leader.name}, עם ${leader.seats} מנדטים. ${verdict}. זו הערכה לפי סקרים בלבד: סקרים עלולים לטעות, ומפלגות שקרובות לאחוז החסימה יכולות לשנות את התמונה.`;
}
/** The model's text is accepted only if it is clean Hebrew and every number in it comes from the data. */
export function checkForecast(text, summary) {
  const words = text.split(/\s+/).length;
  if (words < 20 || words > 110) return 'length';
  if (spellingProblem(text)) return 'spelling';
  const allowed = new Set([61, 120, 3.25, summary.blocs.government, summary.blocs.others, summary.polls.length, ...summary.parties.flatMap(p => [p.projected, p.average])].map(String));
  for (const n of text.match(/\d+(?:\.\d+)?/g) ?? []) if (!allowed.has(n)) return 'number ' + n;
  return null;
}
async function writeForecast(summary, summarizer, log) {
  if (!summarizer?.enabled) return { text: fallbackText(summary), model: null };
  const facts = [`מספר הערוצים בממוצע: ${summary.polls.length}`,
    ...summary.parties.filter(p => p.projected > 0).sort((a, b) => b.projected - a.projected).map(p => `${p.name}: ${p.projected} מנדטים${p.gov ? ' (מפלגה בממשלה היוצאת)' : ''}`),
    `מתחת לאחוז החסימה: ${summary.parties.filter(p => !p.projected).map(p => p.name).join(', ') || 'אין'}`,
    `סך מפלגות הממשלה היוצאת: ${summary.blocs.government}`, `סך שאר המפלגות: ${summary.blocs.others}`, 'דרושים לרוב: 61 מתוך 120'].join('\n');
  try {
    for (const m of await summarizer.discoverModels()) {
      if (!summarizer.canUse(m, Date.now())) continue;
      const text = await summarizer.generate(m, facts, PROMPT), problem = checkForecast(text, summary);
      if (!problem) return { text, model: m.name.replace('models/', '') };
      log.warn?.(`[elections] forecast rejected (${problem}): ${text.slice(0, 120)}`);
    }
  } catch (e) { log.warn?.('[elections] forecast failed: ' + e.message); }
  return { text: fallbackText(summary), model: null };
}

// ---------- fetching and publishing ----------
async function api(params, fetchImpl) {
  const r = await fetchImpl(API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params }), { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`wikipedia: HTTP ${r.status}`);
  return r.json();
}
async function hebrewNames(titles, fetchImpl) {
  const out = {};
  const j = await api({ action: 'query', prop: 'langlinks', lllang: 'he', lllimit: '500', redirects: '1', titles: titles.join('|') }, fetchImpl);
  const back = Object.fromEntries((j.query?.redirects ?? []).map(r => [r.to, r.from]));
  for (const p of j.query?.pages ?? []) { const he = p.langlinks?.[0]?.title; if (he) out[back[p.title] ?? p.title] = he.replace(/\s*\(.*\)$/, ''); }
  return out;
}
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const write = (file, data) => { fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file); };

/**
 * Refresh <dir>/elections.json when it is older than refreshHours. Never throws: a failure keeps the last file.
 * @returns {Promise<string>} what happened, for the log
 */
export async function updateElections(dir, { config = {}, summarizer = null, log = console, now = Date.now(), fetchImpl = fetch } = {}) {
  const cfg = { ...DEFAULTS, ...config }, file = path.join(dir, 'elections.json'), last = read(file);
  const base = { electionDay: cfg.electionDay, source: { name: 'ויקיפדיה (CC BY-SA 4.0)', url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(cfg.page.replace(/ /g, '_')) } };
  try {
    if (now >= Date.parse(cfg.silenceFrom) && now < Date.parse(cfg.silenceUntil)) {
      if (!last?.silence) write(file, { ...base, silence: true, until: Date.parse(cfg.silenceUntil), updatedAt: now });
      return 'silence period: no polls are published';
    }
    if (last && !last.silence && now - last.checkedAt < cfg.refreshHours * 3600_000) return 'fresh';
    const wikitext = (await api({ action: 'parse', page: cfg.page, prop: 'wikitext' }, fetchImpl)).parse?.wikitext;
    if (!wikitext) throw new Error('no wikitext');
    const table = parsePolls(wikitext, cfg.section);
    const need = table.columns.flatMap(c => c.titles).filter(t => !KNOWN[t]);
    const names = { ...(last?.names ?? {}) };
    if (need.some(t => !names[t])) Object.assign(names, await hebrewNames(need, fetchImpl).catch(() => ({})));
    const summary = summarize(table, names, { now, maxPollAgeDays: cfg.maxPollAgeDays });
    if (summary.polls.length < 2) throw new Error(`only ${summary.polls.length} recent channel polls found`);
    const fingerprint = JSON.stringify(summary.polls.map(p => [p.channel, p.date, p.seats]));
    const forecast = last?.fingerprint === fingerprint && last.forecast ? last.forecast : { ...(await writeForecast(summary, summarizer, log)), at: now };
    write(file, { ...base, updatedAt: last?.fingerprint === fingerprint ? last.updatedAt : now, checkedAt: now, channels: CHANNELS.map(c => ({ id: c.id, name: c.name })),
      ...summary, forecast, names, fingerprint });
    return `${summary.polls.length} channels, leader ${summary.leader?.name} ${summary.leader?.seats}, government ${summary.blocs.government}`;
  } catch (e) { log.warn?.('[elections] ' + e.message); return 'failed: ' + e.message; }
}
