// Decide whether a feed item is hard news (keep) or sponsored / lifestyle / non-news (drop).

const compile = list => (list ?? []).map(p => new RegExp(p, 'i'));

export function buildFilter(source, globalFilters = {}) {
  const include = compile(source.includeUrlPatterns);
  const exclude = compile(source.excludeUrlPatterns);
  const titleExclude = compile([...(globalFilters.excludeTitlePatterns ?? []), ...(source.excludeTitlePatterns ?? [])]);

  /** @returns {string|null} reason for dropping, or null to keep */
  return function reject(item) {
    if (!item.title || !item.link) return 'missing-fields';
    if (include.length && !include.some(r => r.test(item.link))) return 'non-news-section';
    if (exclude.some(r => r.test(item.link))) return 'excluded-section';
    if (titleExclude.some(r => r.test(item.title))) return 'excluded-title';
    return null;
  };
}
