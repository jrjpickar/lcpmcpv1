import test from 'node:test';
import assert from 'node:assert/strict';
import { createJarvisMemoryHandler } from '../netlify/functions/jarvis-memory.mjs';
import { createMemory, limits, memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { env, fakeGroq, get, post } from './jarvis-helpers.mjs';

const api = (store, fetchImpl = fakeGroq({ playbook: ['Lead with numbers'] }).fetchImpl, extraEnv = {}) =>
  createJarvisMemoryHandler({ env: { ...env, ...extraEnv }, fetchImpl, openStore: async () => store });
const send = async (run, body, headers) => {
  const response = await run(post('/api/jarvis-memory', body, headers));
  return { status: response.status, data: await response.json() };
};

async function seedThread(memory, role = 'systems', prompt = 'How are wins?', answer = 'Wins are 4.', meta = { trace: [role] }) {
  const thread = await memory.createThread(role, prompt);
  const { reply } = await memory.appendExchange(role, thread.id, prompt, { content: answer, meta });
  return { thread, reply };
}

test('memory endpoint enforces auth, origin, JSON, valid actions and storage availability', async () => {
  const run = api(memoryAdapter());
  assert.equal((await run(get('/api/jarvis-memory?role=systems', { 'x-lcp-studio-key': 'wrong-key-wrong-key' }))).status, 401);
  assert.equal((await send(run, { action: 'reset', role: 'systems' }, { origin: 'https://evil.test' })).status, 403);
  assert.equal((await send(run, { action: 'reset', role: 'systems' }, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send(run, { action: 'explode', role: 'systems' })).status, 400);
  assert.equal((await send(run, { action: 'feedback', role: 'systems', threadId: 'nope', messageId: 'x', rating: 1 })).status, 400);
  assert.equal((await run(get('/api/jarvis-memory?role=../etc'))).status, 400);
  assert.equal((await run(new Request('https://lcp.example/api/jarvis-memory?role=systems', { method: 'DELETE', headers: { 'x-lcp-studio-key': env.LCP_STUDIO_KEY } }))).status, 405);
  const down = createJarvisMemoryHandler({ env, openStore: async () => { throw new Error('down'); } });
  assert.equal((await down(get('/api/jarvis-memory?role=systems'))).status, 503);
  const failing = memoryAdapter();
  failing.getWithMetadata = async () => { throw new Error('blob outage'); };
  assert.equal((await api(failing)(get('/api/jarvis-memory?role=systems'))).status, 503);
});

test('chats: list, open, rename, pin, search and delete', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  const a = await seedThread(memory, 'systems', 'Runway check', 'Runway is 2.8 months.');
  const b = await seedThread(memory, 'systems', 'Crew status', 'Eight workers are available on the bench.');
  const run = api(store);
  let list = await (await run(get('/api/jarvis-memory?role=systems'))).json();
  assert.deepEqual(list.threads.map(t => t.id), [b.thread.id, a.thread.id]);
  assert.ok(list.memory.stats && Array.isArray(list.shared) && Array.isArray(list.bots));
  const opened = await (await run(get('/api/jarvis-memory?role=systems&thread=' + a.thread.id))).json();
  assert.equal(opened.thread.messages.length, 2);

  assert.equal((await send(run, { action: 'rename', role: 'systems', threadId: a.thread.id, text: 'Runway review' })).status, 200);
  assert.equal((await send(run, { action: 'pin', role: 'systems', threadId: a.thread.id, pinned: true })).status, 200);
  list = await (await run(get('/api/jarvis-memory?role=systems'))).json();
  assert.equal(list.threads[0].id, a.thread.id, 'pinned chat sorts first');
  assert.equal(list.threads[0].title, 'Runway review');

  const byTitle = await (await run(get('/api/jarvis-memory?role=systems&q=runway'))).json();
  assert.equal(byTitle.results.length, 1);
  const byText = await (await run(get('/api/jarvis-memory?role=systems&q=bench'))).json();
  assert.equal(byText.results[0].id, b.thread.id);
  assert.match(byText.results[0].snippet, /bench/);
  assert.equal((await run(get('/api/jarvis-memory?role=systems&q=x'))).status, 400);

  assert.equal((await send(run, { action: 'delete', role: 'systems', threadId: b.thread.id })).status, 200);
  list = await (await run(get('/api/jarvis-memory?role=systems'))).json();
  assert.equal(list.threads.length, 1);
});

test('search results are capped and pinned chats are never trimmed', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  const pinned = await seedThread(memory, 'systems', 'Keep me', 'pinned answer');
  await memory.pinThread('systems', pinned.thread.id, true);
  for (let i = 0; i < limits.threads + 5; i++) await seedThread(memory, 'systems', 'Wins question ' + i, 'answer');
  const threads = await memory.listThreads('systems');
  assert.equal(threads.length, limits.threads);
  assert.equal(threads[0].id, pinned.thread.id);
  assert.ok(await memory.getThread('systems', pinned.thread.id), 'pinned thread blob kept');
  assert.equal((await memory.searchThreads('systems', 'wins question')).length, limits.searchResults);
  for (let i = 0; i < limits.pinned - 1; i++) await memory.pinThread('systems', threads[i + 1].id, true);
  await assert.rejects(memory.pinThread('systems', threads[limits.pinned + 1].id, true), /Unpin a chat first/);
});

test('lessons, reset, shared company memory with its cap', async () => {
  const store = memoryAdapter();
  const run = api(store);
  let { data } = await send(run, { action: 'lesson-add', role: 'market', text: 'Cite Fed releases first' });
  assert.equal(data.memory.lessons[0].text, 'Cite Fed releases first');
  ({ data } = await send(run, { action: 'lesson-delete', role: 'market', id: data.memory.lessons[0].id }));
  assert.equal(data.memory.lessons.length, 0);
  ({ data } = await send(run, { action: 'shared-add', role: 'systems', text: 'Buy box is 3 bed SFR in LA County' }));
  assert.equal(data.shared.length, 1);
  assert.equal((await send(run, { action: 'shared-add', role: 'systems', text: 'x'.repeat(301) })).status, 400);
  for (let i = 1; i < limits.shared; i++) await send(run, { action: 'shared-add', role: 'systems', text: 'Fact ' + i });
  const full = await send(run, { action: 'shared-add', role: 'systems', text: 'One too many' });
  assert.equal(full.status, 409);
  ({ data } = await send(run, { action: 'shared-delete', role: 'systems', id: data.shared[0].id }));
  assert.equal(data.shared.length, limits.shared - 1);
  await send(run, { action: 'lesson-add', role: 'market', text: 'temp' });
  ({ data } = await send(run, { action: 'reset', role: 'market' }));
  assert.equal(data.memory.lessons.length, 0);
});

test('custom bots: create, update, delete', async () => {
  const store = memoryAdapter();
  const run = api(store);
  const bot = { name: 'Offer Coach', description: 'Offer math', instructions: 'Check MAO math and offer wording.', context: 'none' };
  let { status, data } = await send(run, { action: 'bot-create', role: 'systems', bot });
  assert.equal(status, 200);
  assert.equal(data.bot.id, 'bot-offer-coach');
  assert.equal((await send(run, { action: 'bot-create', role: 'systems', bot })).status, 409);
  assert.equal((await send(run, { action: 'bot-create', role: 'systems', bot: { ...bot, context: 'shell' } })).status, 400);
  ({ data } = await send(run, { action: 'bot-update', role: 'bot-offer-coach', bot: { ...bot, context: 'metrics' } }));
  assert.equal(data.bot.context, 'metrics');
  const list = await (await run(get('/api/jarvis-memory?role=bot-offer-coach'))).json();
  assert.equal(list.bots.length, 1);
  ({ data } = await send(run, { action: 'bot-delete', role: 'bot-offer-coach' }));
  assert.equal(data.bots.length, 0);
  assert.equal((await run(get('/api/jarvis-memory?role=bot-offer-coach'))).status, 404);
});

test('feedback makes approved examples and reflects after 5 ratings', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  const groq = fakeGroq((body) => {
    assert.equal(body.response_format.type, 'json_object');
    assert.match(body.messages[0].content, /playbook for the Market news agent of LocalCare Props/);
    return { playbook: ['Lead with rate moves', 'Cite release and date'] };
  });
  const run = api(store, groq.fetchImpl);
  const seeded = [];
  for (let i = 0; i < 5; i++) seeded.push(await seedThread(memory, 'market', 'Market question ' + i, 'Answer ' + i, { trace: ['market'] }));
  let result;
  for (const [i, { thread, reply }] of seeded.entries()) {
    result = await send(run, { action: 'feedback', role: 'market', threadId: thread.id, messageId: reply.id, rating: i < 4 ? 1 : -1, ...(i === 4 ? { note: 'Mention the source' } : {}) });
    assert.equal(result.status, 200);
    assert.equal(result.data.learner, 'market');
  }
  assert.equal(result.data.reflection, 'updated');
  assert.equal(groq.calls.length, 1);
  const market = await memory.getMemory('market');
  assert.deepEqual(market.playbook, ['Lead with rate moves', 'Cite release and date']);
  assert.equal(market.exemplars.length, 4);
  assert.equal(market.stats.up, 4);
  assert.equal(market.playbookMeta.version, 1);
  assert.equal(market.versions[0].version, 0);
  assert.equal(market.versions[0].up, 4, 'version 0 keeps its measured ratings');
  assert.ok(market.lessons.find(l => l.text === 'Mention the source').consolidated);
});

test('reflection output is validated strictly and manual lessons are always kept', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  await memory.addLesson('systems', 'Always show runway first');
  for (const bad of [{ playbook: 'one rule' }, { playbook: Array(11).fill('rule') }, { playbook: ['ok', 7] }, { playbook: ['ok'], extra: true }, { playbook: ['x'.repeat(241)] }]) {
    const { status, data } = await send(api(store, fakeGroq(bad).fetchImpl), { action: 'reflect', role: 'systems' });
    assert.equal(status, 502);
    assert.match(data.error, /invalid playbook/);
  }
  const { data } = await send(api(store), { action: 'reflect', role: 'systems' });
  assert.deepEqual(data.memory.playbook, ['Lead with numbers']);
  assert.equal(data.memory.lessons[0].consolidated, false, 'manual lessons are never consolidated');
  assert.equal((await send(api(store, undefined, { GROQ_API_KEY: '' }), { action: 'reflect', role: 'systems' })).status, 503);
});

test('a playbook that drops the helpful rate 20+ points is rolled back after 6 ratings, and can be restored manually', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  const rate = async (rating, n) => {
    for (let i = 0; i < n; i++) {
      const { thread, reply } = await seedThread(memory, 'systems', 'q', 'a');
      const { rolledBack } = await memory.feedback('systems', thread.id, reply.id, rating, rating < 0 ? 'Shorter please ' + i : '');
      if (rolledBack) return rolledBack;
    }
    return null;
  };
  await rate(1, 4); // Version 0: 100% helpful over 4 ratings.
  await memory.addLesson('systems', 'Use short bullets', 'correction');
  await memory.reflect('systems', async () => ({ playbook: ['Write long essays'] }), 'Systems');
  let data = await memory.getMemory('systems');
  assert.equal(data.playbookMeta.version, 1);
  const consolidated = data.lessons.filter(l => l.consolidated).length;
  assert.ok(consolidated > 0);
  assert.equal(await rate(1, 1), null);
  const rolled = await rate(-1, 5); // 1 of 6 helpful under version 1.
  assert.ok(rolled, 'rollback triggered on the 6th rating');
  assert.deepEqual([rolled.from, rolled.to, rolled.manual], [1, 0, false]);
  data = await memory.getMemory('systems');
  assert.deepEqual(data.playbook, []);
  assert.equal(data.playbookMeta.version, 0);
  assert.equal(data.versions[0].version, 1);
  assert.equal(data.lessons.filter(l => l.consolidated).length, 0, 'lessons merged into the failed playbook are active again');

  // No rollback when the drop is under 20 points.
  const store2 = memoryAdapter();
  const memory2 = createMemory(store2);
  const rate2 = async (rating, n) => { for (let i = 0; i < n; i++) { const { thread, reply } = await seedThread(memory2, 'systems', 'q', 'a'); await memory2.feedback('systems', thread.id, reply.id, rating); } };
  await rate2(1, 3); await rate2(-1, 1); // 75%
  await memory2.reflect('systems', async () => ({ playbook: ['Rule'] }), 'Systems');
  await rate2(1, 4); await rate2(-1, 2); // 67%, drop of 8 points
  data = await memory2.getMemory('systems');
  assert.deepEqual(data.playbook, ['Rule']);
  assert.equal(data.playbookMeta.evaluated, true);

  // Manual restore through the endpoint.
  const { status, data: restored } = await send(api(store2), { action: 'playbook-restore', role: 'systems', version: 0 });
  assert.equal(status, 200);
  assert.equal(restored.memory.playbookVersion.version, 0);
  assert.equal(restored.memory.rollbacks[0].manual, true);
  assert.equal((await send(api(store2), { action: 'playbook-restore', role: 'systems', version: 9 })).status, 404);
});

test('conditional writes retry on a concurrent change and give up with 409', async () => {
  const store = memoryAdapter();
  const memory = createMemory(store);
  const original = store.setJSON.bind(store);
  let conflicts = 2;
  store.setJSON = async (key, data, condition) => {
    if (key === 'memory/systems' && conflicts-- > 0) {
      // Another writer lands first: the stored etag moves, so this conditional write must fail and retry.
      const current = await store.getWithMetadata(key);
      await original(key, current?.data ?? { lessons: [] }, {});
      return { modified: false };
    }
    return original(key, data, condition);
  };
  await memory.addLesson('systems', 'survives retries');
  assert.equal((await memory.getMemory('systems')).lessons[0].text, 'survives retries');
  store.setJSON = async () => ({ modified: false });
  const { status, data } = await send(api(store), { action: 'lesson-add', role: 'systems', text: 'never lands' });
  assert.equal(status, 409);
  assert.match(data.error, /Retry/);
});
