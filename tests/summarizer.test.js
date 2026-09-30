// Summarizer with a fake Gemini server — no API key or network needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Summarizer, checkSummary, longestSharedRun } from '../src/summarizer.js';

const quiet = { info() {}, error() {} };
const SRC = [
  'נתניהו ולפיד ייפגשו הערב',
  'לפיד דרש פגישה דחופה עם ראש הממשלה בעקבות האזהרה, ונתניהו הסכים להיפגש איתו בלילה',
  'נתניהו התקפל: ראש הממשלה ייפגש הלילה עם לפיד',
];
const GOOD = 'ראש הממשלה נתניהו הסכים להיפגש הלילה עם ראש האופוזיציה לפיד. הפגישה נקבעה לאחר שלפיד דרש לקיים שיחה דחופה בעקבות האזהרה, ובתחילה נענה בסירוב.';

test('checkSummary: accepts a paraphrase, rejects invented numbers, copying, wrong length and non-Hebrew', () => {
  assert.equal(checkSummary(GOOD, SRC), null);
  assert.match(checkSummary(GOOD + ' בפגישה השתתפו 12 שרים.', SRC), /numbers not in sources: 12/);
  assert.match(checkSummary('לפיד דרש פגישה דחופה עם ראש הממשלה בעקבות האזהרה, ונתניהו הסכים להיפגש איתו בלילה. זה קרה היום.', SRC), /copies/);
  assert.match(checkSummary('נתניהו ולפיד ייפגשו.', SRC), /length/);
  assert.match(checkSummary('Netanyahu and Lapid will meet tonight after Lapid demanded an urgent meeting following the warning today.', SRC), /not Hebrew/);
  assert.equal(longestSharedRun('א ב ג ד', 'x ב ג y'), 2);
});

// Fake Gemini API: lists models and answers generateContent from a script of responses per model.
function fakeApi(script, calls = []) {
  return async (url, opts = {}) => {
    calls.push({ url, body: opts.body && JSON.parse(opts.body) });
    const json = (status, body) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (url.includes('/models?')) return json(200, { models: [
      { name: 'models/gemini-3.1-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash-lite', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemma-4-31b-it', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] });
    const model = url.match(/models\/([^:]+):generateContent/)[1];
    const next = script[model]?.shift();
    if (!next) return json(500, { error: 'unexpected call' });
    if (next.status) return json(next.status, { error: next.status });
    return json(200, { candidates: [{ content: { parts: [{ text: next.text }] } }] });
  };
}
const event = (id, sources = ['ynet', 'srugim', 'israelhayom']) => ({
  id, articles: sources.map((s, i) => ({ key: `${id}-${i}`, sourceId: s, title: SRC[i % SRC.length] })),
});

test('picks the newest flash-lite first, then gemma as fallback; stores the summary', async () => {
  const calls = [];
  const s = new Summarizer({ apiKey: 'k', log: quiet, fetchImpl: fakeApi({ 'gemini-3.5-flash-lite': [{ text: GOOD }] }, calls) });
  const ev = event('e1');
  const r = await s.summarizeEvents([ev], new Map(), {});
  assert.deepEqual(s.models.map(m => m.name), ['models/gemini-3.5-flash-lite', 'models/gemini-3.1-flash-lite', 'models/gemma-4-31b-it']);
  assert.equal(r.done, 1);
  assert.equal(ev.summary.text, GOOD);
  assert.equal(ev.summary.model, 'gemini-3.5-flash-lite');
  assert.ok(calls.at(-1).body.systemInstruction, 'Gemini gets the rules as a system instruction');
});

test('quota reached (429) → falls back to the next model and remembers the exhausted one', async () => {
  const calls = [];
  const s = new Summarizer({ apiKey: 'k', log: quiet, fetchImpl: fakeApi({
    'gemini-3.5-flash-lite': [{ status: 429 }], 'gemini-3.1-flash-lite': [{ status: 429 }], 'gemma-4-31b-it': [{ text: GOOD }, { text: GOOD }],
  }, calls) });
  const [a, b] = [event('a'), event('b')];
  await s.summarizeEvents([a, b], new Map(), {});
  assert.equal(a.summary.model, 'gemma-4-31b-it');
  assert.equal(b.summary.model, 'gemma-4-31b-it');
  assert.equal(calls.filter(c => c.url.includes('gemini-3.5-flash-lite:')).length, 1, 'exhausted model is not called again');
  assert.ok(!calls.at(-1).body.systemInstruction && calls.at(-1).body.contents[0].parts[0].text.includes('אתה עורך חדשות'), 'Gemma gets the rules inline');
  assert.deepEqual(Object.keys(s.toJSON().exhausted).sort(), ['models/gemini-3.1-flash-lite', 'models/gemini-3.5-flash-lite']);
});

test('a summary that fails the checks is retried once, then left out until another source joins', async () => {
  const bad = GOOD + ' בפגישה השתתפו 12 שרים.';
  const script = { 'gemini-3.5-flash-lite': [{ text: bad }, { text: bad }] };
  const s = new Summarizer({ apiKey: 'k', log: quiet, fetchImpl: fakeApi(script) });
  const ev = event('x');
  let r = await s.summarizeEvents([ev], new Map(), {});
  assert.equal(r.rejected, 1);
  assert.equal(ev.summary, undefined);
  r = await s.summarizeEvents([ev], new Map(), {});          // no new source → not tried again
  assert.equal(r.rejected + r.done, 0);
  ev.articles.push({ key: 'x-new', sourceId: 'haaretz', title: SRC[2] });
  script['gemini-3.5-flash-lite'].push({ text: GOOD });
  r = await s.summarizeEvents([ev], new Map(), {});          // 4 sources now → retried
  assert.equal(r.done, 1);
});

test('single-source and hot events are never summarized; no key → off', async () => {
  const s = new Summarizer({ apiKey: 'k', log: quiet, fetchImpl: fakeApi({}) });
  const single = event('s', ['ynet']);
  const hot = { ...event('h', ['ynet', 'srugim']), provisional: true };
  const r = await s.summarizeEvents([single, hot], new Map(), {});
  assert.equal(r.done, 0);
  assert.equal(new Summarizer({ apiKey: undefined, log: quiet }).enabled, false);
});

test('teasers come from the live feed pool (they are never saved) and reach the prompt', async () => {
  const calls = [];
  const s = new Summarizer({ apiKey: 'k', log: quiet, fetchImpl: fakeApi({ 'gemini-3.5-flash-lite': [{ text: GOOD }] }, calls) });
  const ev = event('t');
  const pool = new Map([[ 't-1', { teaser: SRC[1] } ]]);
  await s.summarizeEvents([ev], pool, { ynet: { name: 'ynet' } });
  assert.ok(calls.at(-1).body.contents[0].parts[0].text.includes(`תקציר: ${SRC[1]}`));
});
