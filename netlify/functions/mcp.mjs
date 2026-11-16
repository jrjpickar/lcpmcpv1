// POST /mcp  Model Context Protocol server (Streamable HTTP, stateless, JSON responses).
// Connect from Claude or any MCP client with: URL https://<site>/mcp, header Authorization: Bearer <MCP_KEY>.
import { buildReport, paramsFrom } from './lib/report.mjs';
import { loadActivity } from './lib/activity.mjs';
import { askGroq } from './lib/groq.mjs';
import { loadWorkflows } from './lib/sources.mjs';
import { mcpAuthorized, json } from './lib/auth.mjs';

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

const pick = (r, group) => {
  const o = r.opportunities;
  const groups = { city: o.byCity, zip: o.byZip, period: o.byPeriod, weekday: o.byWeekday, hour: o.byHour, touches: o.byTouches, rep: o.byRep };
  const base = { range: r.range, total: o.total, value: o.value, medianTouches: o.medianTouches, avgTouches: o.avgTouches, definition: r.definitions.qualified };
  return group && group !== 'all' && groups[group] ? { ...base, groupBy: group, rows: groups[group] } : { ...base, ...groups };
};

export async function callTool(name, args = {}) {
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

export async function handleRpc(msg) {
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
    case 'tools/list': return ok({ tools: TOOLS });
    case 'tools/call': {
      if (!TOOLS.some(t => t.name === params.name)) return err(-32602, `Unknown tool: ${params.name}`);
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
  if (!mcpAuthorized(request)) return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401, { 'WWW-Authenticate': 'Bearer' });
  let body;
  try { const text = await request.text(); if (text.length > 64000) return json({ error: 'Request too large' }, 413); body = JSON.parse(text); }
  catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body : [body]).map(handleRpc))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return json(batch ? replies : replies[0]);
}
export const config = { path: '/mcp' };
