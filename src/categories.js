// Topic label for a headline — shown on cards and used by the "נושאים" screen.
// 1) Many sites put the section in the URL (maariv.co.il/news/politics/…) — use that when present.
// 2) Otherwise compare the headline's embedding with a short description of each topic and take the
//    closest one, if it is clearly closer than the rest. Same local model, no extra cost.
import { cosine } from './embedder.js';

export const CATEGORIES = [
  { id: 'politics', name: 'פוליטיקה', color: '#174a7e', describe: 'פוליטיקה: הכנסת, הממשלה, הבחירות, הקואליציה והאופוזיציה, נתניהו, שרים ומפלגות' },
  { id: 'security', name: 'ביטחון', color: '#111a22', describe: 'ביטחון וצבא: צה"ל, מלחמה, חמאס, חיזבאללה, איראן, פיגוע, טילים, חיילים ושב"כ' },
  { id: 'economy', name: 'כלכלה', color: '#19705a', describe: 'כלכלה ועסקים: שוק ההון, מניות, בורסה, בנקים, ריבית, מחירים, חברות ועסקאות' },
  { id: 'world', name: 'עולם', color: '#5b4a9e', describe: 'חדשות העולם: ארצות הברית, טראמפ, אירופה, רוסיה ואוקראינה, סין, האו"ם ומדינות זרות' },
  { id: 'law', name: 'משפט ופלילים', color: '#8a3b12', describe: 'משפט ופלילים: משטרה, חקירה, מעצר, רצח, בית משפט, כתב אישום ופרשות' },
  { id: 'society', name: 'חברה ובריאות', color: '#a35c14', describe: 'חברה, בריאות וחינוך: בתי ספר, בתי חולים, משרד הבריאות, רווחה, תאונות ומזג האוויר' },
  { id: 'tech', name: 'טכנולוגיה', color: '#2d6a8f', describe: 'טכנולוגיה והייטק: בינה מלאכותית, סטארטאפים, סייבר, אפל, גוגל ואפליקציות' },
];
const byId = Object.fromEntries(CATEGORIES.map(c => [c.id, c]));

const URL_RULES = [
  [/\/(politics|elections?|knesset)/i, 'politics'],
  [/\/(military|security|defense|idf)/i, 'security'],
  [/\/(economy|business|finance|markets|wallstreet|realestate|consumer|dynamo|capital)/i, 'economy'],
  [/globes\.co\.il\/news\/article/i, 'economy'],
  [/themarker\.com/i, 'economy'],
  [/\/(world|world-news|international|middle-east|geopolitics|global)/i, 'world'],
  [/\/(law|crime|police)/i, 'law'],
  [/\/(health|education|weather)/i, 'society'],
  [/\/(tech|technation|tech-news|cyber)/i, 'tech'],
];

export class Categorizer {
  constructor(embedder) { this.embedder = embedder; this.protos = null; }

  async init() {
    if (!this.protos) this.protos = await this.embedder.embed(CATEGORIES.map(c => c.describe));
  }

  /** @param {{link: string, vec?: Float32Array}} article @returns {string|null} category id */
  categorize(article) {
    for (const [re, id] of URL_RULES) if (re.test(article.link)) return id;
    if (!article.vec || !this.protos) return null;
    const scores = this.protos.map(p => cosine(article.vec, p)).map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]);
    // Only label when the best topic is clearly ahead of the runner-up.
    return scores[0][0] - scores[1][0] >= 0.01 ? CATEGORIES[scores[0][1]].id : null;
  }
}

export const categoryInfo = id => (id && byId[id] ? { id, name: byId[id].name, color: byId[id].color } : null);

/** Most common category among an event's articles. */
export function eventCategory(articles) {
  const counts = new Map();
  for (const a of articles) if (a.category) counts.set(a.category, (counts.get(a.category) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}
