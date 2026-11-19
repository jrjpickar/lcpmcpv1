// v6: the Email agent drafts on Gemini (Groq fallback) and saves Gmail drafts on request. Nothing can send mail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { checkDraft, createDraft, rawMessage } from '../netlify/functions/lib/gmail.mjs';
import { createEmailDraftHandler } from '../netlify/functions/jarvis-email-draft.mjs';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { GEMINI_MODEL } from '../netlify/functions/lib/jarvis-agents.mjs';
import { memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { env, groqReply, post } from './jarvis-helpers.mjs';

const root = new URL('..', import.meta.url).pathname;
function sources(dir) {
  return readdirSync(join(root, dir)).flatMap(name => {
    const path = join(root, dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(join(dir, name));
    return /\.(mjs|js|cjs|html|sh)$/.test(name) ? [join(dir, name)] : [];
  });
}

test('no send code path: users.messages.send, drafts.send and their REST paths appear nowhere outside tests', () => {
  const files = ['netlify', 'public', 'server', 'scripts', 'sandbox', 'deploy'].flatMap(sources);
  assert.ok(files.length > 30);
  const forbidden = /messages\.send|drafts\.send|\/messages\/send|\/drafts\/send|auth\/gmail\.send|gmail\.modify/;
  const hits = files.filter(file => forbidden.test(readFileSync(join(root, file), 'utf8')));
  assert.deepEqual(hits, []);
  // The only Gmail write in the codebase is drafts.create (POST .../drafts).
  const gmail = readFileSync(join(root, 'netlify/functions/lib/gmail.mjs'), 'utf8');
  assert.equal(gmail.match(/method: 'POST'/g).length, 2, 'token refresh and drafts.create only');
  assert.match(gmail, /API \+ '\/drafts', \{\s*method: 'POST'/);
  const script = readFileSync(join(root, 'scripts/gmail-token.mjs'), 'utf8');
  assert.match(script, /gmail\.readonly https:\/\/www\.googleapis\.com\/auth\/gmail\.compose/);
});

test('drafts are validated and encoded as a safe UTF-8 MIME message', () => {
  assert.throws(() => checkDraft({ to: ['not-an-email'], subject: 'x', body: 'y' }), /valid email/);
  assert.throws(() => checkDraft({ to: [], subject: '', body: 'y' }), /subject/);
  const draft = checkDraft({ to: 'seller@example.com', subject: 'Offer\r\nBcc: evil@example.com', body: 'Hi Maria,\nCan we close in 21 days?' });
  assert.equal(draft.subject, 'Offer Bcc: evil@example.com', 'header injection is flattened');
  const raw = Buffer.from(rawMessage({ ...draft, subject: 'Re: Oferta ñ' }), 'base64url').toString();
  assert.match(raw, /^To: seller@example.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.doesNotMatch(raw, /\r\nBcc:/);
  assert.equal(Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString(), 'Hi Maria,\nCan we close in 21 days?');
});

test('createDraft only calls the token endpoint, a metadata read and drafts.create, and keeps replies in the thread', async () => {
  const gmailEnv = { GMAIL_CLIENT_ID: 'client', GMAIL_CLIENT_SECRET: 'secret', GMAIL_REFRESH_TOKEN: '1//draft-test-token' };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body });
    if (String(url).startsWith('https://oauth2.googleapis.com/')) return Response.json({ access_token: 'ya29.x', expires_in: 3599 });
    if (String(url).includes('/messages/msg001?format=metadata')) return Response.json({ threadId: 't1', payload: { headers: [{ name: 'Message-ID', value: '<abc@mail.example.com>' }] } });
    if (String(url).includes('/messages/msg404?format=metadata')) return new Response('{}', { status: 404 });
    if (String(url).endsWith('/drafts')) return Response.json({ id: 'r123', message: { id: 'm9', threadId: 't1' } });
    throw new Error('Unexpected call ' + url);
  };
  const reply = { to: ['seller@example.com'], subject: 'Re: Offer', body: 'Yes, 21 days works.' };
  await assert.rejects(createDraft({ ...reply, replyToId: 'msg404' }, { env: gmailEnv, fetchImpl }), /not found/);
  calls.length = 0;
  assert.deepEqual(await createDraft({ ...reply, replyToId: 'msg001' }, { env: gmailEnv, fetchImpl }), { draftId: 'r123', messageId: 'm9', threadId: 't1' });
  const gmailCalls = calls.filter(call => call.url.startsWith('https://gmail.googleapis.com/'));
  assert.deepEqual(gmailCalls.map(call => call.method + ' ' + call.url.split('/users/me')[1].split('?')[0]), ['GET /messages/msg001', 'POST /drafts']);
  const body = JSON.parse(gmailCalls[1].body);
  assert.equal(body.message.threadId, 't1');
  assert.match(Buffer.from(body.message.raw, 'base64url').toString(), /In-Reply-To: <abc@mail.example.com>/);
});

test('the draft endpoint needs the Studio key, validates input and saves nothing in sample mode', async () => {
  const handler = createEmailDraftHandler({ env: { ...env, DATA_MODE: 'sample' } });
  const draft = { to: ['seller@example.com'], subject: 'Offer', body: 'Hello' };
  assert.equal((await handler(post('/api/jarvis-email-draft', draft, { 'x-lcp-studio-key': 'wrong-key-wrong-key-wrong' }))).status, 401);
  assert.equal((await handler(post('/api/jarvis-email-draft', draft, { origin: 'https://evil.test' }))).status, 403);
  assert.equal((await handler(post('/api/jarvis-email-draft', { ...draft, to: ['x'] }))).status, 400);
  assert.deepEqual(await (await handler(post('/api/jarvis-email-draft', draft))).json(), { ok: true, sample: true, draftId: 'sample-draft', link: 'https://mail.google.com/mail/u/0/#drafts' });
});

test('the Email agent runs on Gemini (EMAIL_GEMINI_MODEL, default gemini-3.1-flash-lite), returns a draft, and falls back to Groq', async () => {
  assert.equal(GEMINI_MODEL, 'gemini-3.1-flash-lite');
  const urls = [];
  const draft = { to: ['seller@example.com'], cc: [], subject: 'Re: Your offer on 1420 Cedar Ave, Long Beach', body: 'Hi, 21 days works for us.', replyToId: null };
  const gemini = (status = 200) => async (url, init) => {
    urls.push(String(url));
    if (String(url).includes('generativelanguage')) {
      if (status !== 200) return new Response('{}', { status });
      return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify({ answer: 'Drafted a reply.', draft }) }] } }] });
    }
    return groqReply({ answer: 'Groq drafted it.', draft });
  };
  const run = fetchImpl => createJarvisHandler({ env: { ...env, DATA_MODE: 'sample', GEMINI_API_KEY: 'gem' }, fetchImpl, openStore: async () => memoryAdapter() })(
    post('/api/jarvis', { role: 'email', prompt: 'Draft a reply to the Cedar Ave seller saying 21 days works' }));
  const first = await (await run(gemini())).json();
  assert.equal(first.provider, 'gemini');
  assert.deepEqual(first.draft, { ...draft });
  assert.match(urls[0], /models\/gemini-3\.1-flash-lite:generateContent$/);
  urls.length = 0;
  const fallback = await (await run(gemini(503))).json();
  assert.equal(fallback.provider, 'groq');
  assert.equal(fallback.answer, 'Groq drafted it.');
  urls.length = 0;
  await createJarvisHandler({ env: { ...env, DATA_MODE: 'sample', GEMINI_API_KEY: 'gem', GEMINI_MODEL: 'gemini-general', EMAIL_GEMINI_MODEL: 'gemini-email' }, fetchImpl: gemini(), openStore: async () => memoryAdapter() })(
    post('/api/jarvis', { role: 'email', prompt: 'Draft a reply' }));
  assert.match(urls[0], /models\/gemini-email:generateContent$/);
});
