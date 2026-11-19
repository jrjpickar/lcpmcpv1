import test from 'node:test';
import assert from 'node:assert/strict';
process.env.DATA_MODE = 'sample';
const { runAlertCheck, withinHours, slackMessage, currentAlerts } = await import('../netlify/functions/lib/alerts.mjs');

const memory = () => { const m = new Map(); return { m, async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async setJSON(k, v) { m.set(k, JSON.stringify(v)); } }; };

test('quiet hours are 9am to 9pm Pacific, DST aware', () => {
  assert.equal(withinHours(Date.parse('2026-11-15T16:59:00Z')), false); // 8:59 PST
  assert.equal(withinHours(Date.parse('2026-11-15T17:00:00Z')), true);  // 9:00 PST
  assert.equal(withinHours(Date.parse('2026-11-16T04:59:00Z')), true);  // 8:59 PM PST
  assert.equal(withinHours(Date.parse('2026-11-16T05:00:00Z')), false); // 9:00 PM PST
  assert.equal(withinHours(Date.parse('2026-07-15T16:00:00Z')), true);  // 9:00 PDT
});

test('dormant without a webhook, outside hours, or in sample mode', async () => {
  delete process.env.ALERT_WEBHOOK_URL;
  assert.match((await runAlertCheck({ now: Date.parse('2026-11-15T20:00:00Z'), store: memory() })).skipped, /WEBHOOK/);
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.test/x';
  assert.match((await runAlertCheck({ now: Date.parse('2026-11-15T12:00:00Z'), store: memory() })).skipped, /outside/);
  delete process.env.ALERT_ALLOW_SAMPLE;
  assert.match((await runAlertCheck({ now: Date.parse('2026-11-15T20:00:00Z'), store: memory() })).skipped, /sample/);
});

test('posts new alerts to Slack once, never calls Groq', async () => {
  process.env.ALERT_WEBHOOK_URL = 'https://hooks.slack.test/x'; process.env.ALERT_ALLOW_SAMPLE = '1'; process.env.GROQ_API_KEY = 'gsk_should_not_be_used';
  const store = memory(), posts = [];
  const fetchImpl = async (url, init) => { assert.ok(!String(url).includes('groq'), 'alerts must not call Groq'); posts.push(JSON.parse(init.body)); return new Response('ok'); };
  // Injected clock (noon Pacific). Sample data is generated at this time too, so the result does not depend on when the test runs.
  const now = Date.parse('2026-11-18T20:00:00Z');
  const first = await runAlertCheck({ now, store, fetchImpl, force: true });
  assert.ok(first.sent > 0, JSON.stringify(first));
  assert.match(posts[0].text, /LCP alerts/);
  assert.ok(!/[–—]/.test(posts[0].text));
  const second = await runAlertCheck({ now: now + 5 * 60000, store, fetchImpl, force: true });
  assert.equal(second.sent, 0); assert.equal(posts.length, 1);
  assert.ok(store.m.has('alerts/baseline'));
  delete process.env.GROQ_API_KEY; delete process.env.ALERT_ALLOW_SAMPLE;
});

test('slack message lists hot replies with GHL links', () => {
  process.env.GHL_LOCATION_ID = 'LOC1';
  const msg = slackMessage([{ title: '1 hot reply waiting', detail: 'Oldest 20 min.', severity: 'high', items: [{ contactId: 'c9', waitMinutes: 20, snippet: 'Yes <call> me' }] }], Date.parse('2026-11-15T22:00:00Z'));
  assert.match(msg.text, /contacts\/detail\/c9\|Reply>/);
  assert.match(msg.text, /&lt;call&gt;/);
  delete process.env.GHL_LOCATION_ID;
});
