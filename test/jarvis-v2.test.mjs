// JARVIS v2 additions ported from A2Z: company memory, custom instructions, custom bots, Gemini, Workers AI,
// token usage, history budget and the optional Supabase store. No live provider calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { createInstructionsHandler, instructionsText } from '../netlify/functions/jarvis-instructions.mjs';
import { createMemory, historyFor, memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { openJarvisStore, supabaseStore } from '../netlify/functions/lib/jarvis-store.mjs';
import { env, fakeGroq, get, groqReply, post } from './jarvis-helpers.mjs';

const report = { current: { dials: 18 } };
const filters = { preset: '7d' };
const CF_ACCOUNT = 'a'.repeat(32);

function providers(groqAnswer = 'Groq says 18 dials.') {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers, body: JSON.parse(init.body) });
    if (String(url).includes('generativelanguage')) return Response.json({ candidates: [{ content: { parts: [{ text: 'Gemini says 18 dials.' }] } }], usageMetadata: { totalTokenCount: 40 } });
    if (String(url).includes('api.cloudflare.com')) return Response.json({ choices: [{ message: { content: 'Workers AI says 18 dials.' } }], usage: { total_tokens: 30 } });
    if (String(url) === 'https://api.groq.com/openai/v1/chat/completions') return groqReply(groqAnswer, 50);
    throw new Error('Unexpected fetch ' + url);
  };
  return { calls, fetchImpl };
}

test('stateless calls report token usage and never need chat storage', async () => {
  const groq = fakeGroq('18 dials.');
  let opened = 0;
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => { opened++; throw new Error('down'); } });
  const data = await (await run(post('/api/jarvis', { role: 'systems', prompt: 'Dials?', filters }))).json();
  assert.equal(data.answer, '18 dials.');
  assert.deepEqual(data.usage, { totalTokens: 100, calls: 1 });
  assert.equal(opened, 1, 'only the optional custom instructions read');
  assert.equal(groq.calls[0].model, 'openai/gpt-oss-20b');
  const override = fakeGroq('ok');
  await createJarvisHandler({ env: { ...env, JARVIS_GROQ_MODEL: 'openai/gpt-oss-120b' }, fetchImpl: override.fetchImpl, readSystems: async () => report, openStore: async () => memoryAdapter() })(
    post('/api/jarvis', { role: 'systems', prompt: 'Dials?', filters }));
  assert.equal(override.calls[0].model, 'openai/gpt-oss-120b');
});

test('"remember for all agents:" saves company memory that every agent receives, QC included', async () => {
  const store = memoryAdapter();
  const groq = fakeGroq(body => (body.response_format ? { approved: true, findings: 'Looks right.' } : 'ok'));
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => store });
  const saved = await (await run(post('/api/jarvis', { role: 'systems', prompt: 'remember for all agents: Buy box is 3 bed SFR in LA County', filters, newThread: true }))).json();
  assert.match(saved.answer, /company memory/);
  assert.equal(groq.calls.length, 0);
  assert.equal((await createMemory(store).getShared())[0].text, 'Buy box is 3 bed SFR in LA County');
  await run(post('/api/jarvis', { role: 'market', prompt: 'What changed?', newThread: true }));
  assert.equal(groq.calls.length, 0, 'market without news feeds does not call Groq');
  await run(post('/api/jarvis', { role: 'systems', prompt: 'Dials?', filters, newThread: true }));
  assert.match(groq.calls.at(-1).messages[0].content, /LocalCare Props company facts[\s\S]*Buy box is 3 bed SFR/);
});

test('history is trimmed by the character budget as well as the turn count', () => {
  const thread = { messages: Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: String(i).repeat(1000) })) };
  assert.equal(historyFor(thread).length, 6);
  const trimmed = historyFor(thread, 2500);
  assert.equal(trimmed.length, 2);
  assert.equal(trimmed[0].content[0], '6');
});

test('custom bots run with their own instructions and the selected report', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  const bot = await memory.saveBot({ name: 'Offer Coach', description: 'Offer math', instructions: 'Check MAO math and offer wording.', context: 'metrics' });
  assert.equal(bot.id, 'bot-offer-coach');
  const groq = fakeGroq('Offer 70% of ARV minus repairs.');
  const run = createJarvisHandler({ env, fetchImpl: groq.fetchImpl, readSystems: async () => report, openStore: async () => store });
  const data = await (await run(post('/api/jarvis', { role: 'bot-offer-coach', prompt: 'How should I price this?', filters, newThread: true }))).json();
  assert.deepEqual(data.trace, ['bot-offer-coach']);
  assert.ok(data.threadId);
  assert.match(groq.calls[0].messages[0].content, /Offer Coach[\s\S]*Check MAO math/);
  assert.deepEqual(JSON.parse(groq.calls[0].messages.at(-1).content).report, report);
  assert.equal((await run(post('/api/jarvis', { role: 'bot-nobody', prompt: 'x' }))).status, 404);
  assert.equal((await run(post('/api/jarvis', { role: 'bot-../x', prompt: 'x' }))).status, 400);
});

test('Gemini calls generateContent with the key header, works without Groq and is refused when unset', async () => {
  const p = providers();
  const run = createJarvisHandler({ env: { LCP_STUDIO_KEY: env.LCP_STUDIO_KEY, GEMINI_API_KEY: 'gem-key' }, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: async () => memoryAdapter() });
  const data = await (await run(post('/api/jarvis', { role: 'gemini', prompt: 'Second opinion on dials?', filters }))).json();
  assert.equal(data.answer, 'Gemini says 18 dials.');
  assert.deepEqual(data.trace, ['gemini']);
  const call = p.calls.find(c => c.url.includes('generativelanguage'));
  assert.match(call.url, /models\/gemini-3\.1-flash-lite:generateContent$/);
  assert.equal(call.headers['x-goog-api-key'], 'gem-key');
  assert.match(call.body.systemInstruction.parts[0].text, /Gemini agent for LocalCare Props/);
  assert.deepEqual(JSON.parse(call.body.contents.at(-1).parts[0].text).report, report);
  const none = createJarvisHandler({ env, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: async () => memoryAdapter() });
  const refused = await none(post('/api/jarvis', { role: 'gemini', prompt: 'hi' }));
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error, /GEMINI_API_KEY/);
});

test('Workers AI uses the OpenAI compatible endpoint and default Llama model', async () => {
  const p = providers();
  const run = createJarvisHandler({ env: { ...env, CLOUDFLARE_ACCOUNT_ID: CF_ACCOUNT, CLOUDFLARE_AI_TOKEN: 'cf-token' }, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: async () => memoryAdapter() });
  const data = await (await run(post('/api/jarvis', { role: 'cloudflare', prompt: 'Draft a follow up' }))).json();
  assert.equal(data.answer, 'Workers AI says 18 dials.');
  const call = p.calls.find(c => c.url.includes('cloudflare'));
  assert.equal(call.url, 'https://api.cloudflare.com/client/v4/accounts/' + CF_ACCOUNT + '/ai/v1/chat/completions');
  assert.equal(call.body.model, '@cf/meta/llama-3.3-70b-instruct-fp8-fast');
  assert.equal(call.headers.authorization, 'Bearer cf-token');
});

test('custom instructions save, load, need the Studio key and reach every agent prompt', async () => {
  const store = memoryAdapter();
  const handler = createInstructionsHandler({ env, openStore: async () => store });
  assert.equal((await handler(get('/api/jarvis-instructions', { 'x-lcp-studio-key': 'wrong-key-wrong-key' }))).status, 401);
  assert.equal((await handler(post('/api/jarvis-instructions', { about: 'x' }, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await handler(post('/api/jarvis-instructions', { about: 1 }))).status, 400);
  const saved = await (await handler(post('/api/jarvis-instructions', { about: 'I run dispositions — fees first.', style: 'Short bullets.' }))).json();
  assert.equal(saved.about, 'I run dispositions - fees first.');
  assert.equal((await (await handler(get('/api/jarvis-instructions'))).json()).style, 'Short bullets.');
  const p = providers('ok');
  const run = createJarvisHandler({ env, fetchImpl: p.fetchImpl, readSystems: async () => report, openStore: async () => store });
  await run(post('/api/jarvis', { role: 'systems', prompt: 'Dials?', filters }));
  assert.match(p.calls[0].body.messages[0].content, /About the operator: I run dispositions - fees first\.[\s\S]*How to respond: Short bullets\./);
  assert.equal(instructionsText({ about: 'x', enabled: false }), '');
});

test('Supabase store does compare-and-swap writes and is chosen only when both variables are set', async () => {
  const requests = [];
  const rows = new Map();
  const fetchImpl = async (target, init) => {
    const url = new URL(target);
    requests.push({ method: init.method || 'GET', url, headers: init.headers });
    const key = url.searchParams.get('key')?.slice(3);
    if (!init.method) return Response.json(rows.has(key) ? [rows.get(key)] : []);
    const body = JSON.parse(init.body || '{}');
    if (init.method === 'POST' && !url.searchParams.has('on_conflict')) {
      if (rows.has(body.key)) return new Response(null, { status: 409 });
      rows.set(body.key, { data: body.data, etag: body.etag });
      return new Response(null, { status: 201 });
    }
    if (init.method === 'PATCH') {
      const row = rows.get(key);
      if (!row || row.etag !== url.searchParams.get('etag').slice(3)) return Response.json([]);
      rows.set(key, { data: body.data, etag: body.etag });
      return Response.json([rows.get(key)]);
    }
    return new Response(null, { status: 204 });
  };
  const store = supabaseStore({ url: 'https://demo.supabase.co', key: 'service-key', fetchImpl });
  assert.equal((await store.setJSON('shared', { entries: [] }, { onlyIfNew: true })).modified, true);
  assert.equal((await store.setJSON('shared', { entries: [] }, { onlyIfNew: true })).modified, false);
  const entry = await store.getWithMetadata('shared');
  assert.equal((await store.setJSON('shared', { entries: [1] }, { onlyIfMatch: entry.etag })).modified, true);
  assert.equal((await store.setJSON('shared', { entries: [2] }, { onlyIfMatch: entry.etag })).modified, false);
  assert.equal(requests[0].url.pathname, '/rest/v1/lcp_jarvis_kv');
  assert.equal(requests[0].headers.apikey, 'service-key');
  assert.throws(() => supabaseStore({ url: 'http://demo.supabase.co', key: 'k' }), /HTTPS/);
  const chosen = await openJarvisStore({ SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k' });
  assert.equal(typeof chosen.getWithMetadata, 'function');
});
