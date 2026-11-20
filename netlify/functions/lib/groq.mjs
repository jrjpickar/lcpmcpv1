// Minimal Groq use: one chat completion over a compact JSON summary of the metrics.
// The model only sees aggregates (no names, phones or message bodies).
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_MODEL = 'openai/gpt-oss-20b';

// Compact, aggregate-only context (about 1.5k tokens). Arrays are [key, value] pairs to save tokens.
export function compactForModel(r) {
  const kv = (rows, k = 'count', n = 8) => (rows || []).slice(0, n).map(x => [x.key, x[k]]);
  const g = r.signals || {};
  const chan = c => ({ touches: c.touches, contacts: c.contactsTouched, engaged: c.engaged, qualified: c.qualified, perQualified: c.perQualified, contactRate: c.contactRate,
    byRep: (c.byRep || []).slice(0, 8).map(x => [x.rep, x.touches, x.qualified, x.perQualified]) });
  return {
    range: { from: r.range.from, to: r.range.to, days: r.range.days, rep: r.range.rep }, kpis: r.kpis, previousKpis: r.previous ? r.previous.kpis : null,
    reps: r.callsByUser.rows.slice(0, 10).map(x => [x.rep, x.dials, x.connectRate, Math.round(x.talkMinutes), x.over60, x.hot, x.qualPer100Conv]),
    repColumns: ['rep', 'dials', 'connectRate', 'talkMin', 'calls60s', 'hot', 'qualPer100Conv'],
    callOutcomes: kv(r.callsByUser.totals.outcomes),
    opportunities: { total: r.opportunities.total, value: r.opportunities.value, medianTouches: r.opportunities.medianTouches, byCity: kv(r.opportunities.byCity, 'count', 6), byTouches: kv(r.opportunities.byTouches, 'count', 6), byWeekday: kv(r.opportunities.byWeekday, 'count', 7) },
    sms: chan(r.smsToQualified), dials: chan(r.dialsToQualified),
    signals: g.speedToLead ? {
      speedToLead: { medianMin: g.speedToLead.medianMinutes, within5: g.speedToLead.within5, unanswered: g.speedToLead.unanswered },
      hotRepliesWaiting: g.hotReplies.waiting, replyQuality: { positive: g.replyQuality.positiveRate, negative: g.replyQuality.negativeRate, optOutRate: g.replyQuality.optOutRate },
      droppedEarly: { count: g.droppedEarly.count, byRep: kv(g.droppedEarly.byRep, 'count', 4), byList: kv(g.droppedEarly.byList, 'count', 4) },
      followUps: { hotOnTime: g.followUps.hot.rate, warmOnTime: g.followUps.warm.rate, hotOverdue: g.followUps.hot.overdue, hotToOpp: g.followUps.hotToOpp.rate },
      callerIdsFlagged: g.callerIds.filter(c => c.flagged).map(c => [c.number.slice(-4), c.rep, c.connectRate, c.baselineRate]),
      listsDecaying: g.lists.filter(l => l.decaying).map(l => [l.list, l.badRecent, l.badPrior]),
      stageAging: { open: g.stageAging.open, stuck: g.stageAging.stuck, stuckDays: g.stageAging.stuckDays, verbalToContract: g.stageAging.verbalToContract },
    } : null,
    accounting: r.accounting && r.accounting.connected ? { fees: r.accounting.revenue, net: r.accounting.net, leadGen: r.accounting.leadGen, pending: r.accounting.feesPending, leadGenPerQualified: r.accounting.leadGenPerQualified } : null,
    alerts: (r.alerts || []).map(a => a.title), ruleBasedInsights: r.insights,
  };
}

const SYSTEM = [
  'You are the analyst for LocalCare Props, a real estate wholesaler. Reps dial and text sellers; qualified leads become ACQ or Retail opportunities.',
  'Answer ONLY from the JSON metrics provided. If the data cannot answer, say what is missing.',
  'Lead with the answer. Use numbers. Max 120 words unless asked for more. Plain sentences or short bullets.',
  'Never use em dashes or en dashes. Do not invent reps, places or figures.',
].join(' ');

// Same question on the same data within 10 minutes reuses the last answer (no new tokens).
const answers = new Map();
export async function askGroq({ question, result, fetchImpl = fetch }) {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { configured: false, answer: null };
  const q = String(question || '').trim().slice(0, 600) || 'Give the 3 most important insights and 1 recommended action for this range.';
  const model = process.env.GROQ_MODEL || DEFAULT_MODEL;
  const context = JSON.stringify(compactForModel(result));
  const cacheKey = JSON.stringify([model, q.toLowerCase(), context]);
  const hit = answers.get(cacheKey);
  if (hit && Date.now() - hit.at < 600000) return { ...hit.value, cached: true };
  const reasoning = model.startsWith('openai/gpt-oss-');
  const res = await fetchImpl(GROQ_URL, {
    method: 'POST', signal: AbortSignal.timeout(Math.min(60000, Math.max(1000, Number(process.env.MODEL_TIMEOUT_MS) || 7000))), // under Netlify's 10 s limit
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model, temperature: 0.2,
      max_completion_tokens: Number(process.env.GROQ_MAX_TOKENS) || (reasoning ? 850 : 350),
      ...(reasoning ? { reasoning_effort: 'low' } : {}),
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: `Metrics JSON:\n${context}\n\nQuestion: ${q}` }],
    }),
  });
  if (!res.ok) throw Object.assign(new Error(`Groq request failed (HTTP ${res.status})`), { status: 502 });
  const payload = await res.json();
  const answer = String(payload.choices?.[0]?.message?.content || '').replace(/[–—]/g, '-').trim();
  if (!answer) throw Object.assign(new Error('Groq returned no answer.'), { status: 502 });
  const value = { configured: true, model: payload.model || model, answer, usage: payload.usage || null };
  answers.set(cacheKey, { at: Date.now(), value });
  if (answers.size > 50) answers.delete(answers.keys().next().value);
  return value;
}
