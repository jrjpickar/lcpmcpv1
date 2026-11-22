// Shared task context for every model in a task. One compact object instead of full chats and documents:
//   objective, constraints, live data (L), internal docs (K), memory (M), web (W), tools, prior results, findings, outstanding, verification.
// Each section has a character budget (about 4 characters per token). Passages are compressed to the sentences that match
// the objective; ids and URLs are never dropped. Specialists add findings; later models see them without the raw material.
import { approxTokens, bestSentences, clip, sha256 } from './text.mjs';
import { UNTRUSTED_RULE } from './safety.mjs';

export const BUDGETS = { constraints: 700, memory: 1600, internal: 3200, web: 3200, live: 3000, tools: 700, prior: 1200, findings: 1600, outstanding: 500 };
const compiled = new Map();

export function createTaskContext({ objective, constraints = [], taskClass = 'general', budgets = {} }) {
  const limits = { ...BUDGETS, ...budgets };
  const ctx = { objective: clip(objective, 1500), taskClass, constraints: [...constraints], sources: [], live: [], internal: [], memory: [], web: [], tools: [], prior: [], findings: [], outstanding: [], verification: { status: 'unverified', checks: [] } };
  const counters = { L: 0, K: 0, M: 0, W: 0 };
  const cite = (prefix, source) => {
    const existing = ctx.sources.find(item => item.type === source.type && item.ref === source.ref);
    if (existing) return existing.id;
    const id = prefix + (++counters[prefix]);
    ctx.sources.push({ id, ...source });
    return id;
  };

  return {
    ctx,
    addLive(name, data, { retrievedAt = new Date().toISOString(), authoritative = true } = {}) {
      const id = cite('L', { type: 'live', ref: name, title: name, retrievedAt, authoritative });
      ctx.live.push({ id, name, data });
      return id;
    },
    addInternal(results) {
      for (const r of results) ctx.internal.push({ id: cite('K', { type: 'internal', ref: r.scope + ':' + r.path, title: r.title || r.path, path: r.path, scope: r.scope, version: r.version, updatedAt: r.updatedAt }), heading: r.heading, text: r.text, score: r.score });
    },
    addMemory(items) {
      for (const m of items) ctx.memory.push({ id: cite('M', { type: 'memory', ref: m.id, title: m.kind + ': ' + clip(m.text, 60), kind: m.kind, scope: m.scope, updatedAt: m.updatedAt }), kind: m.kind, text: m.text, status: m.status });
    },
    addWeb(findings) {
      for (const f of findings) ctx.web.push({ id: cite('W', { type: 'web', ref: f.url, title: f.title, url: f.url, retrievedAt: f.retrievedAt }), text: f.text, kind: f.kind });
    },
    addTools(tools) { ctx.tools = tools.map(t => ({ name: t.name, capability: t.capability, risk: t.risk, available: t.available })); },
    addPrior(results) { ctx.prior.push(...results.map(r => clip(typeof r === 'string' ? r : JSON.stringify(r), 400))); },
    addFinding(finding) { ctx.findings.push({ by: finding.by, text: clip(finding.text, 600), sources: finding.sources || [], confidence: finding.confidence || 'medium' }); },
    addOutstanding(item) { ctx.outstanding.push(clip(item, 200)); },
    setVerification(verification) { ctx.verification = verification; },

    // What a model sees. Retrieved material sits inside <evidence> as data. Cached by content hash.
    forModel({ include = ['constraints', 'live', 'internal', 'memory', 'web', 'tools', 'prior', 'findings', 'outstanding'] } = {}) {
      const key = sha256(JSON.stringify([ctx.objective, include, ctx.live, ctx.internal, ctx.memory, ctx.web, ctx.findings, ctx.prior, ctx.outstanding]));
      if (compiled.has(key)) return compiled.get(key);
      const fit = (items, budget, render) => {
        const out = [];
        let used = 0;
        for (const item of items) {
          const text = render(item, Math.max(160, Math.floor(budget / Math.max(1, items.length))));
          if (used + text.length > budget) break;
          out.push(text); used += text.length;
        }
        return out;
      };
      const q = ctx.objective;
      const sections = {};
      if (include.includes('constraints')) sections.constraints = fit([...new Set(ctx.constraints)], limits.constraints, c => clip(c, 200));
      if (include.includes('live') && ctx.live.length) sections.liveData = fit(ctx.live, limits.live, (item, share) => '[' + item.id + '] ' + item.name + ': ' + clip(JSON.stringify(item.data), share));
      if (include.includes('internal') && ctx.internal.length) sections.internalDocs = fit(ctx.internal, limits.internal, (item, share) => '[' + item.id + '] ' + (item.heading ? item.heading + ': ' : '') + bestSentences(item.text, q, share));
      if (include.includes('memory') && ctx.memory.length) sections.memory = fit(ctx.memory, limits.memory, (item, share) => '[' + item.id + '] (' + item.kind + (item.status ? ', ' + item.status : '') + ') ' + clip(item.text, share));
      if (include.includes('web') && ctx.web.length) sections.web = fit(ctx.web, limits.web, (item, share) => '[' + item.id + '] ' + bestSentences(item.text, q, share));
      if (include.includes('tools') && ctx.tools.length) sections.tools = fit(ctx.tools.filter(t => t.available), limits.tools, t => t.name + ' (' + t.risk + ')');
      if (include.includes('prior') && ctx.prior.length) sections.prior = fit(ctx.prior.slice(-6), limits.prior, p => p);
      if (include.includes('findings') && ctx.findings.length) sections.findings = fit(ctx.findings, limits.findings, f => f.by + ': ' + f.text + (f.sources.length ? ' ' + f.sources.map(s => '[' + s + ']').join('') : ''));
      if (include.includes('outstanding') && ctx.outstanding.length) sections.outstanding = fit(ctx.outstanding, limits.outstanding, o => o);
      const evidenceKeys = ['liveData', 'internalDocs', 'memory', 'web', 'findings', 'prior'];
      const evidence = Object.fromEntries(evidenceKeys.filter(k => sections[k]?.length).map(k => [k, sections[k]]));
      const value = {
        objective: ctx.objective, taskClass: ctx.taskClass,
        constraints: sections.constraints || [], tools: sections.tools || [], outstanding: sections.outstanding || [],
        rule: UNTRUSTED_RULE,
        evidence: '<evidence>\n' + JSON.stringify(evidence) + '\n</evidence>',
        citations: ctx.sources.map(({ id, type, title, url, path }) => ({ id, type, title: clip(title, 80), ...(url ? { url } : {}), ...(path ? { path } : {}) })),
      };
      value.tokens = approxTokens(JSON.stringify(value));
      compiled.set(key, value);
      if (compiled.size > 100) compiled.delete(compiled.keys().next().value);
      return value;
    },
  };
}

// Where an answer came from: the citation ids it actually uses, grouped by source type. No citations = model reasoning.
export function provenance(answer, sources) {
  const used = new Set([...String(answer || '').matchAll(/\[([LKMW]\d{1,3})\]/g)].map(m => m[1]));
  const cited = sources.filter(source => used.has(source.id));
  const unknown = [...used].filter(id => !sources.some(source => source.id === id));
  const types = [...new Set(cited.map(source => source.type))];
  return { types: types.length ? types : ['model'], cited, unknownCitations: unknown, modelOnly: !cited.length };
}
