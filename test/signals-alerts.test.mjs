import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const M = createRequire(import.meta.url)('../public/lcp-metrics.js');

// Sunday 2026-11-15, 2:00 PM Pacific = 22:00Z
const NOW = Date.parse('2026-11-15T22:00:00Z');
const ago = m => new Date(NOW - m * 60000).toISOString();
const dayAgo = (d, h = 19) => new Date(Date.parse(`2026-11-${String(15 - d).padStart(2, '0')}T${h}:00:00Z`)).toISOString();

test('classifier matches the data dashboard rules', () => {
  assert.equal(M.classify('STOP'), 'optout');
  assert.equal(M.classify('Not interested'), 'negative');
  assert.equal(M.classify('Yes, what is your offer?'), 'positive');
  assert.equal(M.classify('nope'), 'negative');
  assert.equal(M.classify('Who is this?'), 'neutral');
});

test('speed to lead, hot replies waiting and reply quality', () => {
  const data = {
    sms: [
      { at: ago(300), contactId: 'a', direction: 'outbound', rep: 'Workflow' },
      { at: ago(240), contactId: 'a', direction: 'inbound', body: 'Yes call me' },        // answered by a rep text 4 min later
      { at: ago(236), contactId: 'a', direction: 'outbound', rep: 'Ann' },
      { at: ago(200), contactId: 'b', direction: 'inbound', body: 'Who is this?' },        // answered by a dial 20 min later
      { at: ago(40), contactId: 'c', direction: 'inbound', body: 'How much would you pay?' }, // waiting, hot
      { at: ago(30), contactId: 'c', direction: 'outbound', rep: 'Workflow' },              // automation does not count
      { at: ago(20), contactId: 'd', direction: 'inbound', body: 'STOP' },                  // needs no response
      { at: ago(10), contactId: 'e', direction: 'inbound', body: 'maybe' },                 // waiting but not hot
    ],
    calls: [{ at: ago(180), contactId: 'b', rep: 'Bob', disposition: 'no-answer-voicemail', connected: false }],
  };
  const r = M.compute(data, { from: '2026-11-15', to: '2026-11-15', now: NOW });
  const g = r.signals;
  assert.equal(g.speedToLead.answered, 2); assert.equal(g.speedToLead.medianMinutes, 12); assert.equal(g.speedToLead.within5, 0.5);
  assert.equal(g.hotReplies.waiting, 1); assert.equal(g.hotReplies.list[0].contactId, 'c'); assert.equal(g.hotReplies.list[0].waitMinutes, 40);
  assert.equal(g.replyQuality.replies, 5); assert.equal(g.replyQuality.optOut, 1); assert.equal(g.replyQuality.positive, 2);
  const hot = r.alerts.find(a => a.type === 'hot_replies');
  assert.ok(hot); assert.deepEqual(hot.itemKeys, ['hot:c@' + ago(40)]);
});

test('follow-up compliance, dropped early and conversations per qualified', () => {
  const data = {
    calls: [
      { at: dayAgo(5), contactId: 'h1', rep: 'Ann', disposition: 'follow-up-hot', connected: true, duration: 120 },
      { at: dayAgo(4, 18), contactId: 'h1', rep: 'Ann', disposition: 'no-answer-voicemail', connected: false },  // 23h later: on time
      { at: dayAgo(5), contactId: 'h2', rep: 'Ann', disposition: 'follow-up-hot', connected: true, duration: 90 },
      { at: dayAgo(2), contactId: 'h2', rep: 'Ann', disposition: 'no-answer-voicemail', connected: false },     // late
      { at: dayAgo(3), contactId: 'h3', rep: 'Bob', disposition: 'follow-up-hot', connected: true, duration: 70 }, // never worked: overdue
      { at: dayAgo(12), contactId: 'x', rep: 'Bob', disposition: 'follow-up-cold', connected: true, duration: 30, list: 'Probate' }, // engaged, 1 touch, idle 12 days
      { at: dayAgo(12), contactId: 'y', rep: 'Bob', disposition: 'no-answer-voicemail', connected: false, list: 'Probate' },        // never engaged
      { at: dayAgo(12), contactId: 'z', rep: 'Bob', disposition: 'dnc', connected: true, duration: 20, list: 'Probate' },           // dead
    ],
    opportunities: [{ id: 'o1', contactId: 'h1', createdAt: dayAgo(4, 20), pipeline: 'ACQ Pipeline', stage: 'Run Numbers', status: 'open', stageAt: dayAgo(4, 20) }],
  };
  const r = M.compute(data, { from: '2026-11-01', to: '2026-11-15', now: NOW });
  const f = r.signals.followUps;
  assert.deepEqual([f.hot.due, f.hot.onTime, f.hot.overdue], [3, 1, 1]);
  assert.deepEqual([f.hotToOpp.contacts, f.hotToOpp.opportunities], [3, 1]);
  assert.equal(r.signals.droppedEarly.count, 1); assert.deepEqual(r.signals.droppedEarly.byList, [{ key: 'Probate', count: 1 }]);
  const ann = r.callsByUser.rows.find(x => x.rep === 'Ann');
  assert.equal(ann.over60, 2); assert.equal(ann.qualified, 1); assert.equal(ann.qualPer100Conv, 50);
  assert.equal(r.signals.stageAging.open, 1); assert.equal(r.signals.stageAging.byStage[0].medianDays, 4);
});

test('caller ID drop and list decay', () => {
  const calls = [];
  for (let d = 1; d <= 7; d++) for (let i = 0; i < 20; i++) calls.push({ at: dayAgo(d), rep: 'Ann', callerId: '+15550001', connected: i < 4, disposition: i < 4 ? 'not-interested' : 'no-answer-voicemail', list: 'Vacant' });
  for (let i = 0; i < 25; i++) calls.push({ at: ago(60 + i), rep: 'Ann', callerId: '+15550001', connected: i < 1, disposition: i < 1 ? 'not-interested' : (i < 12 ? 'incorrect-number' : 'no-answer-voicemail'), list: 'Vacant' });
  const r = M.compute({ calls }, { from: '2026-11-09', to: '2026-11-15', now: NOW });
  const c = r.signals.callerIds[0];
  assert.equal(c.flagged, true); assert.equal(c.baselineRate, 0.2); assert.equal(c.connectRate, 0.04);
  assert.ok(r.alerts.some(a => a.type === 'caller_id'));
  assert.equal(r.signals.lists[0].list, 'Vacant');
});
