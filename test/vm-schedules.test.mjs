// RUN_SCHEDULES_ON and the VM timetable: no job runs in both places, and the VM fires at the same Pacific times.
import test from 'node:test';
import assert from 'node:assert/strict';
import { claimRun, dueJobs, netlifyShouldSkip, schedulesOn, slotFor } from '../netlify/functions/lib/schedules.mjs';
import { memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { modelTimeout } from '../netlify/functions/lib/jarvis-agents.mjs';

test('RUN_SCHEDULES_ON defaults to netlify and only an exact vm moves the jobs', () => {
  assert.equal(schedulesOn({}), 'netlify');
  assert.equal(schedulesOn({ RUN_SCHEDULES_ON: ' VM ' }), 'vm');
  assert.equal(schedulesOn({ RUN_SCHEDULES_ON: 'both' }), 'netlify');
  assert.equal(netlifyShouldSkip('alerts-scheduled', { RUN_SCHEDULES_ON: 'vm' }), true);
  assert.equal(netlifyShouldSkip('alerts-scheduled', {}), false);
});

test('Netlify scheduled functions exit before any work when RUN_SCHEDULES_ON=vm', async () => {
  const saved = { ...process.env };
  Object.assign(process.env, { RUN_SCHEDULES_ON: 'vm', ALERT_WEBHOOK_URL: 'https://hooks.slack.test/x', SLACK_BOT_TOKEN: 'xoxb-x', SLACK_BRIEFING_CHANNEL: 'C1', GMAIL_CLIENT_ID: 'a', GMAIL_CLIENT_SECRET: 'b', GMAIL_REFRESH_TOKEN: 'c' });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('no network in this test'); };
  try {
    for (const name of ['alerts-scheduled', 'jarvis-mail-sync', 'slack-briefing']) await (await import('../netlify/functions/' + name + '.mjs')).default();
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = realFetch;
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  }
});

test('the VM timetable runs in Pacific time, DST aware', () => {
  assert.deepEqual(dueJobs(Date.parse('2026-11-18T17:00:00Z')), ['alerts-scheduled', 'jarvis-mail-sync']); // 9:00 PST Wed
  assert.deepEqual(dueJobs(Date.parse('2026-11-18T16:55:00Z')), []);                                       // 8:55 PST
  assert.deepEqual(dueJobs(Date.parse('2026-11-19T05:00:00Z')), ['jarvis-mail-sync']);                     // 9:00 PM PST, alerts stop
  assert.deepEqual(dueJobs(Date.parse('2026-11-18T15:05:00Z')), ['slack-briefing']);                       // 7:05 PST Wed
  assert.deepEqual(dueJobs(Date.parse('2026-07-15T14:05:00Z')), ['slack-briefing']);                       // 7:05 PDT Wed
  assert.deepEqual(dueJobs(Date.parse('2026-11-21T15:05:00Z')), []);                                       // Saturday
  assert.deepEqual(dueJobs(Date.parse('2026-11-18T20:07:00Z')), []);                                       // off the 5 minute grid
});

test('a job slot can only be claimed once across Netlify and the VM when Supabase is shared', async () => {
  const store = memoryAdapter();
  const env = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' };
  const netlifyFired = Date.parse('2026-11-18T20:05:00Z'), vmFired = Date.parse('2026-11-18T20:05:31Z');
  assert.equal(slotFor('alerts-scheduled', netlifyFired), slotFor('alerts-scheduled', vmFired));
  assert.equal(await claimRun('alerts-scheduled', { now: netlifyFired, env, openStore: async () => store }), true);
  assert.equal(await claimRun('alerts-scheduled', { now: vmFired, env, openStore: async () => store, by: 'vm' }), false);
  // The briefing slot is the Pacific day, so Netlify (15:05 UTC) and the VM (7:05 Pacific) share it in summer too.
  assert.equal(slotFor('slack-briefing', Date.parse('2026-07-15T14:05:00Z')), slotFor('slack-briefing', Date.parse('2026-07-15T15:05:00Z')));
  assert.equal(await claimRun('alerts-scheduled', { now: netlifyFired, env: {} }), true, 'without Supabase the flag alone decides');
});

test('model calls time out at 7 s on request paths, longer only when MODEL_TIMEOUT_MS is set', () => {
  assert.equal(modelTimeout({}), 7000);
  assert.equal(modelTimeout({ MODEL_TIMEOUT_MS: '20000' }), 20000);
  assert.equal(modelTimeout({ MODEL_TIMEOUT_MS: '5' }), 1000);
});
