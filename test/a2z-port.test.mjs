import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroqFailover } from '../netlify/functions/lib/jarvis-failover.mjs';
import { readJson, retryPolicy } from '../netlify/functions/lib/read-json.mjs';
import { addSamples, sourceState } from '../netlify/functions/lib/source-history.mjs';

test('history records each scheduled slot once and excludes off sources', () => {
  const history = {};
  const first = '2026-11-27T16:00:00.000Z';
  const second = '2026-11-27T16:05:00.000Z';
  addSamples(history, { billing: { status: 'warn' }, groq: { status: 'off' } }, second);
  addSamples(history, { billing: { status: 'ok' } }, first);
  addSamples(history, { billing: { status: 'ok' } }, first);
  assert.deepEqual(sourceState(history.billing, 2, Date.parse(second)), {
    state: 'pending', misses: 1, uptime24h: 50, checks24h: 2,
  });
  assert.equal(history.groq, undefined);
  assert.equal(sourceState(history.billing, 1, Date.parse(second) + 86400001), null);
});

test('upstream read retries a transient GET but does not retry POST', async () => {
  const policy = { ...retryPolicy, initialIntervalMs: 0 };
  let calls = 0;
  const fetchImpl = async () => ++calls === 2 ? Response.json({ ok: true }) : new Response(null, { status: 503 });
  const url = 'https://example.test/feed';
  assert.deepEqual(await readJson(url, {}, { policy, fetchImpl }), { ok: true });
  calls = 0;
  await assert.rejects(readJson(url, { method: 'POST' }, { policy, fetchImpl }), /HTTP 503/);
  assert.equal(calls, 1);
});

test('failover records retry, cooldown, backup use and primary recovery', async () => {
  let time = 0;
  const calls = [];
  const statuses = [503, 503, 200, 200, 200];
  const groq = createGroqFailover({
    env: {}, timeoutMs: 7000, now: () => time, wait: async ms => { time += ms; },
    fetchImpl: async (_, init) => {
      calls.push(JSON.parse(init.body).model);
      return new Response(null, { status: statuses.shift() });
    },
  });
  const ask = () => groq.fetch('https://example.test/completions', { body: '{"messages":[{"content":"private"}]}' });
  assert.equal((await ask()).status, 200);
  assert.equal((await ask()).status, 200);
  time += 30000;
  assert.equal((await ask()).status, 200);
  const { primary, backup, active, events, retryAt } = groq.status();
  assert.deepEqual(calls, [primary, primary, backup, backup, primary]);
  assert.equal(active, primary);
  assert.equal(retryAt, null);
  assert.deepEqual(events.map(event => event.type), ['recovery', 'probe', 'failover', 'failover', 'failure', 'retry']);
  assert.doesNotMatch(JSON.stringify(events), /private/);
});
