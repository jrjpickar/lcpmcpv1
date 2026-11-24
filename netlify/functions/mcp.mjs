// POST /mcp  Model Context Protocol server (Streamable HTTP, stateless, JSON responses).
// Connect from Claude or any MCP client with: URL https://<site>/mcp, header Authorization: Bearer <MCP_KEY>.
import { createHash, timingSafeEqual } from 'node:crypto';
import { mcpAuthorized, json } from './lib/auth.mjs';
import { ACTIONS, SCOPES as ACTION_SCOPES, action, mcpActions } from './lib/actions.mjs';

const SERVER = { name: 'lcp-mcp', version: '1.1.0' };
const SUPPORTED = ['2025-06-18', '2025-03-26', '2024-11-05'];
const definition = ({ name, title, description, annotations, inputSchema }) => ({ name, title, description, annotations, inputSchema });

// Read tools from the shared registry (lib/actions.mjs). JARVIS (lib/intel/tools.mjs) maps these as read tools.
export const TOOLS = ACTIONS.filter(a => a.mcp && a.risk === 'read' && a.group !== 'intel').map(a => ({ ...definition(a), scope: a.scope }));
export const INTEL_TOOLS = ACTIONS.filter(a => a.group === 'intel').map(a => ({ ...definition(a), scope: a.scope }));
export const SCOPES = ACTION_SCOPES;

// Who is calling (ported from A2Z). MCP_KEY keeps full access. MCP_TOKENS adds scoped tokens stored as SHA-256 hashes:
// [{ "name": "reports", "sha256": "<hex>", "scopes": ["report:read"] }]. A broken MCP_TOKENS value is ignored.
// Scopes: report:read, mail:draft, knowledge:read, memory:read, web:read. ghl:write exists but is never listed on MCP.
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
export const toolsFor = (scopes, env = process.env) => mcpActions(scopes, env);

// Runs any registry entry that is listed on MCP. Unknown or unlisted names are errors (writes are never reachable here).
export async function callTool(name, args = {}) {
  const entry = action(name);
  if (!entry || !entry.mcp) throw Object.assign(new Error(`Unknown tool: ${name}`), { code: -32602 });
  return entry.run(args || {}, { env: process.env });
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
      instructions: 'LocalCare Props sales and marketing metrics from the Triple Line dialer, Twilio, GHL and the Ledger, plus the v2 data dashboard numbers (dashboard_kpis, dashboard_tasks) and marketing iteration (marketing_yield, marketing_recommendations, market_news). Dates are America/Los_Angeles. Qualified = first ACQ/Retail opportunity per contact. Drafts are never sent; writes are not available on MCP.',
    });
    case 'ping': return ok({});
    case 'tools/list': return ok({ tools: toolsFor(scopes).map(definition) });
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
