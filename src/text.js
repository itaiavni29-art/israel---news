// Title cleaning before embedding.
// We strip decoration that says nothing about *what happened* (clickbait markers, video tags,
// dates, punctuation) but keep the grammatical words: the embedding model reads full
// sentences better than keyword bags.

const ENTITIES = {
  amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', '#39': "'", '#34': '"',
  bull: '•', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
};

export function decodeEntities(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&([a-z#0-9]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}

// Leading markers like "בלעדי:", "תיעוד:", "צפו:" and trailing ones like "| צפו", "| התחזית", "| 29.9.2026".
const LEAD_MARKERS = /^\s*(בלעדי|פרסום ראשון|תיעוד|צפו|וידאו|דיווח|עדכון|מבזק|דרמה|חשיפה|סקר|breaking|watch|exclusive)\s*[:\-–|]\s*/i;
const TAIL_MARKER = /\s*[|•]\s*[^|•]{0,25}$/;
const FILLER_WORDS = /(^|\s)(צפו|תיעוד|בלעדי|וידאו)(?=\s|$)/g;

export function cleanTitle(raw) {
  let t = decodeEntities(raw).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 2; i++) t = t.replace(LEAD_MARKERS, '');
  // Only strip a trailing "| xxx" tag when a meaningful headline remains before it.
  const tail = t.match(TAIL_MARKER);
  if (tail && t.length - tail[0].length > 20) t = t.slice(0, t.length - tail[0].length);
  t = t.replace(FILLER_WORDS, ' ');
  // Quotes: keep gershayim inside acronyms (צה"ל, יועמ"ש), drop quote marks around phrases.
  t = t.replace(/(?<![א-ת])["״'׳]|["״'׳](?![א-ת])/g, ' ');
  // Other punctuation → space.
  t = t.replace(/[.,:;!?()[\]{}|/\\–—\-_…“”‘’«»•*#@~]+/g, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

export const isHebrew = s => /[א-ת]/.test(s);
