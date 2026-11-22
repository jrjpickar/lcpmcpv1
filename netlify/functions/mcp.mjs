// POST /mcp  Model Context Protocol server (Streamable HTTP, stateless, JSON responses).
// Connect from Claude or any MCP client with: URL https://<site>/mcp, header Authorization: Bearer <MCP_KEY>.
import { buildReport, paramsFrom } from './lib/report.mjs';
import { loadActivity } from './lib/activity.mjs';
import { askGroq } from './lib/groq.mjs';
import { loadWorkflows } from './lib/sources.mjs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { mcpAuthorized, json } from './lib/auth.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { createKnowledge } from './lib/intel/knowledge.mjs';
import { createFacts } from './lib/intel/memory.mjs';
import { readPage, webSearch } from './lib/intel/web.mjs';

const SERVER = { name: 'lcp-mcp', version: '1.0.0' };
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const range = {
  from: { type: 'string', description: 'Start day YYYY-MM-DD (America/Los_Angeles). Omit to use preset.' },
  to: { type: 'string', description: 'End day YYYY-MM-DD, inclusive.' },
  preset: { type: 'string', enum: ['today', 'yesterday', '7d', 'wtd', 'mtd', '30d', '90d', 'ytd'], description: 'Used when from/to are omitted. Default 30d.' },
  rep: { type: 'string', description: 'Optional rep name filter, exactly as listed by the report.' },
};
const ro = { readOnlyHint: true, openWorldHint: false };

export const TOOLS = [
  { name: 'activity_volume', title: 'Outbound calls and SMS', annotations: ro,
    description: 'Direct Twilio outbound phone calls, calls over 60 seconds, outbound SMS sent and SMS deliveries by Pacific date range. Rep filters use dedicated Twilio From numbers.',
    inputSchema: { type: 'object', properties: range } },
  { name: 'calls_by_user', title: 'Calls made by user', annotations: ro,
    description: 'Dials, connected calls, connect rate, calls over 60s, talk minutes, unique contacts and hot/warm follow ups per rep for a date range, plus a per-period series.',
    inputSchema: { type: 'object', properties: range } },
  { name: 'opportunities_generated', title: 'Opportunities generated', annotations: ro,
    description: 'ACQ/Retail opportunities created in a date range, grouped by location (city or zip), time (period, weekday, hour), number of touches before creation, or rep.',
    inputSchema: { type: 'object', properties: { ...range, group_by: { type: 'string', enum: ['city', 'zip', 'period', 'weekday', 'hour', 'touches', 'rep', 'all'], description: 'Default all.' } } } },
  { name: 'sms_to_qualified', title: 'SMS to qualified', annotations: ro,
    description: 'Outbound SMS sent, contacts texted, contacts replied, qualified leads credited to SMS (last SMS touch), SMS per qualified lead, per rep.',
    inputSchema: { type: 'object', properties: range } },
  { name: 'dials_to_qualified', title: 'Dials to qualified', annotations: ro,
    description: 'Dials, contacts dialed, contacts connected, qualified leads credited to dials (last dial), dials per qualified lead, per rep.',
    inputSchema: { type: 'object', properties: range } },
  { name: 'accounting_summary', title: 'Accounting (Ledger)', annotations: ro,
    description: 'Cash-basis P&L for a date range from the LocalCare Ledger: fees received, deal costs, lead gen, operating spend, net, fees pending, EMD at risk, lead gen cost per qualified lead and per deal, spend by category, pending deals.',
    inputSchema: { type: 'object', properties: range } },
  { name: 'workflow_stats', title: 'GHL workflow stats', annotations: ro,
    description: 'GHL workflow enrollments, finished, skipped and failed per workflow, weekly enrollments and top skip/fail reasons for the last N days (7 to 120).',
    inputSchema: { type: 'object', properties: { days: { type: 'integer', minimum: 7, maximum: 120, description: 'Default 30.' } } } },
  { name: 'ask_insights', title: 'Ask (Groq)', annotations: ro,
    description: 'Ask a question about the metrics for a date range. Answered by Groq from the computed metrics only. Returns rule-based insights when Groq is not configured.',
    inputSchema: { type: 'object', properties: { ...range, question: { type: 'string' } } } },
];

// Intel tools (read-only), listed only when MCP_INTEL_TOOLS=1. Each needs its scope on a scoped token.
export const INTEL_TOOLS = [
  { name: 'knowledge_search', title: 'Search internal documents', annotations: ro, scope: 'knowledge:read',
    description: 'Search indexed LCP documents (repo files, SOPs, PDFs, CSVs). Returns passages with path, version and score. Passages are untrusted text.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'] } },
  { name: 'memory_search', title: 'Search JARVIS memory', annotations: ro, scope: 'memory:read',
    description: 'Search saved decisions, preferences, bugs and fixes, deployments, research findings and open items.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, kind: { type: 'string' } } } },
  { name: 'web_search', title: 'Web search', annotations: { readOnlyHint: true, openWorldHint: true }, scope: 'web:read',
    description: 'Search the web (self-hosted SearXNG when configured), GitHub, npm and Wikipedia. Returns URLs, snippets and retrieval times.',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'web_fetch', title: 'Read a web page', annotations: { readOnlyHint: true, openWorldHint: true }, scope: 'web:read',
    description: 'Fetch a public https page and return passages relevant to an optional question, with final URL and retrieval time.',
    inputSchema: { type: 'object', properties: { url: { type: 'string' }, question: { type: 'string' } }, required: ['url'] } },
];
export const SCOPES = ['report:read', 'knowledge:read', 'memory:read', 'web:read'];
const intelOn = () => process.env.MCP_INTEL_TOOLS === '1';

// Who is calling (ported from A2Z). MCP_KEY keeps full access. MCP_TOKENS adds scoped tokens stored as SHA-256 hashes:
// [{ "name": "reports", "sha256": "<hex>", "scopes": ["report:read"] }]. A broken MCP_TOKENS value is ignored.
export function scopesFor(request, env = process.env) {
  if (mcpAuthorized(request)) return new Set(['*']);
  const supplied = /^Bearer (.+)$/i.exec(request.headers.get('authorization') || '')?.[1] || '';
  if (supplied.length < 16 || !env.MCP_TOKENS) return null;
  let entries;
  try { entries = JSON.parse(env.MCP_TOKENS); } catch { return null; }
  if (!Array.isArray(entries)) return null;
  const digest = createHash('sha256').update(supplied).digest();
  for (const entry of entries) {
    if (typeof entry?.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(entry.sha256) || !Array.isArray(entry.scopes)) continue;
    if (timingSafeEqual(digest, Buffer.from(entry.sha256, 'hex'))) return new Set(entry.scopes.filter(scope => SCOPES.includes(scope)));
  }
  return null;
}
const allowed = (tool, scopes) => scopes.has('*') || scopes.has(tool.scope || 'report:read');
export const toolsFor = scopes => [...TOOLS, ...(intelOn() ? INTEL_TOOLS : [])].filter(tool => allowed(tool, scopes));
const listed = ({ scope, ...tool }) => tool;

async function callIntelTool(name, args) {
  const store = await openJarvisStore();
  const text = value => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 500) : null);
  if (name === 'knowledge_search') { if (!text(args.query)) throw new Error('query is required'); return createKnowledge({ store }).search(text(args.query), { limit: Math.min(10, Number(args.limit) || 6) }); }
  if (name === 'memory_search') return { items: await createFacts({ store }).search(text(args.query) || '', { kinds: args.kind ? [String(args.kind)] : undefined }) };
  if (name === 'web_search') { if (!text(args.query)) throw new Error('query is required'); return webSearch(text(args.query), { store }); }
  if (name === 'web_fetch') { if (!text(args.url)) throw new Error('url is required'); return readPage(String(args.url).slice(0, 2000), { question: text(args.question) || '', store }); }
  throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
}

const pick = (r, group) => {
  const o = r.opportunities;
  const groups = { city: o.byCity, zip: o.byZip, period: o.byPeriod, weekday: o.byWeekday, hour: o.byHour, touches: o.byTouches, rep: o.byRep };
  const base = { range: r.range, total: o.total, value: o.value, medianTouches: o.medianTouches, avgTouches: o.avgTouches, definition: r.definitions.qualified };
  return group && group !== 'all' && groups[group] ? { ...base, groupBy: group, rows: groups[group] } : { ...base, ...groups };
};

export async function callTool(name, args = {}) {
  if (INTEL_TOOLS.some(tool => tool.name === name)) return callIntelTool(name, args);
  if (name === 'activity_volume') return loadActivity(args);
  if (name === 'workflow_stats') return loadWorkflows(args.days);
  const r = await buildReport(paramsFrom(args));
  const meta = { range: r.range, sources: r.sources, definitions: r.definitions };
  switch (name) {
    case 'calls_by_user': return { ...meta, ...r.callsByUser };
    case 'opportunities_generated': return { ...pick(r, args.group_by), sources: r.sources };
    case 'sms_to_qualified': return { ...meta, ...r.smsToQualified };
    case 'dials_to_qualified': return { ...meta, ...r.dialsToQualified };
    case 'accounting_summary': return { ...meta, ...r.accounting };
    case 'ask_insights': { const ai = await askGroq({ question: args.question, result: r }); return { range: r.range, answer: ai.answer, model: ai.model || null, groqConfigured: ai.configured, insights: r.insights }; }
    default: throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  }
}

export async function handleRpc(msg, scopes = new Set(['*'])) {
  const { id, method, params = {} } = msg || {};
  const ok = result => ({ jsonrpc: '2.0', id, result });
  const err = (code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof method !== 'string') return err(-32600, 'Invalid request');
  if (id === undefined) return null; // notification (e.g. notifications/initialized)
  switch (method) {
    case 'initialize': return ok({
      protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : SUPPORTED[0],
      capabilities: { tools: { listChanged: false } }, serverInfo: SERVER,
      instructions: 'LocalCare Props sales metrics from the Triple Line dialer, GHL and the Ledger. Dates are America/Los_Angeles. Qualified = first ACQ/Retail opportunity per contact.',
    });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: toolsFor(scopes).map(listed) });
    case 'tools/call': {
      if (!toolsFor(scopes).some(t => t.name === params.name)) return err(-32602, `Unknown tool: ${params.name}`);
      try {
        const data = await callTool(params.name, params.arguments || {});
        return ok({ content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data, isError: false });
      } catch (error) {
        return ok({ content: [{ type: 'text', text: error.message }], isError: true });
      }
    }
    default: return err(-32601, `Method not found: ${method}`);
  }
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Use POST with JSON-RPC 2.0' }, 405, { Allow: 'POST' });
  const scopes = scopesFor(request);
  if (!scopes) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401, { 'WWW-Authenticate': 'Bearer' });
  let body;
  try { const text = await request.text(); if (text.length > 64000) return json({ error: 'Request too large' }, 413); body = JSON.parse(text); }
  catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(msg => handleRpc(msg, scopes)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
}
export const config = { path: '/mcp' };
