import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createOpportunity, previewHash } from '../netlify/functions/lib/ghl-write.mjs';
import { createConfirmHandler } from '../netlify/functions/jarvis-confirm.mjs';

process.env.DATA_MODE = 'sample';
const { handleRpc, toolsFor } = await import('../netlify/functions/mcp.mjs');
const { ACTIONS } = await import('../netlify/functions/lib/actions.mjs');

const memoryStore = () => { const m = new Map(); return { m, async get(k) { return m.get(k) ?? null; }, async setJSON(k, v, c = {}) { if (c.onlyIfNew && m.has(k)) return { modified: false }; m.set(k, v); return { modified: true }; } }; };

// A live-shaped GHL fake for the write path. Records every write.
function ghlFake({ existing = [] } = {}) {
  const writes = [];
  const json = b => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if ((init.method || 'GET') !== 'GET') { writes.push({ path: u.pathname, body: JSON.parse(init.body), auth: init.headers.Authorization }); return json({ opportunity: { id: 'newOpp1' } }); }
    if (u.pathname === '/opportunities/pipelines') return json({ pipelines: [{ id: 'pA', name: 'ACQ Pipeline', stages: [{ id: 's1', name: 'New Lead' }, { id: 's2', name: 'Run Numbers' }] }, { id: 'pD', name: 'Dispo Pipeline', stages: [{ id: 'd1', name: 'New' }] }] });
    if (u.pathname.startsWith('/contacts/')) return json({ contact: { id: 'contactABC123', firstName: 'Maria', lastName: 'Lopez' } });
    if (u.pathname === '/users/') return json({ users: [{ id: 'u1', name: 'Jesse Pickar' }] });
    if (u.pathname === '/opportunities/search') return json({ opportunities: existing });
    return new Response('{}', { status: 404 });
  };
  return { fetchImpl, writes };
}
const LIVE = { GHL_WRITE_TOKEN: 'write-token', GHL_LOCATION_ID: 'loc1', GHL_ACCESS_TOKEN: 'read-token' };

test('create opportunity: preview writes nothing, confirm writes once with the write token, replays are free', async () => {
  const { fetchImpl, writes } = ghlFake();
  const store = memoryStore();
  const args = { contactId: 'contactABC123', stage: 'Run Numbers', assignedTo: 'Jesse Pickar' };
  const preview = await createOpportunity({ dryRun: true, args }, { env: LIVE, fetchImpl, store });
  assert.equal(preview.status, 'ready');
  assert.equal(preview.preview.name, 'Maria Lopez');
  assert.equal(writes.length, 0);
  const key = randomUUID();
  await assert.rejects(createOpportunity({ dryRun: false, args, hash: 'f'.repeat(64), idempotencyKey: key }, { env: LIVE, fetchImpl, store }), /changed since the preview/);
  const done = await createOpportunity({ dryRun: false, args, hash: preview.hash, idempotencyKey: key }, { env: LIVE, fetchImpl, store });
  assert.equal(done.status, 'created');
  assert.equal(writes.length, 1);
  assert.equal(writes[0].auth, 'Bearer write-token');
  assert.deepEqual({ pipelineId: writes[0].body.pipelineId, pipelineStageId: writes[0].body.pipelineStageId, assignedTo: writes[0].body.assignedTo }, { pipelineId: 'pA', pipelineStageId: 's2', assignedTo: 'u1' });
  const again = await createOpportunity({ dryRun: false, args, hash: preview.hash, idempotencyKey: key }, { env: LIVE, fetchImpl, store });
  assert.equal(again.replay, true);
  assert.equal(writes.length, 1, 'same key never writes twice');
  assert.equal(store.m.get('ghl-write/log').entries.length, 1);
});

test('create opportunity: duplicates, other pipelines and missing token are refused', async () => {
  const dup = ghlFake({ existing: [{ id: 'old1', name: 'Maria Lopez', pipelineStageId: 's1' }] });
  const p = await createOpportunity({ dryRun: true, args: { contactId: 'contactABC123' } }, { env: LIVE, fetchImpl: dup.fetchImpl, store: memoryStore() });
  assert.equal(p.status, 'duplicate');
  await assert.rejects(createOpportunity({ dryRun: false, args: { contactId: 'contactABC123' }, hash: p.hash, idempotencyKey: randomUUID() }, { env: LIVE, fetchImpl: dup.fetchImpl, store: memoryStore() }), /already has an open/);
  assert.equal(dup.writes.length, 0);
  await assert.rejects(createOpportunity({ dryRun: true, args: { contactId: 'contactABC123', pipeline: 'Dispo Pipeline' } }, { env: LIVE, fetchImpl: ghlFake().fetchImpl, store: memoryStore() }), /not open for writes/);
  await assert.rejects(createOpportunity({ dryRun: true, args: { contactId: 'contactABC123' } }, { env: { GHL_ACCESS_TOKEN: 'read', GHL_LOCATION_ID: 'l' }, fetchImpl: ghlFake().fetchImpl, store: memoryStore() }), /writes are off/);
  assert.equal(previewHash({ a: 1 }).length, 64);
});

test('confirm endpoint needs the Studio key and same origin', async () => {
  const env = { ...LIVE, LCP_STUDIO_KEY: 'studio-key-0123456789abcdef' };
  const { fetchImpl, writes } = ghlFake();
  const store = memoryStore();
  const handler = createConfirmHandler({ env, fetchImpl, openStore: async () => store });
  const req = (body, headers = {}) => handler(new Request('https://lcp.example/api/jarvis/confirm', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://lcp.example', ...headers }, body: JSON.stringify(body) }));
  assert.equal((await req({ action: 'create_opportunity', dryRun: true, args: { contactId: 'contactABC123' } })).status, 401);
  const auth = { 'x-lcp-studio-key': env.LCP_STUDIO_KEY };
  assert.equal((await req({ action: 'create_opportunity', dryRun: true, args: { contactId: 'contactABC123' } }, { ...auth, origin: 'https://evil.example' })).status, 403);
  const preview = await (await req({ action: 'create_opportunity', dryRun: true, args: { contactId: 'contactABC123' } }, auth)).json();
  assert.equal(preview.status, 'ready');
  const res = await req({ action: 'create_opportunity', dryRun: false, args: { contactId: 'contactABC123' }, hash: preview.hash, idempotencyKey: randomUUID() }, auth);
  assert.equal(res.status, 201);
  assert.equal(writes.length, 1);
});

test('MCP never lists the write tool; the draft tool is opt-in, never sends and is idempotent', async () => {
  const all = new Set(['*']);
  assert.ok(!toolsFor(all).some(t => t.name === 'lcp_create_opportunity'));
  assert.equal((await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'lcp_create_opportunity', arguments: { contactId: 'x' } } })).error.code, -32602);
  assert.ok(!toolsFor(all).some(t => t.name === 'lcp_gmail_create_draft'));
  process.env.MCP_DRAFT_TOOLS = '1';
  try {
    assert.ok(toolsFor(all).some(t => t.name === 'lcp_gmail_create_draft'));
    assert.ok(!toolsFor(new Set(['report:read'])).some(t => t.name === 'lcp_gmail_create_draft'), 'needs mail:draft scope');
    assert.ok(ACTIONS.filter(a => a.risk === 'write').every(a => a.mcp === false));
  } finally { delete process.env.MCP_DRAFT_TOOLS; }
});

test('MCP dashboard and marketing tools answer from the synced data (sample)', async () => {
  const call = async (name, args = {}) => (await handleRpc({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })).result;
  const k = await call('dashboard_kpis', { window: '30d' });
  assert.equal(k.isError, false, k.content?.[0]?.text);
  assert.ok(k.structuredContent.totals.dials > 0 && k.structuredContent.reps.length > 0 && 'qualified' in k.structuredContent.funnel);
  const y = (await call('marketing_yield', { dimension: 'zip', limit: 5 })).structuredContent;
  assert.equal(y.rows.length, 5);
  assert.ok('qualPer100Worked' in y.rows[0]);
  const h = (await call('marketing_yield', { dimension: 'hour' })).structuredContent;
  assert.equal(h.rows.length, 24);
  const r = (await call('marketing_recommendations', {})).structuredContent;
  assert.ok(r.recommendations.length > 0);
  assert.equal(r.news.provider, 'sample');
  const t = (await call('dashboard_tasks', { window: '7d' })).structuredContent;
  assert.ok('overdue' in t);
});
