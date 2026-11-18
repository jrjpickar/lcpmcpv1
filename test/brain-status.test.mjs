import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBrainStatus } from '../netlify/functions/lib/brain-status.mjs';
import handler from '../netlify/functions/brain-status.mjs';

const main = 'AC' + '1'.repeat(32);
const sub = 'AC' + '2'.repeat(32);
const model = 'openai/gpt-oss-20b';

test('billing uses the parent account while Groq verifies the configured model with a read', async () => {
  const calls = [];
  const result = await loadBrainStatus({
    TWILIO_ACCOUNT_SID: sub, TWILIO_AUTH_TOKEN: 'sub-token',
    TWILIO_BILLING_ACCOUNT_SID: main, TWILIO_BILLING_AUTH_TOKEN: 'main-token',
    GROQ_API_KEY: 'groq-token',
  }, async (url, options) => {
    calls.push([url, options.method, options.headers.authorization]);
    if (url.includes('twilio.com')) return Response.json({ balance: '-1.23', currency: 'USD' });
    return Response.json({ data: [{ id: model }] });
  });
  assert.deepEqual(calls, [
    [`https://api.twilio.com/2010-04-01/Accounts/${main}/Balance.json`, 'GET', 'Basic ' + Buffer.from(main + ':main-token').toString('base64')],
    ['https://api.groq.com/openai/v1/models', 'GET', 'Bearer groq-token'],
  ]);
  assert.equal(result.billing.balance, -1.23);
  assert.equal(result.billing.currency, 'USD');
  assert.equal(result.groq.status, 'ok');
  assert.ok(!JSON.stringify(result).includes('main-token'));
});

test('a malformed balance is unavailable and does not become zero', async () => {
  const result = await loadBrainStatus({ TWILIO_ACCOUNT_SID: main, TWILIO_AUTH_TOKEN: 'main-token' },
    async () => Response.json({ balance: '', currency: 'USD' }));
  assert.equal(result.billing.status, 'down');
  assert.equal(result.billing.balance, undefined);
  assert.equal(result.groq.status, 'off');
});

test('balance is protected and sandbox never reads live data', async () => {
  delete process.env.DATA_MODE;
  delete process.env.DASHBOARD_KEY;
  const request = new Request('https://example.test/api/brain-status');
  assert.equal((await handler(request)).status, 401);
  process.env.DATA_MODE = 'sample';
  assert.deepEqual(await (await handler(request)).json(), { sample: true });
});
