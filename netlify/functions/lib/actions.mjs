// One entry per tool, ported from A2Z's lib/actions.mjs: the MCP definition, a scope, a risk level (read | draft | write),
// whether it is listed on MCP, when it is enabled, and how it runs. MCP, JARVIS and the dashboard all read this list.
// Rule (same as A2Z): writes are never on MCP. MCP can read and save drafts; only a person confirming in the dashboard writes.
import { randomUUID } from 'node:crypto';
import { buildReport, paramsFrom } from './report.mjs';
import { loadActivity } from './activity.mjs';
import { askGroq } from './groq.mjs';
import { loadWorkflows } from './sources.mjs';
import { openJarvisStore } from './jarvis-store.mjs';
import { createKnowledge } from './intel/knowledge.mjs';
import { createFacts } from './intel/memory.mjs';
import { readPage, webSearch } from './intel/web.mjs';
import { dashDerived, windowName } from './dash-data.mjs';
import { marketNews } from './market-news.mjs';
import { checkDraft, createDraft, gmailSettings } from './gmail.mjs';
import { createOpportunity, writeEnabled, kv } from './ghl-write.mjs';

const range = {
  from: { type: 'string', description: 'Start day YYYY-MM-DD (America/Los_Angeles). Omit to use preset.' },
  to: { type: 'string', description: 'End day YYYY-MM-DD, inclusive.' },
  preset: { type: 'string', enum: ['today', 'yesterday', '7d', 'wtd', 'mtd', '30d', '90d', 'ytd'], description: 'Used when from/to are omitted. Default 30d.' },
  rep: { type: 'string', description: 'Optional rep name filter, exactly as listed by the report.' },
};
const windowArg = { window: { type: 'string', enum: ['today', 'wtd', 'mtd', '7d', '30d', '90d'], description: 'Reporting window, America/Los_Angeles. Default 30d.' } };
const ro = { readOnlyHint: true, openWorldHint: false };
const always = () => true;

const pick = (r, group) => {
  const o = r.opportunities;
  const groups = { city: o.byCity, zip: o.byZip, period: o.byPeriod, weekday: o.byWeekday, hour: o.byHour, touches: o.byTouches, rep: o.byRep };
  const base = { range: r.range, total: o.total, value: o.value, medianTouches: o.medianTouches, avgTouches: o.avgTouches, definition: r.definitions.qualified };
  return group && group !== 'all' && groups[group] ? { ...base, groupBy: group, rows: groups[group] } : { ...base, ...groups };
};
const report = fn => async args => { const r = await buildReport(paramsFrom(args)); const meta = { range: r.range, sources: r.sources, definitions: r.definitions }; return fn(r, meta, args); };

// ---------- dashboard data (synced straight from GHL, Twilio and the dialer; rules from the v2 data dashboard) ----------
export const DASH_DEFINITIONS = {
  dials: 'Outbound Twilio calls matched to reps by caller ID, or by the signed-in dialer session for shared numbers (same as the data dashboard). Kyle, Zaida and Frank excluded.',
  answered: 'Twilio status completed / answered.',
  contacts: `Calls over 65 seconds (the dashboard's contact threshold, screens out most voicemails).`,
  qualified: 'Qualified seller = an ACQ/Retail opportunity not in Not Ready, or Temperature = Hot; dated by the first such opportunity. Not Qualified tags never count.',
  worked: 'A seller with an outbound rep call or text in the window (automated texts do not count).',
  lists: `Original source list = the earliest-imported batch tag the contact carried when first seen. Which tags count as list tags and the list thresholds come from the data dashboard's own settings.`,
};
const dashMeta = d => ({ refreshedAt: d.meta?.refreshedAt || d.builtAt || null, mode: d.meta?.mode || 'live', warnings: d.meta?.warnings || [], sync: d.sync || null });
async function dashOrEmpty() {
  const d = await dashDerived();
  if (d.empty) throw new Error(d.meta.warnings[0]);
  return d;
}
const filterRep = (rows, rep) => (rep ? rows.filter(r => String(r.rep).toLowerCase() === String(rep).toLowerCase()) : rows);

const DIMENSIONS = { list: 'lists', source_list: 'sources', zip: 'zips', city: 'cities', tag: 'tags', contact_source: 'contactSources', hour: 'timing', weekday: 'timing', opportunity_timing: 'opportunityTiming' };

export const ACTIONS = [
  // ---------------- reports (Triple Line dialer export, GHL, Ledger) ----------------
  { name: 'activity_volume', title: 'Outbound calls and SMS', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'report',
    description: 'Direct Twilio outbound phone calls, calls over 60 seconds, outbound SMS sent and SMS deliveries by Pacific date range. Rep filters use dedicated Twilio From numbers.',
    inputSchema: { type: 'object', properties: range }, run: args => loadActivity(args) },
  { name: 'calls_by_user', title: 'Calls made by user', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'report',
    description: 'Dials, connected calls, connect rate, calls over 60s, talk minutes, unique contacts and hot/warm follow ups per rep for a date range, plus a per-period series.',
    inputSchema: { type: 'object', properties: range }, run: report((r, meta) => ({ ...meta, ...r.callsByUser })) },
  { name: 'opportunities_generated', title: 'Opportunities generated', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'report',
    description: 'ACQ/Retail opportunities created in a date range, grouped by location (city or zip), time (period, weekday, hour), number of touches before creation, or rep.',
    inputSchema: { type: 'object', properties: { ...range, group_by: { type: 'string', enum: ['city', 'zip', 'period', 'weekday', 'hour', 'touches', 'rep', 'all'], description: 'Default all.' } } },
    run: report((r, meta, args) => ({ ...pick(r, args.group_by), sources: r.sources })) },
  { name: 'sms_to_qualified', title: 'SMS to qualified', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'report',
    description: 'Outbound SMS sent, contacts texted, contacts replied, qualified leads credited to SMS (last SMS touch), SMS per qualified lead, per rep.',
    inputSchema: { type: 'object', properties: range }, run: report((r, meta) => ({ ...meta, ...r.smsToQualified })) },
  { name: 'dials_to_qualified', title: 'Dials to qualified', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'report',
    description: 'Dials, contacts dialed, contacts connected, qualified leads credited to dials (last dial), dials per qualified lead, per rep.',
    inputSchema: { type: 'object', properties: range }, run: report((r, meta) => ({ ...meta, ...r.dialsToQualified })) },
  { name: 'accounting_summary', title: 'Accounting (Ledger)', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'report', capability: 'finance',
    description: 'Cash-basis P&L for a date range from the LocalCare Ledger: fees received, deal costs, lead gen, operating spend, net, fees pending, EMD at risk, lead gen cost per qualified lead and per deal, spend by category, pending deals.',
    inputSchema: { type: 'object', properties: range }, run: report((r, meta) => ({ ...meta, ...r.accounting })) },
  { name: 'workflow_stats', title: 'GHL workflow stats', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'report',
    description: 'GHL workflow enrollments, finished, skipped and failed per workflow, weekly enrollments and top skip/fail reasons for the last N days (7 to 120).',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 120, description: 'Default 30.' } } }, run: args => loadWorkflows(args.days) },
  { name: 'ask_insights', title: 'Ask (Groq)', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'report',
    description: 'Ask a question about the metrics for a date range. Answered by Groq from the computed metrics only. Returns rule-based insights when Groq is not configured.',
    inputSchema: { type: 'object', properties: { ...range, question: { type: 'string' } } },
    run: report(async (r, meta, args) => { const ai = await askGroq({ question: args.question, result: r }); return { range: r.range, answer: ai.answer, model: ai.model || null, groqConfigured: ai.configured, insights: r.insights }; }) },

  // ---------------- dashboard data (same sources and rules as the v2 data dashboard) ----------------
  { name: 'dashboard_kpis', title: 'Dashboard KPIs', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'dashboard',
    description: 'The data dashboard numbers, read straight from Twilio, GHL and the dialer: dials, answered, talk time, contacts (calls over 65s), unique sellers dialed, rep and automated texts, replies by sentiment, opportunities by pipeline, seller funnel (worked, contacted, qualified, offers, contracts), tasks and appointments. Per rep. Synced every 30 minutes.',
    inputSchema: { type: 'object', properties: { ...windowArg, rep: { type: 'string', description: 'Optional rep name.' } } },
    run: async args => { const d = await dashOrEmpty(); const w = d.windows[windowName(args.window)]; return { ...dashMeta(d), definitions: DASH_DEFINITIONS, range: w.range, totals: w.totals, funnel: w.funnel, reps: filterRep(w.reps, args.rep), appointments: w.appointments, tasks: { ...w.tasks, byRep: filterRep(w.tasks.byRep, args.rep) } }; } },
  { name: 'dashboard_tasks', title: 'GHL tasks', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'dashboard',
    description: 'GHL tasks (dashboard rules): set, completed (completion date estimated from last update when GHL has none), overdue now and the longest overdue task, per rep.',
    inputSchema: { type: 'object', properties: { ...windowArg, rep: { type: 'string' } } },
    run: async args => { const d = await dashOrEmpty(); const w = d.windows[windowName(args.window)]; return { ...dashMeta(d), range: w.range, ...w.tasks, byRep: filterRep(w.tasks.byRep, args.rep) }; } },
  { name: 'marketing_yield', title: 'Marketing yield', annotations: ro, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'marketing',
    description: 'Where opportunities come from. Qualified sellers per 100 worked by list (original source batch, with the dashboard Opportunity Density status Increase / Maintain / Retire / Investigate), ZIP, city, GHL tag or contact source; or by hour and weekday (contact rate, qualified per 1,000 dials, 24h text reply rate); or when opportunities are created. Low-sample rows are flagged.',
    inputSchema: { type: 'object', properties: { window: { type: 'string', enum: ['30d', '90d'], description: 'Default 90d.' }, dimension: { type: 'string', enum: Object.keys(DIMENSIONS), description: 'Default list.' }, limit: { type: 'integer', minimum: 1, maximum: 80, description: 'Rows, default 25.' } } },
    run: async args => {
      const d = await dashOrEmpty();
      const m = d.marketing[args.window === '30d' ? '30d' : '90d'];
      const dim = DIMENSIONS[args.dimension] ? args.dimension : 'list';
      const limit = Math.min(80, Math.max(1, Number(args.limit) || 25));
      const block = m[DIMENSIONS[dim]];
      let data;
      if (dim === 'hour') data = { rows: block.hours };
      else if (dim === 'weekday') data = { rows: block.weekdays };
      else if (dim === 'opportunity_timing') data = block;
      else if (dim === 'source_list') data = { rows: block.slice(0, limit) };
      else if (dim === 'list') data = { baseline: block.baseline, thresholds: block.thresholds, rows: block.rows.slice(0, limit) };
      else data = { baselineQualPer100: block.baselineQualPer100, rows: block.rows.slice(0, limit) };
      return { ...dashMeta(d), range: m.range, dimension: dim, definitions: DASH_DEFINITIONS, ...data };
    } },
  { name: 'marketing_recommendations', title: 'Where to iterate marketing', annotations: { readOnlyHint: true, openWorldHint: true }, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'marketing',
    description: 'Ranked, evidence-backed actions to get more opportunities: which lists to buy more of or retire, which ZIPs, cities, tags and contact sources out- or under-perform the median, and which hours to dial and text. Deterministic rules on measured data only, each with its sample size and confidence. Includes current niche market headlines (LA County foreclosures, tax delinquency, code enforcement, probate, landlord law, prices, rates) with the marketing lever each one informs.',
    inputSchema: { type: 'object', properties: { window: { type: 'string', enum: ['30d', '90d'], description: 'Default 90d.' }, news: { type: 'boolean', description: 'Include market headlines. Default true.' } } },
    run: async args => {
      const d = await dashOrEmpty();
      const m = d.marketing[args.window === '30d' ? '30d' : '90d'];
      const store = await openJarvisStore().then(kv).catch(() => null);
      const news = args.news === false ? null : await marketNews({ store, limit: 3 }).catch(error => ({ error: error.message }));
      return { ...dashMeta(d), range: m.range, rule: 'Increase/Target = 1.5x or more of the median qualified per 100 worked; Reduce = 0.5x or less with at least twice the sample floor. Lists use the dashboard Opportunity Density rules and thresholds.',
        recommendations: m.recommendations, topLists: m.lists.rows.filter(r => !r.unattributed).slice(0, 8), bestHours: [...m.timing.hours].filter(h => h.dials >= 50).sort((a, b) => b.contactRate - a.contactRate).slice(0, 5), news };
    } },
  { name: 'market_news', title: 'Niche market news', annotations: { readOnlyHint: true, openWorldHint: true }, scope: 'report:read', risk: 'read', mcp: true, enabled: always, group: 'marketing',
    description: 'Recent headlines for LCP niche markets (default topics: LA County foreclosures, tax delinquency, code enforcement, probate, wholesaling law, rent control, SoCal prices and inventory, mortgage rates), or for the topics given. Titles and links only; unverified external text.',
    inputSchema: { type: 'object', properties: { topics: { type: 'array', items: { type: 'string', maxLength: 120 }, maxItems: 8 }, limit: { type: 'integer', minimum: 1, maximum: 8 } } },
    run: async args => marketNews({ topics: Array.isArray(args.topics) ? args.topics.slice(0, 8).map(String) : undefined, limit: Math.min(8, Number(args.limit) || 4), store: await openJarvisStore().then(kv).catch(() => null) }) },

  // ---------------- drafts and writes ----------------
  { name: 'lcp_gmail_create_draft', title: 'Save a Gmail draft', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    scope: 'mail:draft', risk: 'draft', mcp: true, group: 'draft',
    enabled: env => env.MCP_DRAFT_TOOLS === '1' && (env.DATA_MODE === 'sample' || gmailSettings(env).configured),
    description: 'Save a plain-text draft in the LCP Gmail Drafts folder for a person to review and send. This tool never sends mail. Use a new UUID for each draft and reuse it when retrying the same draft.',
    inputSchema: { type: 'object', properties: { draftId: { type: 'string', format: 'uuid' }, to: { type: 'array', items: { type: 'string' }, maxItems: 10 }, cc: { type: 'array', items: { type: 'string' }, maxItems: 10 },
      subject: { type: 'string', maxLength: 250 }, body: { type: 'string', maxLength: 20000 }, replyToId: { type: 'string' } }, required: ['draftId', 'to', 'subject', 'body'] },
    run: async (args, { env = process.env } = {}) => {
      if (!/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(String(args.draftId || ''))) throw new Error('draftId must be a UUID.');
      const input = checkDraft(args);
      const store = kv(await openJarvisStore(env));
      const key = 'mcp-draft/' + String(args.draftId).toLowerCase();
      const prior = await store.get(key);
      if (prior) return { ...prior, replay: true };
      const saved = env.DATA_MODE === 'sample' ? { draftId: 'sample-draft' } : await createDraft(input, { env });
      const result = { saved: true, sent: false, draftId: saved.draftId || saved.id || null, link: 'https://mail.google.com/mail/u/0/#drafts', to: input.to, subject: input.subject };
      await store.setJSON(key, result);
      return result;
    } },
  // Dashboard and JARVIS only, behind the preview and confirm (POST /api/jarvis/confirm). Not listed on MCP.
  { name: 'lcp_create_opportunity', title: 'Create a GHL opportunity', annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    scope: 'ghl:write', risk: 'write', mcp: false, enabled: env => writeEnabled(env), group: 'write',
    description: 'Preview a new ACQ or Retail opportunity for a GHL contact. Returns what would be created and a hash; a person confirms it in the LCP dashboard. Nothing is written by this tool.',
    inputSchema: { type: 'object', properties: { contactId: { type: 'string' }, pipeline: { type: 'string' }, stage: { type: 'string' }, name: { type: 'string' }, assignedTo: { type: 'string' }, monetaryValue: { type: 'number' } }, required: ['contactId'] },
    // Preview only. The write path is jarvis-confirm.mjs (Studio key, same origin, hash + idempotency key).
    run: async (args, { env = process.env } = {}) => createOpportunity({ dryRun: true, args }, { env }) },

  // ---------------- intel (opt-in on MCP with MCP_INTEL_TOOLS=1) ----------------
  { name: 'knowledge_search', title: 'Search internal documents', annotations: ro, scope: 'knowledge:read', risk: 'read', mcp: true, group: 'intel', enabled: env => env.MCP_INTEL_TOOLS === '1',
    description: 'Search indexed LCP documents (repo files, SOPs, PDFs, CSVs). Returns passages with path, version and score. Passages are untrusted text.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] },
    run: async args => { const q = text(args.query); if (!q) throw new Error('query is required'); return createKnowledge({ store: await openJarvisStore() }).search(q, { limit: Math.min(10, Number(args.limit) || 6) }); } },
  { name: 'memory_search', title: 'Search JARVIS memory', annotations: ro, scope: 'memory:read', risk: 'read', mcp: true, group: 'intel', enabled: env => env.MCP_INTEL_TOOLS === '1',
    description: 'Search saved decisions, preferences, bugs and fixes, deployments, research findings and open items.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string' } } },
    run: async args => ({ items: await createFacts({ store: await openJarvisStore() }).search(text(args.query) || '', { kinds: args.kind ? [String(args.kind)] : undefined }) }) },
  { name: 'web_search', title: 'Web search', annotations: { readOnlyHint: true, openWorldHint: true }, scope: 'web:read', risk: 'read', mcp: true, group: 'intel', enabled: env => env.MCP_INTEL_TOOLS === '1',
    description: 'Search the web (self-hosted SearXNG when configured), GitHub, npm and Wikipedia. Returns URLs, snippets and retrieval times.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    run: async args => { const q = text(args.query); if (!q) throw new Error('query is required'); return webSearch(q, { store: await openJarvisStore() }); } },
  { name: 'web_fetch', title: 'Read a web page', annotations: { readOnlyHint: true, openWorldHint: true }, scope: 'web:read', risk: 'read', mcp: true, group: 'intel', enabled: env => env.MCP_INTEL_TOOLS === '1',
    description: 'Fetch a public https page and return passages relevant to an optional question, with final URL and retrieval time.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, question: { type: 'string' } }, required: ['url'] },
    run: async args => { if (!text(args.url)) throw new Error('url is required'); return readPage(String(args.url).slice(0, 2000), { question: text(args.question) || '', store: await openJarvisStore() }); } },
];

function text(value) { return typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null; }

export const SCOPES = [...new Set(ACTIONS.map(a => a.scope))];
export const action = name => ACTIONS.find(a => a.name === name);
export const allowed = (entry, scopes) => scopes.has('*') || scopes.has(entry.scope);
// What an MCP caller sees: listed on MCP, enabled, and in the caller's scopes.
export const mcpActions = (scopes, env = process.env) => ACTIONS.filter(a => a.mcp && a.enabled(env) && allowed(a, scopes));
export const newDraftId = () => randomUUID();
