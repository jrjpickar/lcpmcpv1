import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const M = createRequire(import.meta.url)('../public/lcp-metrics.js');

// 10:00 Pacific on 2026-11-10 = 18:00Z
const at = (day, h = 18) => `${day}T${String(h).padStart(2, '0')}:00:00Z`;
const data = {
  contacts: [{ id: 'a', city: 'Long Beach', zip: '90805' }, { id: 'b', city: 'Compton', zip: '90220' }, { id: 'c', city: 'Long Beach', zip: '90806' }],
  calls: [
    { id: 1, at: at('2026-11-02'), rep: 'Ann', contactId: 'a', connected: false, duration: 0, disposition: 'no-answer-voicemail' },
    { id: 2, at: at('2026-11-03'), rep: 'Bob', contactId: 'a', connected: true, duration: 120, disposition: 'follow-up-hot' },
    { id: 3, at: at('2026-11-03'), rep: 'Ann', contactId: 'b', connected: true, duration: 45, disposition: 'not-interested' },
    { id: 4, at: at('2026-11-04'), rep: 'Ann', contactId: 'c', connected: false, duration: 0, disposition: 'no-answer-voicemail' },
    { id: 5, at: at('2026-10-01'), rep: 'Ann', contactId: 'a', connected: false, duration: 0 }, // outside range, inside lookback
  ],
  sms: [
    { id: 's1', at: at('2026-11-01'), rep: 'Ann', contactId: 'c', direction: 'outbound' },
    { id: 's2', at: at('2026-11-01', 20), rep: '', contactId: 'c', direction: 'inbound' },
    { id: 's3', at: at('2026-11-02'), rep: 'Ann', contactId: 'b', direction: 'outbound' },
  ],
  opportunities: [
    { id: 'o1', contactId: 'a', createdAt: at('2026-11-03', 20), rep: 'Bob', pipeline: 'ACQ Pipeline', value: 20000 },
    { id: 'o2', contactId: 'c', createdAt: at('2026-11-05'), rep: 'Ann', pipeline: 'Retail Pipeline', value: 30000 },
    { id: 'o3', contactId: 'a', createdAt: at('2026-11-06'), rep: 'Bob', pipeline: 'ACQ Pipeline', value: 1000 }, // second opp, not a new qualification
    { id: 'o4', contactId: 'b', createdAt: at('2026-11-06'), rep: 'Ann', pipeline: 'Dispo Pipeline', value: 5000 }, // not qualifying
  ],
  deals: [{ opportunityId: 'o1', feeReceived: 9000, feeReceivedDate: '2026-11-07', assignmentFee: 9000 }],
};
const r = M.compute(data, { from: '2026-11-01', to: '2026-11-07' });

test('calls by user counts only in-range dials per rep', () => {
  const ann = r.callsByUser.rows.find(x => x.rep === 'Ann');
  assert.equal(r.callsByUser.totals.dials, 4);
  assert.equal(ann.dials, 3); assert.equal(ann.connected, 1); assert.equal(ann.connectRate, 0.3333);
  const bob = r.callsByUser.rows.find(x => x.rep === 'Bob');
  assert.equal(bob.over60, 1); assert.equal(bob.hot, 1); assert.equal(bob.talkMinutes, 2);
  assert.equal(r.range.period, 'day'); assert.equal(ann.series.length, 7);
});

test('opportunities: qualifying pipelines only, grouped by location and touches', () => {
  assert.equal(r.opportunities.total, 3);
  assert.deepEqual(r.opportunities.byCity.map(x => [x.key, x.count]), [['Long Beach', 3]]);
  const o1 = r.opportunities.list.find(o => o.id === 'o1');
  assert.equal(o1.touches, 3); // lookback dial 10/01, dial 11/02, dial 11/03
  assert.equal(o1.feeReceived, 9000);
  assert.equal(r.opportunities.byTouches.find(b => b.key === '2-3').count, 3); // o1 (3), o2 (2: sms + dial), o3 (3)
});

test('dials to qualified: last dial gets credit, one credit per lead', () => {
  const d = r.dialsToQualified;
  assert.equal(d.qualified, 2); // a (Bob last dial), c (Ann dial 11/04)
  assert.equal(d.dials, 4); assert.equal(d.dialsPerQualified, 2);
  assert.equal(d.byRep.find(x => x.rep === 'Bob').qualified, 1);
  assert.equal(d.contactsConnected, 2);
});

test('sms to qualified: replies and SMS credit', () => {
  const s = r.smsToQualified;
  assert.equal(s.smsSent, 2); assert.equal(s.contactsTexted, 2); assert.equal(s.contactsReplied, 1);
  assert.equal(s.qualified, 1); assert.equal(s.smsPerQualified, 2); assert.equal(s.bothChannels, 1);
});

test('rep filter applies to every section', () => {
  const b = M.compute(data, { from: '2026-11-01', to: '2026-11-07', rep: 'Bob' });
  assert.equal(b.callsByUser.totals.dials, 1);
  assert.equal(b.dialsToQualified.qualified, 1);
  assert.equal(b.smsToQualified.smsSent, 0);
  assert.equal(b.opportunities.total, 2);
});

test('ledger fees count by received date', () => {
  assert.equal(r.ledger.feesReceived, 9000);
  assert.equal(M.compute(data, { from: '2026-11-08', to: '2026-11-09' }).ledger.feesReceived, 0);
});

test('presets use Pacific dates and Monday week start', () => {
  const now = Date.parse('2026-11-15T07:30:00Z'); // still Nov 14 in Los Angeles
  assert.deepEqual(M.presetRange('today', now), { from: '2026-11-14', to: '2026-11-14' });
  assert.deepEqual(M.presetRange('wtd', now), { from: '2026-11-09', to: '2026-11-14' });
  assert.equal(M.presetRange('ytd', now).from, '2026-01-01');
});
