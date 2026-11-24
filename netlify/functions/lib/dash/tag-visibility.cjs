// Tag visibility for the Batches & Tags, Opportunities by Batch / Tag and
// Best Responses by Batch / Tag tables. Owners pick which tags appear; the
// choice is saved server-side (dashboard-data?settings=tag-visibility) so it
// applies to everyone who opens the dashboard. It only changes which rows the
// tag tables list - no call, text, opportunity or GHL tag is altered.
//
// mode 'all'     - every tag is listed (default)
// mode 'include' - only tags that match the selection are listed
// mode 'exclude' - tags that match the selection are hidden
// A tag matches the selection when it is ticked by name, contains one of the
// keywords (case-insensitive), or - with zipCodes on - contains a 5-digit number.
// Keywords and the zip rule also catch new batch tags added later.
(function (root) {
  const MODES = ['all', 'include', 'exclude'];
  const LIMITS = { tags: 2000, keywords: 50, length: 200 };

  function cleanList(value, max) {
    if (!Array.isArray(value)) return [];
    const seen = new Set();
    const out = [];
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const text = item.trim().slice(0, LIMITS.length);
      const key = text.toLowerCase();
      if (!text || seen.has(key)) continue;
      seen.add(key);
      out.push(text);
      if (out.length >= max) break;
    }
    return out;
  }

  function normalize(input) {
    const value = input && typeof input === 'object' ? input : {};
    return {
      mode: MODES.includes(value.mode) ? value.mode : 'all',
      tags: cleanList(value.tags, LIMITS.tags),
      keywords: cleanList(value.keywords, LIMITS.keywords),
      zipCodes: value.zipCodes === true,
      updatedAt: typeof value.updatedAt === 'string' ? value.updatedAt : null,
    };
  }

  function matcher(settings) {
    const s = normalize(settings);
    const names = new Set(s.tags.map(t => t.toLowerCase()));
    const keywords = s.keywords.map(k => k.toLowerCase());
    return function matches(tag) {
      const t = String(tag || '').trim().toLowerCase();
      if (!t) return false;
      if (names.has(t)) return true;
      if (keywords.some(k => t.includes(k))) return true;
      if (s.zipCodes && /(^|\D)\d{5}(\D|$)/.test(t)) return true;
      return false;
    };
  }

  function isShown(settings, tag) {
    const s = normalize(settings);
    if (s.mode === 'all') return true;
    const hit = matcher(s)(tag);
    return s.mode === 'include' ? hit : !hit;
  }

  function filterRows(settings, rows, key = 'tag') {
    const s = normalize(settings);
    if (s.mode === 'all') return rows;
    const match = matcher(s);
    return rows.filter(r => (s.mode === 'include') === match(r[key]));
  }

  function describe(settings) {
    const s = normalize(settings);
    if (s.mode === 'all') return 'All tags';
    const parts = [];
    if (s.tags.length) parts.push(`${s.tags.length} tag${s.tags.length === 1 ? '' : 's'}`);
    if (s.zipCodes) parts.push('zip codes');
    if (s.keywords.length) parts.push(s.keywords.map(k => `"${k}"`).join(', '));
    const what = parts.length ? parts.join(' + ') : 'nothing selected';
    return (s.mode === 'include' ? 'Only ' : 'Hiding ') + what;
  }

  const api = { MODES, LIMITS, normalize, matcher, isShown, filterRows, describe };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TagVisibility = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
