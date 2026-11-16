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
  assert.equal(activity.totals.calls, 1);
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
