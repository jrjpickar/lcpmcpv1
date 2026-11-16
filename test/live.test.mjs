import test from 'node:test';
import assert from 'node:assert/strict';
import { dialerCalls, normalizeOpportunity, normalizeSms, normalizeDispositionRow } from '../netlify/functions/lib/sources.mjs';
import { askGroq, compactForModel } from '../netlify/functions/lib/groq.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

test('dialer export is chunked to the 62-day limit and normalized', async () => {
  process.env.DIALER_URL = 'https://dialer.example/'; process.env.DIALER_EXPORT_KEY = 'x'.repeat(30);
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(url); assert.equal(init.headers['x-dashboard-key'], 'x'.repeat(30));
    return new Response(JSON.stringify({ days: { '2026-01-05': { rows: [{ id: 'att1', at: '2026-01-05T18:00:00Z', agent: 'Ann ', contactId: 'c1', dispositionId: 'follow-up-hot', connected: true, duration: 90 }] } } }));
  };
  const rows = await dialerCalls('2026-01-01', '2026-04-30', fetchImpl);
  assert.equal(urls.length, 2);
  assert.match(urls[0], /from=2026-01-01&to=2026-03-01$/);
  assert.match(urls[1], /from=2026-03-02&to=2026-04-30$/);
  assert.deepEqual(rows[0], { callerId: '', list: '', id: 'att1', at: '2026-01-05T18:00:00Z', rep: 'Ann', contactId: 'c1', disposition: 'follow-up-hot', connected: true, duration: 90 });
  assert.equal(normalizeDispositionRow({ at: 'x', duration: null }).duration, 0);
});

test('GHL opportunity and SMS normalization', () => {
  const o = normalizeOpportunity({ id: 'o', contactId: 'c', createdAt: '2026-11-01T00:00:00Z', assignedTo: 'u1', pipelineId: 'p', pipelineStageId: 's', monetaryValue: 25000 },
    { u1: 'Ann' }, { p: { name: 'ACQ Pipeline', stages: { s: 'Offer Sent' } } });
  assert.deepEqual([o.rep, o.pipeline, o.stage, o.value], ['Ann', 'ACQ Pipeline', 'Offer Sent', 25000]);
  assert.equal(normalizeSms({ direction: 'outbound', userId: 'u1', dateAdded: 't', contactId: 'c' }, { u1: 'Ann' }).rep, 'Ann');
  assert.equal(normalizeSms({ direction: 'outbound', source: 'workflow' }).rep, 'Workflow');
  assert.equal(normalizeSms({ direction: 'inbound' }).rep, '');
});

test('Groq gets aggregates only and dashes are removed', async () => {
  const M = require('../public/lcp-metrics.js'), S = require('../public/sample-data.js');
  const result = M.compute(S.generate({ days: 20 }), { preset: '7d' });
  const ctx = JSON.stringify(compactForModel(result));
  assert.ok(!ctx.includes('Sample Seller'), 'no contact names sent');
  assert.ok(ctx.length < 30000);
  process.env.GROQ_API_KEY = 'gsk_test'; process.env.GROQ_MODEL = 'test-model';
  let sent;
  const out = await askGroq({ question: 'q', result, fetchImpl: async (url, init) => { sent = JSON.parse(init.body); assert.match(url, /api\.groq\.com/); return new Response(JSON.stringify({ model: 'test-model', choices: [{ message: { content: 'Ann leads — by 12%' } }] })); } });
  assert.equal(sent.model, 'test-model');
  assert.equal(out.answer, 'Ann leads - by 12%');
  delete process.env.GROQ_API_KEY; delete process.env.GROQ_MODEL;
});

test('live mode without DASHBOARD_KEY fails closed', async () => {
  process.env.DATA_MODE = ''; process.env.GHL_ACCESS_TOKEN = 't'; process.env.GHL_LOCATION_ID = 'l'; delete process.env.DASHBOARD_KEY;
  const { default: metrics } = await import('../netlify/functions/metrics.mjs');
  assert.equal((await metrics(new Request('http://x/api/metrics'))).status, 401);
  delete process.env.GHL_ACCESS_TOKEN; delete process.env.GHL_LOCATION_ID;
});
