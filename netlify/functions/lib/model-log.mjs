// Model call log, ported from A2Z (pattern from Langfuse generations). One row per model HTTP call: provider, model, status, ms, tokens.
// Wraps fetch, so every agent and the failover transport are covered. Logging never blocks or fails a reply:
// rows are written after the response returns, errors are dropped, and the request waits at most 1 s at the end.
import { update } from './jarvis-memory.mjs';

export const MODEL_LOG_KEY = 'models/log';
const MAX_ROWS = 200, MAX_DAYS = 31;
const pacificDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' });
const emptyLog = () => ({ rows: [], days: {} });

function provider(url) {
  const host = new URL(url).hostname;
  if (host === 'api.groq.com') return 'groq';
  if (host === 'generativelanguage.googleapis.com') return 'gemini';
  if (host === 'api.cloudflare.com') return 'cloudflare';
  if (host === 'openrouter.ai') return 'openrouter';
  return null;
}

function requestModel(url, init) {
  try { const model = JSON.parse(init?.body || '{}').model; if (typeof model === 'string') return model.slice(0, 100); } catch { /* not JSON */ }
  return /\/models\/([^/:]+)/.exec(new URL(url).pathname)?.[1] || /\/run\/(.+)$/.exec(new URL(url).pathname)?.[1] || 'unknown';
}

function tokens(data) {
  const u = data?.usage || data?.result?.usage || {};
  const g = data?.usageMetadata || {};
  const n = v => (Number.isFinite(v) && v >= 0 ? v : 0);
  return { in: n(u.prompt_tokens ?? g.promptTokenCount), out: n(u.completion_tokens ?? g.candidatesTokenCount) };
}

export function addRow(log, row) {
  log.rows.unshift(row);
  log.rows.length = Math.min(log.rows.length, MAX_ROWS);
  const day = (log.days[row.day] ||= {});
  const m = (day[row.model] ||= { calls: 0, errors: 0, inTokens: 0, outTokens: 0, ms: 0 });
  m.calls++; if (!row.ok) m.errors++;
  m.inTokens += row.in; m.outTokens += row.out; m.ms += row.ms;
  for (const old of Object.keys(log.days).sort().slice(0, -MAX_DAYS)) delete log.days[old];
}

export function modelLogger({ openStore, now = () => Date.now() } = {}) {
  const queue = [];
  const parsing = new Set();
  let writing = null;
  async function drain() {
    while (queue.length) {
      const rows = queue.splice(0);
      try {
        const store = await openStore();
        await update(store, MODEL_LOG_KEY, emptyLog, log => { for (const row of rows) addRow(log, row); });
      } catch { /* The log is best effort. */ }
    }
  }
  const record = row => { if (!openStore) return; queue.push(row); writing ||= drain().finally(() => { writing = null; }); };
  return {
    wrap(fetchImpl) {
      return async (url, init) => {
        const name = provider(String(url));
        if (!name || String(init?.method || 'GET').toUpperCase() !== 'POST') return fetchImpl(url, init);
        const started = now();
        const model = requestModel(String(url), init);
        const base = { at: new Date(started).toISOString(), day: pacificDay.format(new Date(started)), provider: name, model };
        let response;
        try {
          response = await fetchImpl(url, init);
        } catch (error) {
          record({ ...base, ok: false, status: 0, ms: now() - started, in: 0, out: 0 });
          throw error;
        }
        const ms = now() - started;
        if (!response.ok) record({ ...base, ok: false, status: response.status, ms, in: 0, out: 0 });
        else {
          const parse = response.clone().json().then(data => record({ ...base, ok: true, status: response.status, ms, ...tokens(data) }))
            .catch(() => record({ ...base, ok: true, status: response.status, ms, in: 0, out: 0 }))
            .finally(() => parsing.delete(parse));
          parsing.add(parse);
        }
        return response;
      };
    },
    // Waits for pending rows, never longer than limitMs.
    flush(limitMs = 1000) {
      const pending = (async () => { await Promise.allSettled([...parsing]); while (writing) await writing; })();
      return Promise.race([pending, new Promise(resolve => setTimeout(resolve, limitMs).unref?.())]).catch(() => {});
    },
  };
}

// Totals for the JARVIS diagnostics view: today and the last 7 days, per model.
export function usageSummary(log, today = pacificDay.format(new Date())) {
  const days = Object.keys(log?.days || {}).sort().filter(day => day <= today).slice(-7);
  const sum = list => {
    const out = {};
    for (const day of list) for (const [model, m] of Object.entries(log.days[day] || {})) {
      const t = (out[model] ||= { calls: 0, errors: 0, inTokens: 0, outTokens: 0, ms: 0 });
      for (const k of Object.keys(t)) t[k] += m[k] || 0;
    }
    return Object.fromEntries(Object.entries(out).map(([model, t]) => [model, { calls: t.calls, errors: t.errors,
      inTokens: t.inTokens, outTokens: t.outTokens, avgMs: t.calls ? Math.round(t.ms / t.calls) : 0 }]));
  };
  return { today: sum(days.includes(today) ? [today] : []), last7Days: sum(days), recent: (log?.rows || []).slice(0, 20) };
}

// Estimated cost. Prices are not built in, because provider prices change and free tiers cost nothing.
// MODEL_PRICES = {"openai/gpt-oss-120b": [inUsdPerMillion, outUsdPerMillion], ...}. Unlisted models count as 0 (free tier assumed).
export function prices(env = process.env) {
  try {
    const parsed = JSON.parse(env.MODEL_PRICES || '{}');
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => Array.isArray(v) && v.length === 2 && v.every(n => Number.isFinite(n) && n >= 0)));
  } catch { return {}; }
}
export function withCosts(summary, env = process.env) {
  const table = prices(env);
  const cost = rows => Object.fromEntries(Object.entries(rows).map(([model, t]) => {
    const p = table[model];
    return [model, { ...t, estimatedUsd: p ? Number(((t.inTokens * p[0] + t.outTokens * p[1]) / 1e6).toFixed(4)) : 0, priced: Boolean(p) }];
  }));
  const total = rows => Number(Object.values(rows).reduce((sum, t) => sum + t.estimatedUsd, 0).toFixed(4));
  const today = cost(summary.today), last7Days = cost(summary.last7Days);
  return { ...summary, today, last7Days, estimatedUsd: { today: total(today), last7Days: total(last7Days) },
    pricing: Object.keys(table).length ? 'MODEL_PRICES' : 'No MODEL_PRICES set. All calls are counted as free tier ($0).' };
}
