// Do two headlines share a *rare* word — a name, company or place ("אלטשולר", "איזנקוט", "צים")?
// Headlines about the same event nearly always do. Two stories that merely sound alike
// ("…שוק השכירות…" / "…שוק ההון…") share only common words. Rarity = document frequency in the
// current headline pool, so it adapts to what is in the news today.
import { cleanTitle } from './text.js';

const HEB = /^[א-ת"״']+$/;
const PREFIX2 = /^(וה|וב|ול|ומ|וש|שה|שב|של|מה|לה|בה|כש|כה|וכ)/;
const PREFIX1 = /^[והבלמשכ]/;
const STOP = new Set(['את', 'של', 'על', 'עם', 'גם', 'לא', 'כי', 'זה', 'זו', 'הוא', 'היא', 'הם', 'אחרי', 'לפני', 'בין', 'כל', 'אבל', 'או', 'אם', 'מה', 'מי', 'איך', 'יותר', 'אחד', 'אחת', 'רק', 'כך', 'עד', 'היום', 'דיווח', 'לאחר', 'בגלל', 'עוד', 'נגד', 'אין', 'יש']);

/** Normalized word forms of a headline; Hebrew one/two-letter prefixes are also stripped as variants. */
export function wordForms(title) {
  const forms = new Set();
  for (let w of cleanTitle(title).toLowerCase().split(' ')) {
    w = w.replace(/["״']/g, '');
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    forms.add(w);
    if (HEB.test(w)) {
      if (w.length >= 4 && PREFIX1.test(w)) forms.add(w.slice(1));
      if (w.length >= 5 && PREFIX2.test(w)) forms.add(w.slice(2));
    }
  }
  return forms;
}

export class LexicalIndex {
  /**
   * @param {string[]} titles headline pool used for document frequencies
   * @param {number} rareShare a word is "rare" if it appears in at most this share of the pool's headlines
   */
  constructor(titles, rareShare = 0.02) {
    this.df = new Map();
    this.cache = new Map();
    for (const t of new Set(titles)) for (const f of this.forms(t)) this.df.set(f, (this.df.get(f) ?? 0) + 1);
    this.maxDf = Math.max(2, Math.ceil(new Set(titles).size * rareShare));
  }

  forms(title) {
    let f = this.cache.get(title);
    if (!f) { f = wordForms(title); this.cache.set(title, f); }
    return f;
  }

  sharesRareWord(a, b) {
    const A = this.forms(a), B = this.forms(b);
    for (const f of A) if (B.has(f) && (this.df.get(f) ?? 0) <= this.maxDf) return true;
    return false;
  }
}
