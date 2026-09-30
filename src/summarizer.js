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
  { pattern: /^models\/gemini-(\d+(?:\.\d+)?)-flash-lite(-[\w-]+)?$/, perDay: 450, perMinute: 12 },
  { pattern: /^models\/gemma-4-31b(-it)?$/, perDay: 13000, perMinute: 8, noSystem: true },         // 14.4K/day, 16K tokens/min
];

const PROMPT = `אתה עורך חדשות. לפניך כותרות ותקצירים מכמה אתרי חדשות שמדווחים על אותו אירוע.
כתוב סיכום עובדתי וקצר של האירוע בעברית: 2 עד 4 משפטים, עד 70 מילים.
כללים:
- השתמש רק במידע שמופיע בטקסטים שלמטה. אל תוסיף שמות, מספרים, תאריכים, סיבות או הערכות שלא כתובים שם.
- אם המקורות סותרים זה את זה, ציין זאת בקצרה.
- נסח במילים שלך. אל תעתיק משפטים או חלקי משפטים מהמקורות.
- אל תזכיר את שמות האתרים, אל תכתוב כותרת, ואל תשתמש בתבליטים או בעיצוב.
- החזר רק את טקסט הסיכום.`;

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

/** @returns {string|null} why the summary is rejected, or null if it is acceptable */
export function checkSummary(summary, sourceTexts) {
  const n = words(summary).length;
  if (!/[א-ת]/.test(summary)) return 'not Hebrew';
  if (n < 15 || n > 110) return `length ${n} words`;
  const known = new Set(sourceTexts.flatMap(numbers));
  const invented = numbers(summary).filter(x => !known.has(x));
  if (invented.length) return `numbers not in sources: ${invented.join(', ')}`;
  const copied = Math.max(0, ...sourceTexts.map(t => longestSharedRun(summary, t)));
  if (copied >= 7) return `copies ${copied} consecutive words from a source`;
  return null;
}

export class Summarizer {
  constructor({ apiKey = process.env.GEMINI_API_KEY, log = console, maxPerScan = 12, fetchImpl = fetch } = {}) {
    Object.assign(this, { apiKey, log, maxPerScan, fetch: fetchImpl });
    this.models = null;       // [{ name, perDay, perMinute, noSystem }] available to this key, best first
    this.usage = { day: pacificDay(), counts: {} };
    this.minute = new Map();  // model -> timestamps of calls in the last minute
    this.exhausted = new Map(); // model -> Pacific day on which it hit a quota
    this.lastError = null;
  }

  get enabled() { return !!this.apiKey; }

  toJSON() { return { usage: this.usage, exhausted: Object.fromEntries(this.exhausted), lastError: this.lastError, models: this.models?.map(m => m.name) ?? null }; }
  load(json) {
    if (!json) return;
    if (json.usage?.day === pacificDay()) this.usage = json.usage;
    this.exhausted = new Map(Object.entries(json.exhausted ?? {}).filter(([, d]) => d === pacificDay()));
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
      if (matches[0]) picked.push({ name: matches[0], perDay: c.perDay, perMinute: c.perMinute, noSystem: !!c.noSystem });
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

  async generate(m, userText) {
    const text = m.noSystem ? `${PROMPT}\n\n${userText}` : userText;
    const body = {
      contents: [{ role: 'user', parts: [{ text }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 1024 },
      ...(m.noSystem ? {} : { systemInstruction: { parts: [{ text: PROMPT }] } }),
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
    const todo = events.filter(ev => {
      const n = new Set(ev.articles.map(a => a.sourceId)).size;
      // (a summary that failed the checks is retried only when another source joins)
      return n >= minSources && !ev.provisional && (!ev.summary || ev.summary.sourceCount < n) && ev.summaryTried !== n;
    });
    for (const ev of todo.slice(0, this.maxPerScan)) {
      const sources = [];
      for (const a of ev.articles) {
        const teaser = pool.get(a.key)?.teaser ?? a.teaser;
        sources.push({ name: sourcesById[a.sourceId]?.name ?? a.sourceId, title: a.title, teaser });
      }
      const userText = sources.map((s, i) => `מקור ${i + 1}:\nכותרת: ${s.title}${s.teaser ? `\nתקציר: ${s.teaser}` : ''}`).join('\n\n');
      const sourceTexts = sources.flatMap(s => [s.title, s.teaser].filter(Boolean));
      const sourceCount = new Set(ev.articles.map(a => a.sourceId)).size;
      for (const m of this.models) {
        if (!this.canUse(m, Date.now())) continue;
        try {
          let text = await this.generate(m, userText);
          let why = checkSummary(text, sourceTexts);
          if (why && this.canUse(m, Date.now())) { // one retry, with the reason spelled out
            text = await this.generate(m, `${userText}\n\nהערה: הניסיון הקודם נפסל (${why}). הקפד על הכללים.`);
            why = checkSummary(text, sourceTexts);
          }
          if (why) { rejected++; ev.summaryTried = sourceCount; this.log.info?.(`[summarizer] rejected (${why}): ${ev.articles[0].title.slice(0, 50)}`); break; }
          ev.summary = { text, model: m.name.replace('models/', ''), at: Date.now(), sourceCount };
          done++;
          break;
        } catch (e) {
          this.lastError = e.message;
          this.log.error(`[summarizer] ${e.message}`);
        }
      }
    }
    return { done, rejected, pending: Math.max(0, todo.length - done - rejected) };
  }
}
