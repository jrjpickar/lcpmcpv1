import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATA_MODE = 'sample';
const { default: mcp, handleRpc, TOOLS } = await import('../netlify/functions/mcp.mjs');
const rpc = (body, headers = {}) => mcp(new Request('http://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));

test('initialize negotiates protocol and lists tools', async () => {
  const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } })).json();
  assert.equal(init.result.protocolVersion, '2025-03-26');
  assert.ok(init.result.capabilities.tools);
  const list = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.deepEqual(list.result.tools.map(t => t.name), ['calls_by_user', 'opportunities_generated', 'sms_to_qualified', 'dials_to_qualified', 'accounting_summary', 'workflow_stats', 'ask_insights']);
});

test('notifications return 202 with no body', async () => {
  const res = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.status, 202);
});

test('tools/call returns structured metrics', async () => {
  const res = await (await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'opportunities_generated', arguments: { preset: '30d', group_by: 'touches' } } })).json();
  assert.equal(res.result.isError, false);
  assert.equal(res.result.structuredContent.groupBy, 'touches');
  assert.equal(res.result.structuredContent.rows.length, 6);
  const d = (await handleRpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'dials_to_qualified', arguments: { from: '2026-10-01', to: '2026-10-31' } } })).result.structuredContent;
  assert.equal(d.range.from, '2026-10-01');
  assert.ok('dialsPerQualified' in d);
});

test('ask_insights falls back to rule-based insights without Groq', async () => {
  delete process.env.GROQ_API_KEY;
  const r = (await handleRpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'ask_insights', arguments: { question: 'hi' } } })).result.structuredContent;
  assert.equal(r.groqConfigured, false); assert.ok(r.insights.length > 0);
});

test('unknown method and tool are errors', async () => {
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 6, method: 'nope' })).error.code, -32601);
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'x' } })).error.code, -32602);
  assert.equal(TOOLS.every(t => t.annotations.readOnlyHint), true);
});

test('MCP_KEY is enforced when set', async () => {
  process.env.MCP_KEY = 'k'.repeat(32);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 8, method: 'ping' })).status, 401);
  assert.equal((await rpc({ jsonrpc: '2.0', id: 8, method: 'ping' }, { authorization: `Bearer ${'k'.repeat(32)}` })).status, 200);
  delete process.env.MCP_KEY;
});
