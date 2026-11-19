// A2Z ports, round 2: Main dispatcher, Email agent (Gmail), Data sandbox and execution, Slack bot and Call Brain.
// No live provider, Gmail, Slack or Netlify calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { createExecuteHandler } from '../netlify/functions/jarvis-execute.mjs';
import { createMemory, memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { runPlan, sandboxTables, validatePlan } from '../netlify/functions/lib/jarvis-sandbox.mjs';
import { fetchGmail } from '../netlify/functions/lib/gmail.mjs';
import { mailboxContext } from '../netlify/functions/lib/jarvis-mail.mjs';
import slackVoice from '../netlify/functions/slack-voice.mjs';
import { createSlackEventsHandler } from '../netlify/functions/slack-events.mjs';
import { createSlackWorker, parseMessage, toSlack, verifySlack } from '../netlify/functions/lib/slack.mjs';
import { voice } from '../netlify/functions/voice.mjs';
import { memoryStore } from '../netlify/functions/lib/voice/state.mjs';
import { buildReport } from '../netlify/functions/lib/report.mjs';
import { env, fakeGroq, groqReply, post } from './jarvis-helpers.mjs';

const report = { current: { dials: 18 } };
const filters = { preset: '7d' };
const plan = {
  task: 'Qualified per 100 dials by rep',
  steps: [{ action: 'Create View', sql: 'CREATE VIEW rep_yield AS SELECT rep, qualified * 100.0 / dials AS per_100 FROM reps WHERE dials > 0' }],
  validation: [{ check: 'Rows exist', query: 'SELECT * FROM rep_yield' }],
};

test('Main delegates by keyword without a classifier call, uses the classifier when ambiguous, and credits the delegated agent', async () => {
  const store = memoryAdapter();
  const groq = fakeGroq((body, n) => (body.response_format ? { agent: 'market' } : 'Answer ' + n));
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => store });
  const direct = await (await run(post('/api/jarvis', { role: 'main', prompt: 'How many dials this week?', filters, newThread: true }))).json();
  assert.deepEqual(direct.trace, ['main', 'systems']);
  assert.equal(direct.agent, 'systems');
  assert.equal(groq.calls.length, 1, 'no classifier call');
  assert.deepEqual(JSON.parse(groq.calls[0].messages.at(-1).content).report, report);
  const memory = createMemory(store);
  assert.equal((await memory.getMemory('systems')).stats.runs, 1);
  assert.equal((await memory.getMemory('main')).stats.runs, 1);
  // "hello there" matches no intent, so the classifier picks.
  const picked = await (await run(post('/api/jarvis', { role: 'main', prompt: 'hello there' }))).json();
  assert.deepEqual(picked.trace, ['main', 'market']);
  assert.equal(groq.calls[1].response_format.type, 'json_object');
});

test('Email agent reads the sample mailbox, needs mailbox access, and explains missing setup', async () => {
  const groq = fakeGroq({ answer: 'Seller on Cedar Ave wants an answer by Friday.', draft: null });
  const sample = createJarvisHandler({ env: { ...env, DATA_MODE: 'sample' }, fetchImpl: groq.fetchImpl, openStore: async () => memoryAdapter() });
  const data = await (await sample(post('/api/jarvis', { role: 'email', prompt: 'Anything urgent?' }))).json();
  assert.equal(data.agent, 'email');
  assert.ok(data.mailAsOf);
  assert.match(JSON.parse(groq.calls[0].messages.at(-1).content).mailbox.messages[0].subject, /Cedar Ave/);
  const live = createJarvisHandler({ env: { ...env, DATA_MODE: 'live' }, fetchImpl: groq.fetchImpl, openStore: async () => memoryAdapter() });
  const missing = await live(post('/api/jarvis', { role: 'email', prompt: 'Anything urgent?' }));
  assert.equal(missing.status, 503);
  assert.match((await missing.json()).error, /GMAIL_CLIENT_ID/);
});

test('/execute validates without Groq, and the Data agent returns a QC-approved plan with a hash', async () => {
  const groq = fakeGroq(body => (/Data sandbox developer/.test(body.messages[0].content) ? { summary: 'A per-rep yield view.', plan }
    : { approved: true, findings: 'The view answers the request.' }));
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => memoryAdapter() });
  const checked = await (await run(post('/api/jarvis', { role: 'qc', prompt: '/execute ' + JSON.stringify(plan) }))).json();
  assert.equal(groq.calls.length, 0);
  assert.equal(checked.validation.ok, true);
  assert.match(checked.planHash, /^[0-9a-f]{64}$/);
  const bad = await (await run(post('/api/jarvis', { role: 'qc', prompt: '/execute {"task":"x","steps":[{"action":"Run Query","sql":"DELETE FROM reps"}]}' }))).json();
  assert.equal(bad.validation.ok, false);
  const data = await (await run(post('/api/jarvis', { role: 'data', prompt: 'Qualified per 100 dials by rep' }))).json();
  assert.deepEqual(data.trace, ['data', 'qc']);
  assert.equal(data.approved, true);
  assert.equal(data.planHash, validatePlan(plan).hash);
  assert.doesNotMatch(groq.calls[1].messages[0].content, /playbook/i, 'automatic QC never sees the Data playbook');
});

test('the execution sandbox runs on LCP aggregates in a worker, needs the validated hash and keeps an audit log', async () => {
  process.env.DATA_MODE = 'sample';
  const tables = sandboxTables(await buildReport({ preset: '7d' }));
  assert.ok(tables.reps.length > 0 && tables.kpis.length > 0);
  const direct = await runPlan(validatePlan(plan).plan, tables);
  assert.equal(direct.outcome, 'passed');
  assert.equal(direct.applied, false);
  const store = memoryAdapter();
  const handler = createExecuteHandler({ env, openStore: async () => store, readReport: async () => ({ callsByUser: { rows: [{ rep: 'A', dials: 100, qualified: 5 }] } }) });
  const hash = validatePlan(plan).hash;
  assert.equal((await handler(post('/api/jarvis-execute', { action: 'run', plan, planHash: 'f'.repeat(64) }))).status, 409);
  const result = await (await handler(post('/api/jarvis-execute', { action: 'run', plan, planHash: hash, filters }))).json();
  assert.equal(result.outcome, 'passed');
  assert.deepEqual(result.steps[0].rows, [{ rep: 'A', per_100: 5 }]);
  assert.equal((await store.getWithMetadata('exec/log')).data.entries[0].outcome, 'passed');
  assert.equal((await createExecuteHandler({ env: { ...env, JARVIS_EXECUTE: 'off' } })(post('/api/jarvis-execute', { action: 'validate', plan }))).status, 403);
});

test('Gmail source: refresh token sign-in, read-only API calls, plain text excerpts and a cached access token', async () => {
  const gmailEnv = { GMAIL_CLIENT_ID: 'client.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: '1//refresh-token-value' };
  const calls = [];
  const b64 = text => Buffer.from(text).toString('base64url');
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    if (u.host === 'oauth2.googleapis.com') return Response.json({ access_token: 'ya29.token', expires_in: 3599 });
    assert.equal(init.headers.authorization, 'Bearer ya29.token');
    if (u.pathname.endsWith('/labels/INBOX')) return Response.json({ messagesUnread: 7, threadsUnread: 5 });
    if (u.pathname.endsWith('/messages') && u.searchParams.get('q').includes('is:important')) return Response.json({ resultSizeEstimate: 2 });
    if (u.pathname.endsWith('/messages')) { assert.equal(u.searchParams.get('q'), 'in:inbox newer_than:7d'); return Response.json({ messages: [{ id: 'm1' }, { id: 'm2' }] }); }
    if (u.pathname.endsWith('/m1')) return Response.json({ internalDate: '1763500000000', labelIds: ['INBOX', 'UNREAD'], payload: {
      headers: [{ name: 'Subject', value: 'Re: Offer on 1420 Cedar Ave' }, { name: 'From', value: 'Seller <seller@example.com>' }],
      parts: [{ mimeType: 'text/plain', body: { data: b64('Can you close in 21 days?') } }, { mimeType: 'text/html', body: { data: b64('<p>ignored</p>') } }] } });
    return Response.json({ internalDate: '1763400000000', labelIds: ['INBOX'], payload: { headers: [{ name: 'Subject', value: 'Escrow opened' }],
      mimeType: 'text/html', body: { data: b64('<style>x{}</style><p>EMD due in <b>3</b> days</p>') } } });
  };
  const snapshot = await fetchGmail({ env: gmailEnv, fetchImpl });
  assert.equal(snapshot.source, 'gmail');
  assert.deepEqual(snapshot.stats, { unreadIncoming: 7, unreadThreads: 5, importantUnreadEstimate: 2 });
  assert.deepEqual(snapshot.messages.map(m => [m.subject, m.unread, m.text]), [['Re: Offer on 1420 Cedar Ave', true, 'Can you close in 21 days?'], ['Escrow opened', false, 'EMD due in 3 days']]);
  assert.ok(calls.every(c => c.url.startsWith('https://oauth2.googleapis.com/') || (c.url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/') && !c.init.method)), 'read-only GET calls only');
  const tokenCalls = calls.filter(c => c.url.includes('oauth2')).length;
  await mailboxContext({ env: { ...gmailEnv, DATA_MODE: 'live' }, fetchImpl });
  assert.equal(calls.filter(c => c.url.includes('oauth2')).length, tokenCalls, 'access token is reused until it expires');
  const revoked = fetchGmail({ env: { ...gmailEnv, GMAIL_REFRESH_TOKEN: '1//other' }, fetchImpl: async () => Response.json({ error: 'invalid_grant' }, { status: 400 }) });
  await assert.rejects(revoked, /invalid_grant[\s\S]*GMAIL_REFRESH_TOKEN/);
});

const slackEnv = { ...env, SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: 'slack-secret', SLACK_ALLOWED_USERS: 'U0OWNER1' };
const sign = (secret, body, stamp = Math.floor(Date.now() / 1000)) => ({
  'x-slack-request-timestamp': String(stamp), 'x-slack-signature': 'v0=' + createHmac('sha256', secret).update('v0:' + stamp + ':' + body).digest('hex'),
});

test('Slack events: signature, url_verification, retries and dispatch', async () => {
  const dispatched = [];
  const handler = createSlackEventsHandler({ env: slackEnv, dispatch: async work => dispatched.push(JSON.parse(work)) });
  const send = (payload, headers = {}) => {
    const body = JSON.stringify(payload);
    return handler(new Request('https://lcp.example/api/slack/events', { method: 'POST', headers: { ...sign('slack-secret', body), ...headers }, body }));
  };
  assert.equal((await handler(new Request('https://lcp.example/api/slack/events', { method: 'POST', headers: sign('wrong', '{}'), body: '{}' }))).status, 401);
  assert.equal((await (await send({ type: 'url_verification', challenge: 'abc' })).json()).challenge, 'abc');
  await send({ type: 'event_callback', event_id: 'E1', event: { type: 'message' } });
  await send({ type: 'event_callback', event_id: 'E1', event: { type: 'message' } });
  await send({ type: 'event_callback', event_id: 'E2', event: { type: 'message' } }, { 'x-slack-retry-num': '1' });
  assert.equal(dispatched.length, 1);
  assert.equal(verifySlack(new Headers(sign('slack-secret', 'x', 1)), 'x', 'slack-secret'), false, 'old requests are rejected');
  assert.deepEqual(parseMessage('<@U1> market: what did the Fed do?'), { role: 'market', prompt: 'what did the Fed do?' });
  assert.deepEqual(parseMessage('data: rep yield view'), { role: 'data', prompt: 'rep yield view' });
  assert.deepEqual(parseMessage('how are dials?'), { role: 'main', prompt: 'how are dials?' });
  assert.equal(toSlack('**Bold**\n- item'), '*Bold*\n• item');
});

test('Slack worker: DM goes through JARVIS with the Studio key, keeps the thread, ignores strangers, and reactions teach', async () => {
  const store = memoryAdapter();
  const slack = [];
  const groq = fakeGroq('Dials are 18.');
  const fetchImpl = async (url, init) => {
    if (String(url).startsWith('https://slack.com/api/')) {
      slack.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) });
      return Response.json({ ok: true, ts: '99.1' });
    }
    return groq.fetchImpl(url, init);
  };
  const jarvis = createJarvisHandler({ env: slackEnv, fetchImpl, readSystems: async () => report, openStore: async () => store });
  const work = createSlackWorker({ env: slackEnv, fetchImpl, openStore: async () => store, jarvis });
  await work({ type: 'message', channel_type: 'im', user: 'UOTHER99', text: 'systems: dials?', channel: 'D1', ts: '1.0' });
  assert.equal(slack.length, 0);
  await work({ type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'systems: dials?', channel: 'D1', ts: '1.1' });
  assert.equal(slack.find(s => s.method === 'chat.postMessage').body.text, 'Dials are 18.');
  await work({ type: 'message', channel_type: 'im', user: 'U0OWNER1', text: 'systems: and texts?', channel: 'D1', ts: '1.2' });
  assert.ok(groq.calls.at(-1).messages.some(m => m.role === 'assistant' && m.content === 'Dials are 18.'), 'second turn sees the first answer');
  await work({ type: 'reaction_added', user: 'U0OWNER1', reaction: '+1', item: { type: 'message', channel: 'D1', ts: '99.1' } });
  assert.ok(slack.some(s => s.method === 'reactions.add' && s.body.name === 'brain'));
  assert.equal((await createMemory(store).getMemory('systems')).stats.up, 1);
});

test('Call Brain: dashboard key starts a session, a text turn answers from LCP metrics, and the Slack link is single use', async () => {
  const base = 'http://127.0.0.1:8888';
  const voiceEnv = { DATA_MODE: 'sample', VOICE_ENABLED: '1', VOICE_ORIGIN: base, DASHBOARD_KEY: 'dashboard-key-for-tests', VOICE_APPROVED_REASONING: 'groq', GROQ_API_KEY: 'g' };
  const sent = [];
  const context = { env: voiceEnv, store: memoryStore(), fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return groqReply('You made 4,065 dials.'); } };
  const call = (action, data, headers = {}) => voice(new Request(base + '/api/voice', { method: 'POST', headers: { origin: base, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ action, ...data }) }), context, action === 'turn');
  assert.equal((await call('start', {}, { origin: 'https://evil.test' })).status, 403);
  const started = await call('start', {}, { 'x-lcp-key': voiceEnv.DASHBOARD_KEY });
  assert.equal(started.status, 200);
  const { token } = await started.json();
  const turn = await (await call('turn', { id: randomUUID(), text: 'How many dials this week?', history: [] }, { 'x-lcp-voice': token })).json();
  assert.equal(turn.answer, 'You made 4,065 dials.');
  assert.equal(turn.preset, 'wtd');
  assert.match(sent[0].messages[0].content, /LCP Brain/);
  assert.ok(JSON.parse(sent[0].messages.at(-1).content).metrics.kpis);
  assert.equal((await call('end', {}, { 'x-lcp-voice': token })).status, 200);
  assert.equal((await call('resume', {}, { 'x-lcp-voice': token })).status, 401);
  const off = await voice(new Request(base + '/api/voice', { method: 'POST', body: '{}' }), { env: { VOICE_ENABLED: '0' } });
  assert.equal(off.status, 503);
  // /call-lcp: only Slack users in VOICE_SLACK_USERS get a launch link, and a link works once.
  const slackSettings = { ...voiceEnv, SLACK_SIGNING_SECRET: 'slack-secret', VOICE_SLACK_APP_ID: 'A99', VOICE_SLACK_USERS: 'T01:U01' };
  const command = user => {
    const body = new URLSearchParams({ command: '/call-lcp', api_app_id: 'A99', team_id: 'T01', user_id: user }).toString();
    const stamp = String(Math.floor(Date.now() / 1000));
    return slackVoice(new Request(base + '/api/slack/voice', { method: 'POST', body, headers: { 'x-slack-request-timestamp': stamp,
      'x-slack-signature': 'v0=' + createHmac('sha256', 'slack-secret').update('v0:' + stamp + ':' + body).digest('hex') } }), { env: slackSettings });
  };
  assert.match((await (await command('U02')).json()).text, /not linked/);
  const launch = /launch=([\w.-]+)\|/.exec((await (await command('U01')).json()).text)[1];
  const viaSlack = body => voice(new Request(base + '/api/voice', { method: 'POST', headers: { origin: base, 'content-type': 'application/json' }, body: JSON.stringify(body) }), { ...context, env: slackSettings });
  assert.equal((await viaSlack({ action: 'start', launch })).status, 200);
  assert.equal((await viaSlack({ action: 'start', launch })).status, 409);
});

test('Call Brain with VOICE_APPROVED_REASONING=groq,gemini falls back to Gemini on GEMINI_API_KEY alone', async () => {
  const { reasoningProviders, reason } = await import('../netlify/functions/lib/voice/providers.mjs');
  const env = { VOICE_APPROVED_REASONING: 'groq, Gemini', GROQ_API_KEY: 'g', GEMINI_API_KEY: 'gem' };
  assert.deepEqual(reasoningProviders(env).map(([name, , model]) => [name, model]), [['groq', 'openai/gpt-oss-20b'], ['gemini', 'gemini-3.1-flash-lite']]);
  const urls = [];
  const ctx = { env, signal: new AbortController().signal, fetchImpl: async (url, init) => {
    urls.push(url);
    if (url.includes('groq.com')) return new Response(null, { status: 429 });
    assert.equal(init.headers.Authorization, 'Bearer gem');
    return Response.json({ choices: [{ message: { content: 'Gemini answer.' } }] });
  } };
  assert.deepEqual(await reason(ctx, [{ role: 'user', content: 'hi' }]), { provider: 'gemini', answer: 'Gemini answer.' });
  assert.equal(urls[1], 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions');
});
