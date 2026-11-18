import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';

const env = {
  LCP_STUDIO_KEY: 'gateway-studio-key-for-testing',
  LCP_JARVIS_TOKEN: 'separate-worker-secret-for-testing-only',
  LCP_JARVIS_URL: 'https://worker.example/run',
};
const origin = 'https://lcp.example';
const module = { id: 'dial-test', page: 'sales', title: 'Dials', type: 'metric', metric: 'dials' };
const request = (body, headers = {}) => new Request(origin + '/api/jarvis', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'x-lcp-studio-key': env.LCP_STUDIO_KEY, ...headers },
  body: JSON.stringify(body),
});

test('Jarvis proxy rejects unauthenticated and cross-site runs and protects the worker token', async () => {
  let invoked = 0;
  const run = createJarvisHandler({ env, fetchImpl: async (url, options) => {
    invoked++;
    assert.equal(url.href, env.LCP_JARVIS_URL);
    assert.equal(options.headers.authorization, 'Bearer ' + env.LCP_JARVIS_TOKEN);
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-lcp-studio-key'], undefined);
    assert.equal(JSON.parse(options.body).role, 'market');
    return Response.json({ answer: 'Research', trace: ['market'] });
  } });
  const payload = { role: 'market', prompt: 'Housing news' };
  assert.equal((await run(request(payload, { 'x-lcp-studio-key': '' }))).status, 401);
  assert.equal((await run(request(payload, { origin: 'https://other.example' }))).status, 403);
  assert.equal((await run(request({ ...payload, role: 'shell' }))).status, 400);
  assert.equal((await run(request(payload))).status, 200);
  assert.equal(invoked, 1);
});

test('Jarvis proxy only returns approved build output with valid module configuration', async () => {
  let output;
  const run = createJarvisHandler({ env, fetchImpl: async () => Response.json(output) });
  const payload = { role: 'build', prompt: 'Add Dials to Sales' };
  output = { answer: 'Reviewed', trace: ['build', 'qc'], approved: true, modules: [module] };
  assert.deepEqual((await (await run(request(payload))).json()).modules, [module]);
  output = { ...output, approved: false };
  assert.equal((await run(request(payload))).status, 502);
  output = { ...output, approved: true, modules: [{ ...module, extra: 'code' }] };
  assert.equal((await run(request(payload))).status, 502);
});

test('Jarvis proxy passes the selected report filters but only forwards the aggregate system context', async () => {
  const filters = { from: '2026-10-01', to: '2026-10-07', rep: 'Rep A' };
  const context = { current: { dials: 18 } };
  const run = createJarvisHandler({ env, readSystems: async selected => {
    assert.deepEqual(selected, filters);
    return context;
  }, fetchImpl: async (_url, input) => {
    assert.deepEqual(JSON.parse(input.body).context, context);
    return Response.json({ answer: '18 dials', trace: ['systems'] });
  } });
  const response = await run(request({ role: 'systems', prompt: 'Compare calls', filters }));
  assert.equal(response.status, 200);
});
