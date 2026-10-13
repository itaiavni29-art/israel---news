import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parsePolls, summarize, allocate, fallbackText, checkForecast } from '../src/elections.js';

const wikitext = fs.readFileSync(new URL('./fixtures/polls-wikitext.txt', import.meta.url), 'utf8');
const NOW = Date.parse('2026-10-13T12:00:00Z');

test('the polls table: parties, merged columns, polls that add up to 120', () => {
  const { columns, polls } = parsePolls(wikitext);
  assert.equal(columns[0].key, 'Likud');
  assert.ok(columns[0].gov && !columns[1].gov);
  assert.deepEqual(columns.find(c => c.span === 2).titles, ['Religious Zionist Party', 'Zehut']);
  assert.ok(polls.length >= 10);
  assert.ok(polls.every(p => p.total === 120), 'every poll adds up to 120 seats');
  const first = polls[0]; // 12 October, Channel 14
  assert.equal(first.date, '2026-10-12');
  assert.equal(first.seats.Likud, 29);
  assert.equal(first.seats['Blue and White (political party)'], 0);
  assert.equal(first.below['Blue and White (political party)'], '(0.6%)');
  assert.match(first.url, /^https:\/\//);
});

test('the latest poll of each channel, the average and a forecast that adds up to 120', () => {
  const s = summarize(parsePolls(wikitext), {}, { now: NOW });
  assert.deepEqual(s.polls.map(p => p.channel), ['n12', 'reshet13', 'kan11', 'ch14', 'i24']);
  assert.equal(s.polls.find(p => p.channel === 'ch14').date, '2026-10-12', 'the newest of the channel');
  const likud = s.parties.find(p => p.key === 'Likud');
  assert.equal(likud.average, 23.4); // 21, 20, 21, 29, 26
  assert.equal(s.parties.reduce((n, p) => n + p.projected, 0), 120);
  assert.equal(s.blocs.government + s.blocs.others, 120);
  assert.equal(s.parties.find(p => p.key === 'Amcha Yisrael').projected, 0, 'passes in 2 of 5 polls only');
  assert.equal(s.leader.key, 'Likud');
});

test('old polls are left out', () => {
  const s = summarize(parsePolls(wikitext), {}, { now: NOW + 60 * 86400_000 });
  assert.equal(s.polls.length, 0);
});

test('largest remainder', () => {
  assert.deepEqual(allocate({ a: 1, b: 1, c: 1 }, 10), { a: 4, b: 3, c: 3 });
  assert.equal(Object.values(allocate({ a: 23.4, b: 11, c: 7.5 })).reduce((x, y) => x + y), 120);
});

test('the forecast text may only use numbers from the data', () => {
  const s = summarize(parsePolls(wikitext), {}, { now: NOW });
  assert.equal(checkForecast(fallbackText(s), s), null);
  assert.match(checkForecast(fallbackText(s).replace(String(s.leader.seats), '37'), s), /^number 37/);
  assert.equal(checkForecast(fallbackText(s) + ' הקואליציה מתחזקת.', s), 'blocs', 'nothing about government or blocs');
});
