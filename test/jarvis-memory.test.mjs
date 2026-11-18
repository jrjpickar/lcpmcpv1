import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { createJarvisMemoryHandler } from '../netlify/functions/jarvis-memory.mjs';
import { createMemory, guidanceFor, memoryAdapter, similarity, tokens } from '../netlify/functions/lib/jarvis-memory.mjs';

const env = { LCP_STUDIO_KEY: 'gateway-studio-key-for-testing', GROQ_API_KEY: 'test-provider-key' };
const origin = 'https://lcp.example';
const headers = { origin, 'content-type': 'application/json', 'x-lcp-studio-key': env.LCP_STUDIO_KEY };
const post = (path, body, extra = {}) => new Request(origin + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
const get = path => new Request(origin + path, { headers: { 'x-lcp-studio-key': env.LCP_STUDIO_KEY } });
const modelResponse = content => Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
const filters = { preset: '7d' };

function setup(answer) {
  const store = memoryAdapter();
  const calls = [];
  const fetchImpl = async (_url, input) => {
    const body = JSON.parse(input.body);
    calls.push(body);
    return modelResponse(answer(body, calls.length));
  };
  const jarvis = createJarvisHandler({ env, fetchImpl, openStore: async () => store, readSystems: async () => ({ current: { dials: 18 } }) });
  const memory = createJarvisMemoryHandler({ env, fetchImpl, openStore: async () => store });
  return { store, calls, jarvis, memory };
}

test('Chats persist per agent and later turns send real chat history', async () => {
  const { calls, jarvis, memory } = setup((_body, n) => n === 1 ? '18 dials this week.' : 'Up 4 from last week.');
  const first = await (await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'How many dials?', filters, newThread: true }))).json();
  assert.equal(first.answer, '18 dials this week.');
  assert.ok(first.threadId && first.messageId);
  assert.equal(first.title, 'How many dials?');
  const second = await (await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'And versus last week?', filters, threadId: first.threadId }))).json();
  assert.equal(second.threadId, first.threadId);
  const { messages } = calls[1];
  assert.deepEqual(messages.slice(1, 3).map(item => [item.role, item.content]), [['user', 'How many dials?'], ['assistant', '18 dials this week.']]);
  assert.equal(JSON.parse(messages.at(-1).content).previousTask, 'How many dials?');

  const list = await (await memory(get('/api/jarvis-memory?role=systems'))).json();
  assert.equal(list.threads.length, 1);
  assert.equal(list.threads[0].count, 4);
  assert.equal(list.memory.stats.runs, 2);
  assert.deepEqual((await (await memory(get('/api/jarvis-memory?role=market'))).json()).threads, []);
  const { thread } = await (await memory(get('/api/jarvis-memory?role=systems&thread=' + first.threadId))).json();
  assert.deepEqual(thread.messages.map(item => item.content), ['How many dials?', '18 dials this week.', 'And versus last week?', 'Up 4 from last week.']);
  assert.equal((await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'x', filters, threadId: crypto.randomUUID() }))).status, 404);
  assert.equal((await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'x', filters, threadId: '../escape' }))).status, 400);
});

test('Remember commands, feedback and corrections shape the next prompt', async () => {
  const { calls, jarvis, memory } = setup(() => 'Dials are 18. Call the hot list first.');
  const saved = await (await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'remember: always end with one next action', newThread: true }))).json();
  assert.match(saved.answer, /always end with one next action/);
  assert.equal(calls.length, 0);
  const reply = await (await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'Summarize dial performance by rep', filters, threadId: saved.threadId }))).json();
  assert.match(calls[0].messages[0].content, /always end with one next action/);

  const feedback = await memory(post('/api/jarvis-memory', { action: 'feedback', role: 'systems', threadId: reply.threadId, messageId: reply.messageId, rating: -1, note: 'Show numbers per rep in a list' }));
  assert.equal(feedback.status, 200);
  const learned = (await feedback.json()).memory;
  assert.equal(learned.stats.down, 1);
  assert.ok(learned.lessons.some(item => item.text === 'Show numbers per rep in a list' && item.source === 'correction'));

  // Switch to helpful: counts move, and the reply becomes a retrievable example for similar prompts.
  const up = await (await memory(post('/api/jarvis-memory', { action: 'feedback', role: 'systems', threadId: reply.threadId, messageId: reply.messageId, rating: 1 }))).json();
  assert.equal(up.memory.stats.up, 1);
  assert.equal(up.memory.stats.down, 0);
  await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'Summarize dial performance for each rep', filters, newThread: true }));
  const system = calls[1].messages[0].content;
  assert.match(system, /Show numbers per rep in a list/);
  assert.match(system, /approved for similar requests[\s\S]*Call the hot list first/);
  assert.equal(calls[1].messages.length, 2);
  assert.equal((await memory(post('/api/jarvis-memory', { action: 'feedback', role: 'systems', threadId: reply.threadId, messageId: reply.messageId, rating: 5 }))).status, 400);
});

test('Reflection rewrites the playbook automatically after repeated feedback', async () => {
  const { calls, jarvis, memory } = setup(body => /operating playbook/.test(body.messages[0].content)
    ? { playbook: ['Lead with the single biggest KPI change.', 'List per rep figures as bullets.'] }
    : 'Answer.');
  let threadId;
  const ids = [];
  for (let i = 0; i < 5; i++) {
    const result = await (await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'Question ' + i, filters, ...(threadId ? { threadId } : { newThread: true }) }))).json();
    threadId = result.threadId;
    ids.push(result.messageId);
  }
  let last;
  for (const [index, messageId] of ids.entries()) {
    last = await (await memory(post('/api/jarvis-memory', { action: 'feedback', role: 'systems', threadId, messageId, rating: index % 2 ? 1 : -1, note: index === 0 ? 'Too long' : undefined }))).json();
    if (index < 4) assert.equal(last.reflection, null);
  }
  assert.equal(last.reflection, 'updated');
  assert.deepEqual(last.memory.playbook, ['Lead with the single biggest KPI change.', 'List per rep figures as bullets.']);
  assert.equal(last.memory.stats.reflections, 1);
  assert.equal(last.memory.stats.feedbackSinceReflect, 0);
  assert.ok(last.memory.lessons.every(item => item.consolidated));
  const reflection = JSON.parse(calls.at(-1).messages[1].content);
  assert.equal(reflection.dislikedReplies.length, 3);
  assert.equal(reflection.likedReplies.length, 2);
  await jarvis(post('/api/jarvis', { role: 'systems', prompt: 'Next', filters, threadId }));
  const system = calls.at(-1).messages[0].content;
  assert.match(system, /Lead with the single biggest KPI change/);
  assert.doesNotMatch(system, /Too long/);
});

test('Build learns from QC rejections and manual lessons can be managed', async () => {
  const draft = { page: 'sales', title: 'Dials', type: 'metric', metric: 'dials' };
  const { calls, jarvis, memory } = setup((body, n) => /independent QC/.test(body.messages[0].content)
    ? { approved: n > 2, findings: n > 2 ? 'Looks right.' : 'Title does not match the requested KPI.' }
    : { summary: 'Dials card', modules: [draft] });
  const rejected = await (await jarvis(post('/api/jarvis', { role: 'build', prompt: 'Add Dials to Sales', newThread: true }))).json();
  assert.equal(rejected.approved, false);
  await jarvis(post('/api/jarvis', { role: 'build', prompt: 'Try again', threadId: rejected.threadId }));
  assert.match(calls[2].messages[0].content, /Recent QC rejections[\s\S]*Title does not match/);
  // Automatic QC stays independent of the Build playbook but sees the chat.
  assert.doesNotMatch(calls[3].messages[0].content, /Recent QC rejections/);
  assert.ok(calls[3].messages.some(item => item.role === 'assistant'));

  const added = await (await memory(post('/api/jarvis-memory', { action: 'lesson-add', role: 'build', text: 'Prefer panels over single cards' }))).json();
  assert.equal(added.memory.stats.qcFail, 1);
  assert.equal(added.memory.stats.qcPass, 1);
  const lesson = added.memory.lessons.find(item => item.source === 'manual');
  const removed = await (await memory(post('/api/jarvis-memory', { action: 'lesson-delete', role: 'build', lessonId: lesson.id }))).json();
  assert.equal(removed.memory.lessons.length, 0);
  await memory(post('/api/jarvis-memory', { action: 'delete', role: 'build', threadId: rejected.threadId }));
  assert.deepEqual((await (await memory(get('/api/jarvis-memory?role=build'))).json()).threads, []);
  const reset = await (await memory(post('/api/jarvis-memory', { action: 'reset', role: 'build' }))).json();
  assert.equal(reset.memory.stats.runs, 0);
});

test('Memory endpoint enforces the administrator key, origin and storage failures', async () => {
  const { memory } = setup(() => 'x');
  assert.equal((await memory(new Request(origin + '/api/jarvis-memory?role=systems'))).status, 401);
  assert.equal((await memory(post('/api/jarvis-memory', { action: 'reset', role: 'systems' }, { origin: 'https://other.example' }))).status, 403);
  assert.equal((await memory(get('/api/jarvis-memory?role=shell'))).status, 400);
  const broken = createJarvisMemoryHandler({ env, openStore: async () => { throw new Error('no blobs'); } });
  assert.equal((await broken(get('/api/jarvis-memory?role=systems'))).status, 503);
  const jarvis = createJarvisHandler({ env, openStore: async () => { throw new Error('no blobs'); }, fetchImpl: async () => assert.fail() });
  assert.equal((await jarvis(post('/api/jarvis', { role: 'market', prompt: 'News', newThread: true }))).status, 503);
});

test('Threads are capped, concurrent writes retry, and retrieval favors similar prompts', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  const thread = await memory.createThread('market', 'First');
  await Promise.all([1, 2, 3].map(n => memory.appendExchange('market', thread.id, 'Q' + n, { content: 'A' + n })));
  assert.equal((await memory.getThread('market', thread.id)).messages.length, 6);
  for (let i = 0; i < 52; i++) await memory.createThread('market', 'Chat ' + i);
  const threads = await memory.listThreads('market');
  assert.equal(threads.length, 50);
  assert.equal(await memory.getThread('market', thread.id), null);
  assert.ok(similarity(tokens('dial performance by rep'), tokens('rep dial performance this week')) > 0.5);
  const text = guidanceFor('systems', { playbook: [], lessons: [], exemplars: [
    { prompt: 'Market rates and mortgage news', answer: 'Unrelated' },
    { prompt: 'Rep dial performance summary', answer: 'Matched answer' },
  ] }, 'Summarize rep dial performance');
  assert.match(text, /Matched answer/);
  assert.doesNotMatch(text, /Unrelated/);
});
