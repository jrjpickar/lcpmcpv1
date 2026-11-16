import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { normalizeLedger, loadWorkflows } from '../netlify/functions/lib/sources.mjs';
const require = createRequire(import.meta.url);
const M = require('../public/lcp-metrics.js');

const data = {
  calls: [], sms: [], contacts: [],
  opportunities: [
    { id: 'o1', contactId: 'a', createdAt: '2026-10-20T18:00:00Z', pipeline: 'ACQ Pipeline', stage: 'Closed' },
    { id: 'o2', contactId: 'b', createdAt: '2026-11-02T18:00:00Z', pipeline: 'ACQ Pipeline', stage: 'Pending' },
    { id: 'o3', contactId: 'c', createdAt: '2026-11-03T18:00:00Z', pipeline: 'ACQ Pipeline', stage: 'Offer Declined- Warm', status: 'lost' },
  ],
  deals: [
    { opportunityId: 'o1', assignmentFee: 15000, feeReceived: 15000, feeReceivedDate: '2026-11-05', contractDate: '2026-10-22', closingCosts: 500, emdStatus: 'refunded', emdAmount: 2000 },
    { opportunityId: 'o2', assignmentFee: 10000, feeReceived: null, emdStatus: 'held', emdAmount: 3000, expectedCloseDate: '2026-11-20' },
    { opportunityId: 'o3', assignmentFee: 9000, feeReceived: null, emdStatus: 'held', emdAmount: 1000 },
  ],
  spend: [
    { date: '2026-11-03', category: 'Direct Mail', amount: 2000 },
    { date: '2026-11-04', category: 'Title & Escrow', amount: 300 },
    { date: '2026-11-04', category: 'CRM & Software', amount: 200 },
    { date: '2026-11-04', category: 'Taxes', amount: 999 },
    { date: '2026-09-01', category: 'Direct Mail', amount: 5000 },
  ],
  ap: { owed: 1234, count: 2 },
};

test('accounting P&L is cash basis and groups spend like the Ledger', () => {
  const a = M.compute(data, { from: '2026-11-01', to: '2026-11-07' }).accounting;
  assert.equal(a.revenue, 15000); assert.equal(a.dealsPaid, 1);
  assert.equal(a.dealCosts, 800); // closing costs 500 + Title & Escrow 300
  assert.equal(a.leadGen, 2000); assert.equal(a.opex, 200); assert.equal(a.belowTheLine, 999);
  assert.equal(a.net, 12000);
  assert.equal(a.feesPending, 10000); // o3 is declined, so not pending
  assert.equal(a.emdAtRisk, 4000); // all held EMD, same as the Ledger
  assert.equal(a.avgDaysToClose, 14);
  assert.equal(a.leadGenPerQualified, 1000); // 2 qualified in range (o2, o3)
  assert.equal(a.apOwed, 1234);
  assert.equal(a.period, 'day'); assert.equal(a.trend.revenue.reduce((s, v) => s + v, 0), 15000);
  assert.ok(!a.spendByCategory.some(x => x.key === 'Taxes'));
});

test('calls expose dispositions and outcome series', () => {
  const r = M.compute({ calls: [
    { at: '2026-11-02T18:00:00Z', rep: 'Ann', disposition: 'no-answer-voicemail', connected: false, duration: 0 },
    { at: '2026-11-02T19:00:00Z', rep: 'Ann', disposition: 'follow-up-cold', connected: true, duration: 90 },
    { at: '2026-11-03T19:00:00Z', rep: 'Ann', disposition: 'dnc', connected: true, duration: 30 },
  ] }, { from: '2026-11-02', to: '2026-11-03' });
  const t = r.callsByUser.totals;
  assert.deepEqual(t.outcomes.map(o => [o.key, o.count]), [['noanswer', 1], ['notinterested', 0], ['followup', 1], ['bad', 1], ['other', 0]]);
  assert.equal(t.avgCallSeconds, 60); assert.equal(t.avgConversationSeconds, 90);
  assert.equal(t.followUps.cold, 1); assert.deepEqual(t.connectedSeries, [1, 1]);
  assert.equal(r.callsByUser.rows[0].avgCallSeconds, 60);
});

test('ledger export is normalized and drops bad spend rows', () => {
  const l = normalizeLedger({ deals: [{ opportunityId: 'x', assignmentFee: '5000', emdStatus: 'held' }], spend: [{ date: '2026-11-01T10:00:00Z', category: 'Skip Tracing', amount: 10 }, { amount: 5 }], ap: { owed: '12.5', count: 1 } });
  assert.equal(l.deals[0].assignmentFee, 5000); assert.equal(l.spend.length, 1); assert.equal(l.spend[0].date, '2026-11-01'); assert.equal(l.ap.owed, 12.5);
});

test('workflow stats come from the data dashboard feed with its embed key', async () => {
  process.env.GHL_ACCESS_TOKEN = 't'; process.env.GHL_LOCATION_ID = 'l'; process.env.DATA_MODE = '';
  process.env.DATA_DASHBOARD_URL = 'https://dash.example/'; process.env.DATA_DASHBOARD_KEY = 'e'.repeat(40);
  let seen;
  const w = await loadWorkflows(400, async (url, init) => { seen = [url, init.headers.authorization]; return new Response(JSON.stringify({ configured: true, overview: { enrollments: 9 }, weekly: [{ week: '2026-11-09', enrollments: 9 }], workflows: [{ id: 'w', name: 'Drip', status: 'published', entered: 9, finished: 7, extra: 'x' }], reasons: [] })); });
  assert.equal(seen[0], 'https://dash.example/api/workflow-feed?days=120');
  assert.equal(seen[1], `Bearer ${'e'.repeat(40)}`);
  assert.equal(w.workflows[0].finished, 7); assert.equal(w.workflows[0].extra, undefined);
  for (const k of ['GHL_ACCESS_TOKEN', 'GHL_LOCATION_ID', 'DATA_DASHBOARD_URL', 'DATA_DASHBOARD_KEY']) delete process.env[k];
  process.env.DATA_MODE = 'sample';
  const s = await loadWorkflows(30);
  assert.equal(s.sample, true); assert.ok(s.workflows.length > 0);
});
