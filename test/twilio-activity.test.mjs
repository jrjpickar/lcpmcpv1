import assert from 'node:assert/strict';
import test from 'node:test';
import handler from '../netlify/functions/activity.mjs';
import mcp from '../netlify/functions/mcp.mjs';
import { loadActivity } from '../netlify/functions/lib/activity.mjs';

const account = 'AC' + 'a'.repeat(32);
const apiKey = 'SK' + 'b'.repeat(32);
const range = { from: '2026-11-01', to: '2026-11-01' };
const number = '+15551234567';
const other = '+15559876543';
const localMidnight = '2026-11-01T07:00:00Z';
const call = { sid: 'CA1', direction: 'outbound-api', from: number, to: other, start_time: localMidnight, duration: '61' };
const sms = { sid: 'SM1', direction: 'outbound-api', from: number, to: other, date_sent: localMidnight, status: 'delivered', body: 'private' };
Object.assign(process.env, { TWILIO_ACCOUNT_SID: account, TWILIO_API_KEY: apiKey, TWILIO_API_SECRET: 'test-secret',
  AGENT_ASSIGNMENTS: JSON.stringify([{ name: 'Art', twilioPhoneNumber: number }]) });
for (const key of ['DATA_MODE', 'GHL_ACCESS_TOKEN', 'GHL_LOCATION_ID', 'DASHBOARD_KEY', 'MCP_KEY']) delete process.env[key];

test('reads both Twilio resources and applies Pacific boundaries, one SID per event and optional rep filters', async () => {
  let pages = 0;
  const fetchImpl = async (url, options) => {
    pages++;
    assert.equal(url.origin, 'https://api.twilio.com');
    assert.equal(options.headers.authorization, 'Basic ' + Buffer.from(apiKey + ':test-secret').toString('base64'));
    if (url.pathname.endsWith('/Calls.json')) {
      if (url.searchParams.has('PageToken')) return Response.json({ calls: [call, { ...call, sid: 'CA2', from: other, duration: '0' }] });
      assert.equal(url.searchParams.get('StartTime>'), '2026-11-01');
      return Response.json({ calls: [call, { ...call, sid: 'CA3', start_time: '2026-11-01T06:59:59Z' },
        { ...call, sid: 'CA4', start_time: '2026-11-02T08:00:00Z' },
        { ...call, sid: 'CA5', to: 'client:art' }], next_page_uri: url.pathname + '?PageToken=next' });
    }
    assert.equal(url.searchParams.get('DateSent<'), '2026-11-03');
    return Response.json({ messages: [sms, { ...sms, sid: 'SM2', date_sent: null },
      { ...sms, sid: 'MM3', num_media: '1' }, { ...sms, sid: 'SM4', direction: 'inbound' }] });
  };
  const all = await loadActivity(range, fetchImpl);
  assert.equal(pages, 3);
  assert.deepEqual(all.totals, { calls: 2, conversations: 1, sms: 1, smsDelivered: 1 });
  assert.deepEqual((await loadActivity({ ...range, rep: 'Art' }, fetchImpl)).totals, { calls: 1, conversations: 1, sms: 1, smsDelivered: 1 });
  assert.equal((await loadActivity({ ...range, rep: 'Unmapped' }, fetchImpl)).totals.calls, null);
  assert.ok(!JSON.stringify(all).includes(sms.body));
});

test('alternate credentials work and a failed channel remains unavailable', async () => {
  delete process.env.TWILIO_API_KEY;
  delete process.env.TWILIO_API_SECRET;
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  const activity = await loadActivity(range, async (url, options) => {
    assert.equal(options.headers.authorization, 'Basic ' + Buffer.from(account + ':test-token').toString('base64'));
    return url.pathname.endsWith('/Calls.json') ? Response.json({ calls: [] }) : new Response(null, { status: 429 });
  });
  assert.equal(activity.totals.calls, 0);
  assert.equal(activity.totals.sms, null);
  assert.match(activity.coverage.sms.warning, /429/);
});

test('cannot pass Twilio credentials to an external pagination URL', async () => {
  let reads = 0;
  const activity = await loadActivity(range, async url => {
    reads++;
    return url.pathname.endsWith('/Calls.json')
      ? Response.json({ calls: [call], next_page_uri: 'https://example.net/Calls.json' })
      : Response.json({ messages: [] });
  });
  assert.equal(reads, 2);
  assert.equal(activity.coverage.calls.partial, true);
  assert.equal(activity.totals.calls, null);
});

test('Twilio-only mode requires auth on both Brain and MCP routes', async () => {
  assert.equal((await handler(new Request('https://example.net/api/activity'))).status, 401);
  const request = new Request('https://example.net/mcp', { method: 'POST' });
  assert.equal((await mcp(request)).status, 401);
  process.env.DASHBOARD_KEY = 'a'.repeat(24);
  const valid = new Request('https://example.net/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + process.env.DASHBOARD_KEY },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  assert.equal((await mcp(valid)).status, 200);
});

test('year-to-date reads use bounded date windows and combine each day once', async () => {
  const from = '2026-01-01', to = '2026-11-15';
  const count = new Map();
  const activity = await loadActivity({ from, to }, async url => {
    const calls = url.pathname.endsWith('/Calls.json');
    const field = calls ? 'StartTime' : 'DateSent';
    const day = url.searchParams.get(field + '>');
    assert.ok(Date.parse(url.searchParams.get(field + '<')) - Date.parse(day) <= 15 * 86400000);
    const key = field + day;
    count.set(key, (count.get(key) || 0) + 1);
    const at = day + 'T19:00:00Z';
    return calls ? Response.json({ calls: [{ ...call, sid: 'CA' + day, start_time: at }] })
      : Response.json({ messages: [{ ...sms, sid: 'SM' + day, date_sent: at }] });
  });
  assert.equal(count.size, 46);
  assert.ok([...count.values()].every(n => n === 1));
  assert.deepEqual(activity.totals, { calls: 23, conversations: 23, sms: 23, smsDelivered: 23 });
  assert.equal(activity.daily.length, 23);
  assert.deepEqual(activity.coverage.calls.missing, []);
});

test('retry recovers a transient provider error and incomplete windows cannot appear as full totals', async () => {
  const longer = { from: '2026-10-20', to: '2026-11-04' };
  let retries = 0;
  const activity = await loadActivity(longer, async url => {
    if (url.pathname.endsWith('/Messages.json')) {
      if (!retries++) return new Response(null, { status: 429 });
      return Response.json({ messages: [] });
    }
    if (url.searchParams.get('StartTime>') === longer.from) return Response.json({ calls: [call] });
    return new Response(null, { status: 403 });
  });
  assert.equal(retries, 3);
  assert.equal(activity.totals.calls, null);
  assert.equal(activity.totals.sms, 0);
  assert.deepEqual(activity.coverage.calls.missing, [{ from: '2026-11-03', to: '2026-11-04' }]);
});
