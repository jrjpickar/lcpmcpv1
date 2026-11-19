import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';

const env = {
  LCP_STUDIO_KEY: 'gateway-studio-key-for-testing',
  GROQ_API_KEY: 'test-provider-key',
};
const origin = 'https://lcp.example';
const draft = { page: 'sales', title: 'Dials', type: 'metric', metric: 'dials' };
const request = (body, headers = {}) => new Request(origin + '/api/jarvis', {
  method: 'POST',
  headers: { origin, 'content-type': 'application/json', 'x-lcp-studio-key': env.LCP_STUDIO_KEY, ...headers },
  body: JSON.stringify(body),
});

function modelResponse(content) {
  return Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
}

test('Jarvis protects the agent endpoint and sends only aggregate report context', async () => {
  const filters = { from: '2026-10-01', to: '2026-10-07', rep: 'Rep A' };
  const report = { current: { dials: 18 } };
  let calls = 0;
  const run = createJarvisHandler({ env, readSystems: async selected => {
    assert.deepEqual(selected, filters);
    return report;
  }, fetchImpl: async (url, input) => {
    calls++;
    assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
    assert.equal(input.headers.authorization, 'Bearer ' + env.GROQ_API_KEY);
    assert.equal(input.headers['x-lcp-studio-key'], undefined);
    const { model, messages } = JSON.parse(input.body);
    assert.equal(model, 'openai/gpt-oss-20b');
    assert.deepEqual(JSON.parse(messages[1].content).report, report);
    return modelResponse('18 dials');
  } });
  const payload = { role: 'systems', prompt: 'Compare calls', filters };
  assert.equal((await run(request(payload, { 'x-lcp-studio-key': '' }))).status, 401);
  assert.equal((await run(request(payload, { origin: 'https://other.example' }))).status, 403);
  assert.equal((await run(request({ ...payload, role: 'shell' }))).status, 400);
  assert.deepEqual(await (await run(request(payload))).json(), { answer: '18 dials', trace: ['systems'], agent: 'systems' });
  assert.equal(calls, 1);
});

test('Build invokes independent QC and only returns valid approved modules', async () => {
  const payload = { role: 'build', prompt: 'Add Dials to Sales' };
  for (const approved of [true, false]) {
    const calls = [];
    const run = createJarvisHandler({ env, fetchImpl: async (_url, input) => {
      const { messages, response_format } = JSON.parse(input.body);
      assert.equal(response_format.type, 'json_object');
      calls.push(messages);
      if (calls.length === 1) return modelResponse({ summary: 'Dials KPI', modules: [draft] });
      assert.match(messages[0].content, /independent QC/);
      assert.deepEqual(JSON.parse(messages[1].content).modules, [draft]);
      return modelResponse({ approved, findings: 'Reviewed KPI binding.' });
    } });
    const response = await run(request(payload));
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.trace, ['build', 'qc']);
    assert.equal(result.approved, approved);
    assert.equal(calls.length, 2);
    if (approved) assert.equal(result.modules[0].metric, 'dials');
    else assert.equal(result.modules, undefined);
  }
  const run = createJarvisHandler({ env, fetchImpl: async () =>
    modelResponse({ summary: 'Invalid module', modules: [{ ...draft, code: 'arbitrary()' }] }) });
  assert.equal((await run(request(payload))).status, 502);
});

test('Standalone QC reviews current modules and returns quota errors', async () => {
  const payload = { role: 'qc', prompt: 'Check draft', modules: [{ id: 'dial-test', ...draft }] };
  const run = createJarvisHandler({ env, fetchImpl: async () => modelResponse({ approved: true, findings: 'Valid draft.' }) });
  assert.deepEqual(await (await run(request(payload))).json(), { answer: 'Valid draft.', trace: ['qc'], approved: true, agent: 'qc' });
  const quota = createJarvisHandler({ env, fetchImpl: async () => new Response('', { status: 429 }) });
  assert.equal((await quota(request(payload))).status, 429);
});

test('Market agent uses approved sources and drops outside links', async () => {
  const run = createJarvisHandler({ env, fetchImpl: async (address, input) => {
    if (address.includes('api.groq.com')) {
      const context = JSON.parse(JSON.parse(input.body).messages[1].content);
      assert.equal(context.sources.length, 2);
      return modelResponse('Compare the housing and policy headlines [1] [2].');
    }
    const host = new URL(address).origin;
    return new Response('<rss><channel><item><title>Housing update</title><link>' + host +
      '/news</link></item><item><title>External item</title><link>https://unsafe.example/news</link></item></channel></rss>');
  } });
  const response = await run(request({ role: 'market', prompt: 'Housing news' }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.sources.length, 2);
  assert.deepEqual(result.unavailable, []);
  assert.deepEqual(result.trace, ['market']);
});

test('Missing Groq key reports a configuration error without a provider request', async () => {
  const run = createJarvisHandler({ env: { LCP_STUDIO_KEY: env.LCP_STUDIO_KEY }, fetchImpl: async () => assert.fail() });
  const response = await run(request({ role: 'market', prompt: 'Housing news' }));
  assert.equal(response.status, 503);
});

test('Brain health follow-up skips model calls, and a live health build rejects a static substitute', async () => {
  let calls = 0;
  let responseBody = { summary: 'Placeholder', modules: [{ type: 'note', page: 'brain', title: 'Health', text: 'Check the status.' }] };
  const run = createJarvisHandler({ env, fetchImpl: async (_url, input) => {
    calls++;
    const { messages } = JSON.parse(input.body);
    if (/independent QC/.test(messages[0].content)) return modelResponse({ approved: true, findings: 'Uses Brain status.' });
    assert.equal(JSON.parse(messages[1].content).requiredModule, 'health');
    return modelResponse(responseBody);
  } });
  const lookup = await run(request({ role: 'build', prompt: 'i mean for system health on the brain' }));
  assert.deepEqual((await lookup.json()).trace, ['systems']);
  assert.equal(calls, 0);
  const task = { role: 'build', prompt: 'Add a live system health card on Brain' };
  const rejected = await (await run(request(task))).json();
  assert.equal(rejected.approved, false);
  assert.equal(rejected.modules, undefined);
  assert.equal(calls, 1);
  responseBody = { summary: 'Live card', modules: [{ type: 'health', page: 'brain', title: 'Health' }] };
  const approved = await (await run(request(task))).json();
  assert.equal(approved.approved, true);
  assert.equal(approved.modules[0].type, 'health');
  assert.equal(calls, 3);
});

test('Brain health uses previous task for clarifications, but an explicit lookup takes priority', async () => {
  const { brainHealthIntent, formatBrainHealth } = await import('../public/jarvis-intent.mjs');
  assert.equal(brainHealthIntent('i mean for system health on the brain', 'Add a card'), 'build');
  assert.equal(brainHealthIntent('Actually, show system health on Brain', 'Add a card'), 'read');
  assert.match(formatBrainHealth({ sources: [{ name: 'HighLevel', status: 'warn', detail: '2 report read issue(s)' }] }), /HighLevel · Warning · 2 report read issue/);
});

test('Build can request report evidence and deliver a QC-checked panel with multiple live bindings', async () => {
  const filters = { preset: '7d' };
  const panel = { type: 'panel', page: 'brain', title: 'Opportunity performance', blocks: [
    { type: 'metric', title: 'HighLevel opportunities', metric: 'opportunities' },
    { type: 'trend', title: 'Opportunity trend', series: 'opportunities' },
    { type: 'health', title: 'Connector status' },
  ] };
  let reportReads = 0;
  let modelCalls = 0;
  const run = createJarvisHandler({ env, readSystems: async selected => {
    reportReads++;
    assert.deepEqual(selected, filters);
    return { current: { opportunities: 12 }, coverage: { ghl: true } };
  }, fetchImpl: async (_url, options) => {
    modelCalls++;
    const { messages } = JSON.parse(options.body);
    const context = JSON.parse(messages[1].content);
    if (modelCalls === 1) return modelResponse({ inspectReport: true });
    if (modelCalls === 2) {
      assert.equal(context.report.current.opportunities, 12);
      return modelResponse({ summary: 'Live opportunity data and status', modules: [panel] });
    }
    assert.deepEqual(context.modules, [panel]);
    return modelResponse({ approved: true, findings: 'Live report bindings reviewed.' });
  } });
  const answer = await run(request({ role: 'build', filters, prompt: 'Build a Brain panel with opportunity metrics and health' }));
  assert.equal(answer.status, 200);
  const result = await answer.json();
  assert.deepEqual(result.trace, ['build', 'qc']);
  assert.deepEqual(result.modules[0].blocks, panel.blocks);
  assert.equal(modelCalls, 3);
  assert.equal(reportReads, 1);
});

test('Goose is an optional build engine and QC still uses the independent direct model', async () => {
  let builds = 0;
  let reviews = 0;
  const run = createJarvisHandler({
    env,
    createGooseModel: key => async (_instruction, context) => {
      builds++;
      assert.equal(key, env.GROQ_API_KEY);
      assert.equal(context.request, 'Add Dials to Sales');
      return { summary: 'Goose proposal', modules: [draft] };
    },
    fetchImpl: async (_url, options) => {
      reviews++;
      assert.match(JSON.parse(options.body).messages[0].content, /independent QC/);
      return modelResponse({ approved: true, findings: 'Correct binding.' });
    },
  });
  const result = await (await run(request({ role: 'build', engine: 'goose', prompt: 'Add Dials to Sales' }))).json();
  assert.equal(result.engine, 'goose');
  assert.equal(result.modules[0].metric, 'dials');
  assert.deepEqual(result.trace, ['build', 'qc']);
  assert.equal(builds, 1);
  assert.equal(reviews, 1);
});

test('Goose headless runner uses a temporary profile, bounded execution and a restricted environment', async () => {
  const { gooseModel } = await import('../netlify/functions/lib/goose.mjs');
  const { access, readFile } = await import('node:fs/promises');
  let temporary;
  const model = gooseModel('fixture-key', {
    binary: () => '/fixture/goose',
    execute: async (file, argv, options) => {
      assert.equal(file, '/fixture/goose');
      assert.ok(argv.includes('--no-profile') && argv.includes('--no-session'));
      assert.ok(!argv.some(value => value.startsWith('--with-')));
      assert.equal(options.env.GROQ_API_KEY, 'fixture-key');
      assert.equal(options.env.DASHBOARD_KEY, undefined);
      assert.equal(options.env.HOME, options.cwd);
      assert.ok(options.timeout <= 12000);
      temporary = options.cwd;
      assert.match(await readFile(argv.at(-1), 'utf8'), /Fixture request/);
      return { stdout: '{"summary":"Goose result","modules":[]}' };
    },
  });
  assert.equal((await model('Fixture instruction', { request: 'Fixture request' })).summary, 'Goose result');
  await assert.rejects(access(temporary), { code: 'ENOENT' });
});
