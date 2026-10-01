// Event summaries with the Gemini API (free tier).
//
// For each multi-source event the model gets every source's headline + feed teaser and writes a short
// Hebrew summary in its own words. Guards before a summary is accepted:
//   • every number in the summary must appear in the sources (a cheap check against invented facts),
//   • no run of 7+ words copied from a source teaser (write in own words — copyright),
//   • Hebrew, 15–110 words.
// Free-tier limits are per project and reset at midnight Pacific time; we stay below them ourselves.
// No key (e.g. local development) → the summarizer is simply off. Failures never break a scan.
import { cleanTitle } from './text.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const DAY_TZ = 'America/Los_Angeles';

// Candidate models in order of preference, matched against the models the key can actually use.
// Limits are kept a bit under the free tier shown in AI Studio for the project.
const CANDIDATES = [
  { pattern: /^models\/gemini-(\d+(?:\.\d+)?)-flash-lite$/, perDay: 450, perMinute: 12 },          // 500/day, 15/min
  // dated / preview variants of flash-lite — but never speech, image, audio or live models
  { pattern: /^models\/gemini-(\d+(?:\.\d+)?)-flash-lite-(?!.*(?:tts|image|audio|live|transcribe))[\w.-]+$/, perDay: 450, perMinute: 12 },
  { pattern: /^models\/gemma-4-31b(-it)?$/, perDay: 13000, perMinute: 8, noSystem: true },         // 14.4K/day, 16K tokens/min
];

const PROMPT = `אתה עורך חדשות. לפניך כותרות ותקצירים מכמה אתרי חדשות שמדווחים על אותו אירוע.
כתוב סיכום עובדתי וקצר של האירוע בעברית: 2 עד 4 משפטים, עד 70 מילים.
כללים:
- השתמש רק במידע שמופיע בטקסטים שלמטה. אל תוסיף שמות, מספרים, תאריכים, סיבות או הערכות שלא כתובים שם.
- אם המקורות סותרים זה את זה, ציין זאת בקצרה.
- נסח במילים שלך. אל תעתיק משפטים או חלקי משפטים מהמקורות.
- אל תעתיק ציטוטים ארוכים: מסור את תוכן הדברים בלשון עקיפה ("לדבריו…"), ולכל היותר צטט שלוש-ארבע מילים.
- מספרים כתוב בספרות ובאותה צורה שבה הם מופיעים במקורות.
- שמות של אנשים, מקומות, גופים ומונחים עובדתיים נשארים כפי שהם במקורות: אל תחליף מונח במונח בעל גוון פוליטי או רגשי שונה, ואל תוסיף שם פרטי, תואר או תפקיד שלא כתובים שם.
- אל תזכיר את שמות האתרים, אל תכתוב כותרת, ואל תשתמש בתבליטים או בעיצוב.
- החזר רק את טקסט הסיכום.`;

// A "hot" story has ONE source, so the summary must stay well away from that site's wording:
// facts only, restructured, short — and it is checked more strictly (see checkSummary).
const PROMPT_SINGLE = `אתה עורך חדשות. לפניך כותרת ותקציר של ידיעה אחת מאתר חדשות.
מסור את העובדות המרכזיות שבה בעברית, בניסוח שלך: 2 עד 3 משפטים, עד 50 מילים.
כללים:
- הניסוח חייב להיות רחוק מהמקור: בנה את המשפטים אחרת, בסדר אחר ובמילים אחרות. אל תשמור על ביטויים ייחודיים, דימויים או סגנון של הכותב.
- אל תעתיק רצף של יותר משלוש מילים מהמקור (חוץ משמות של אנשים, מקומות וגופים).
- שנה את מבנה המשפטים, לא את המונחים: שמות של אנשים, מקומות, גופים ומונחים עובדתיים נשארים בדיוק כפי שהם במקור. אל תחליף מונח במונח אחר שיש לו גוון פוליטי או רגשי שונה, ואל תוסיף שם פרטי, תואר או תפקיד שלא כתובים במקור.
- מסור עובדות בלבד: בלי ציטוטים, בלי פרשנות ובלי הערכות של הכותב.
- השתמש רק במידע שמופיע בטקסט שלמטה. אל תוסיף שמות, מספרים, תאריכים או סיבות שלא כתובים שם.
- אל תזכיר את שם האתר, אל תכתוב כותרת, ואל תשתמש בתבליטים או בעיצוב.
- החזר רק את טקסט הסיכום.`;

// Bump when prompts or checks change: events whose summary failed under older rules get another try.
const RULES_VERSION = 2;

// What to tell the model when its previous attempt failed a check (in Hebrew, and actionable).
const HINT = (why, single) =>
  /copies|too close/.test(why) ? `הטקסט היה קרוב מדי לניסוח המקור${single ? '' : ', כנראה בגלל ציטוט ארוך'}. נסח מחדש במילים אחרות ומסור ציטוטים בלשון עקיפה`
  : /numbers/.test(why) ? 'הופיעו מספרים שלא כתובים במקורות. השתמש רק במספרים שמופיעים בטקסט, ובאותה צורת כתיבה'
  : /length/.test(why) ? 'האורך לא התאים. כתוב 2 עד 3 משפטים מלאים'
  : 'התשובה לא הייתה סיכום בעברית';

const pacificDay = (ms = Date.now()) => new Intl.DateTimeFormat('en-CA', { timeZone: DAY_TZ }).format(ms);
const words = s => cleanTitle(s).split(' ').filter(Boolean);
const numbers = s => (s.match(/\d+(?:[.,]\d+)?/g) ?? []).map(n => n.replace(',', '.'));

/** Longest run of consecutive words shared by a and b. */
export function longestSharedRun(a, b) {
  const A = words(a), B = words(b);
  let best = 0;
  const prev = new Array(B.length + 1).fill(0);
  for (let i = 1; i <= A.length; i++) {
    let diag = 0;
    for (let j = 1; j <= B.length; j++) {
      const tmp = prev[j];
      prev[j] = A[i - 1] === B[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = tmp;
    }
  }
  return best;
}

/** Share (0..1) of the summary's three-word sequences that also appear in the source texts. */
export function trigramOverlap(summary, sourceTexts) {
  const grams = t => { const w = words(t); return w.slice(0, -2).map((_, i) => w.slice(i, i + 3).join(' ')); };
  const mine = grams(summary);
  if (!mine.length) return 0;
  const theirs = new Set(sourceTexts.flatMap(grams));
  return mine.filter(g => theirs.has(g)).length / mine.length;
}

/**
 * @param {{single?: boolean}} opts single-source summaries are held to a stricter standard: they
 *   rewrite one site's item, so they must be clearly further from its wording.
 * @returns {string|null} why the summary is rejected, or null if it is acceptable
 */
export function checkSummary(summary, sourceTexts, { single = false } = {}) {
  const n = words(summary).length;
  if (!/[א-ת]/.test(summary)) return 'not Hebrew';
  if (n < (single ? 10 : 15) || n > (single ? 70 : 110)) return `length ${n} words`;
  const known = new Set(sourceTexts.flatMap(numbers));
  const invented = numbers(summary).filter(x => !known.has(x));
  if (invented.length) return `numbers not in sources: ${invented.join(', ')}`;
  const copied = Math.max(0, ...sourceTexts.map(t => longestSharedRun(summary, t)));
  if (copied >= (single ? 5 : 7)) return `copies ${copied} consecutive words from a source`;
  if (single) {
    const overlap = trigramOverlap(summary, sourceTexts);
    if (overlap > 0.25) return `too close to the source (${Math.round(overlap * 100)}% of its three-word sequences)`;
  }
  return null;
}

export class Summarizer {
  constructor({ apiKey = process.env.GEMINI_API_KEY, log = console, maxPerScan = 12, fetchImpl = fetch, singleSource = false } = {}) {
    // singleSource: also summarize "hot" single-source stories (stricter prompt and checks).
    Object.assign(this, { apiKey, log, maxPerScan, fetch: fetchImpl, singleSource });
    this.models = null;       // [{ name, perDay, perMinute, noSystem }] available to this key, best first
    this.usage = { day: pacificDay(), counts: {} };
    this.minute = new Map();  // model -> timestamps of calls in the last minute
    this.exhausted = new Map(); // model -> Pacific day on which it hit a quota
    this.lastError = null;
    this.rejections = [];     // last summaries that failed the checks on every model, with the reason
  }

  get enabled() { return !!this.apiKey; }

  toJSON() {
    return { usage: this.usage, exhausted: Object.fromEntries(this.exhausted), lastError: this.lastError,
      models: this.models?.map(m => m.name) ?? null, rejections: this.rejections };
  }
  load(json) {
    if (!json) return;
    if (json.usage?.day === pacificDay()) this.usage = json.usage;
    this.exhausted = new Map(Object.entries(json.exhausted ?? {}).filter(([, d]) => d === pacificDay()));
    this.rejections = json.rejections ?? [];
  }

  async discoverModels() {
    if (this.models) return this.models;
    const r = await this.fetch(`${API}/models?pageSize=1000`, { headers: { 'x-goog-api-key': this.apiKey }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`list models: HTTP ${r.status}`);
    const names = ((await r.json()).models ?? [])
      .filter(m => (m.supportedGenerationMethods ?? []).includes('generateContent')).map(m => m.name);
    const picked = [];
    for (const c of CANDIDATES) {
      const matches = names.filter(n => c.pattern.test(n) && !picked.some(p => p.name === n))
        .sort((a, b) => parseFloat(b.match(c.pattern)?.[1] ?? 0) - parseFloat(a.match(c.pattern)?.[1] ?? 0));
      // the two newest versions: each has its own free daily quota, so the older one is a real fallback
      for (const name of matches.slice(0, 2)) picked.push({ name, perDay: c.perDay, perMinute: c.perMinute, noSystem: !!c.noSystem });
    }
    this.models = picked;
    this.log.info?.(`[summarizer] models: ${picked.map(m => m.name).join(' → ') || 'none available'}`);
    return picked;
  }

  canUse(m, now) {
    if (this.usage.day !== pacificDay(now)) this.usage = { day: pacificDay(now), counts: {} };
    if (this.exhausted.get(m.name) === pacificDay(now)) return false;
    if ((this.usage.counts[m.name] ?? 0) >= m.perDay) return false;
    const recent = (this.minute.get(m.name) ?? []).filter(t => now - t < 60_000);
    this.minute.set(m.name, recent);
    return recent.length < m.perMinute;
  }

  async generate(m, userText, prompt = PROMPT) {
    const text = m.noSystem ? `${prompt}\n\n${userText}` : userText;
    const body = {
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      ...(m.noSystem ? {} : { systemInstruction: { parts: [{ text: prompt }] } }),
    };
    const now = Date.now();
    this.usage.counts[m.name] = (this.usage.counts[m.name] ?? 0) + 1;
    this.minute.get(m.name)?.push(now) ?? this.minute.set(m.name, [now]);
    const r = await this.fetch(`${API}/${m.name}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
    });
    if (r.status === 429) { this.exhausted.set(m.name, pacificDay()); throw new Error(`${m.name}: quota reached (429)`); }
    if (!r.ok) throw new Error(`${m.name}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const out = await r.json();
    return (out.candidates?.[0]?.content?.parts ?? []).filter(p => !p.thought).map(p => p.text ?? '').join('').trim()
      .replace(/^[#*\s]+|[*_`]/g, '').replace(/\s+/g, ' ').trim();
  }

  /**
   * Summarize events that need it: multi-source events without a summary, or whose source count grew.
   * @param {object[]} events active events (mutated: ev.summary = { text, model, at, sourceCount })
   * @param {Map} pool current feed items by key (to get teasers, which are never saved)
   * @param {object} sourcesById
   */
  async summarizeEvents(events, pool, sourcesById, minSources = 2) {
    if (!this.enabled) return { done: 0, skipped: 'no GEMINI_API_KEY' };
    let done = 0, rejected = 0;
    try { await this.discoverModels(); } catch (e) { this.lastError = e.message; this.log.error(`[summarizer] ${e.message}`); return { done, error: e.message }; }
    const teaserOf = a => pool.get(a.key)?.teaser ?? a.teaser;
    const isSingle = ev => !!ev.provisional || new Set(ev.articles.map(a => a.sourceId)).size < minSources;
    const todo = events.filter(ev => {
      const n = new Set(ev.articles.map(a => a.sourceId)).size;
      // (a summary that failed the checks is retried only when another source joins)
      if ((ev.summary && ev.summary.sourceCount >= n) || (ev.summaryTried === n && ev.summaryRules === RULES_VERSION)) return false;
      if (!isSingle(ev)) return true;
      // A hot story is summarized only if the site gave a teaser with real content — rewording a bare
      // headline adds nothing.
      return this.singleSource && ev.articles.some(a => words(teaserOf(a) ?? '').length >= 12);
    });
    for (const ev of todo.slice(0, this.maxPerScan)) {
      const sources = [];
      for (const a of ev.articles) {
        const teaser = teaserOf(a);
        sources.push({ name: sourcesById[a.sourceId]?.name ?? a.sourceId, title: a.title, teaser });
      }
      const single = isSingle(ev);
      const prompt = single ? PROMPT_SINGLE : PROMPT;
      const userText = sources.map((s, i) => `${single ? 'ידיעה' : 'מקור'} ${i + 1}:\nכותרת: ${s.title}${s.teaser ? `\nתקציר: ${s.teaser}` : ''}`).join('\n\n');
      const sourceTexts = sources.flatMap(s => [s.title, s.teaser].filter(Boolean));
      const sourceCount = new Set(ev.articles.map(a => a.sourceId)).size;
      // Up to three models get a go (each with one retry that spells out why the first try failed).
      // A different model often words things differently enough to pass where the first one did not.
      let lastWhy = null, modelsTried = 0;
      for (const m of this.models) {
        if (modelsTried >= 3) break;
        if (!this.canUse(m, Date.now())) continue;
        modelsTried++;
        try {
          let text = await this.generate(m, userText, prompt);
          let why = checkSummary(text, sourceTexts, { single });
          if (why && this.canUse(m, Date.now())) {
            text = await this.generate(m, `${userText}\n\nהערה: הניסיון הקודם נפסל (${HINT(why, single)}). הקפד על הכללים.`, prompt);
            why = checkSummary(text, sourceTexts, { single });
          }
          if (why) { lastWhy = `${m.name.replace('models/', '')}: ${why}`; continue; }
          ev.summary = { text, model: m.name.replace('models/', ''), at: Date.now(), sourceCount, ...(single && { single: true }) };
          delete ev.summaryTried;
          lastWhy = null;
          done++;
          break;
        } catch (e) {
          this.lastError = e.message;
          this.log.error(`[summarizer] ${e.message}`);
        }
      }
      if (lastWhy && !ev.summary) {
        rejected++;
        ev.summaryTried = sourceCount;
        ev.summaryRules = RULES_VERSION;
        this.rejections.unshift({ at: Date.now(), title: ev.articles[0].title.slice(0, 70), single, why: lastWhy });
        this.rejections.length = Math.min(this.rejections.length, 30);
        this.log.info?.(`[summarizer] rejected (${lastWhy}): ${ev.articles[0].title.slice(0, 50)}`);
      }
    }
    return { done, rejected, pending: Math.max(0, todo.length - done - rejected) };
  }
}
