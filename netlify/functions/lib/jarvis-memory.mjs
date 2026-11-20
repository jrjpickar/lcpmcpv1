import { topicFor } from '../../../public/topic-rules.mjs';
// Persistent chat threads and learned memory for the LCP JARVIS agents.
// Each agent keeps its own threads, operator lessons, approved answers and a playbook that a reflection pass
// rewrites from feedback. Also: shared company memory, playbook versions with automatic rollback, pinned chats,
// chat search, custom bots and a history budget.
// Storage is any key/value adapter with getWithMetadata, setJSON (conditional writes) and delete, such as Netlify Blobs.
import { randomUUID } from 'node:crypto';

export { openJarvisStore, STORE_NAME } from './jarvis-store.mjs';
export const limits = {
  threads: 50, messages: 80, message: 6000, history: 6, historyChars: 1200, historyBudget: 6000,
  lessons: 30, lesson: 300, exemplars: 25, disliked: 10, qcFindings: 5, playbookRules: 10, reflectEvery: 5,
  pinned: 10, shared: 20, sharedText: 300, versions: 3, rollbackWindow: 6, rollbackDrop: 0.2, rollbackBaseline: 3,
  rollbackLog: 10, searchResults: 20, bots: 12, botInstructions: 1500, botDescription: 200,
};

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const validId = value => typeof value === 'string' && idPattern.test(value);

const stop = new Set('the and for with that this from what how are was were you your our have has had into over show give make about which when then than them they their there these those will would could should can just also only each more most some such very please'.split(' '));
export function tokens(value) {
  return new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(word => !stop.has(word)) || []);
}
export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.sqrt(a.size * b.size);
}

export const clip = (value, max) => String(value ?? '').replace(/[\u2013\u2014]/g, '-').trim().slice(0, max);
const now = () => new Date().toISOString();
const keys = {
  index: role => 'index/' + role,
  thread: (role, id) => 'thread/' + role + '/' + id,
  memory: role => 'memory/' + role,
  shared: () => 'shared',
  bots: () => 'bots',
};
const emptyMemory = () => ({
  playbook: [], lessons: [], exemplars: [], disliked: [], qcFindings: [],
  playbookMeta: { version: 0, at: null, up: 0, down: 0, restored: false, evaluated: false },
  versions: [], rollbacks: [],
  stats: { runs: 0, up: 0, down: 0, qcPass: 0, qcFail: 0, reflections: 0, feedbackSinceReflect: 0, lastReflectAt: null },
});
const fail = (message, agentStatus) => Object.assign(new Error(message), { agentStatus });
const conflict = () => fail('Memory changed during the update. Retry.', 409);

async function read(store, key, fallback) {
  const entry = await store.getWithMetadata(key, { type: 'json' });
  return entry?.data ?? fallback();
}

// Conditional read-modify-write. Retries on a concurrent change, then gives up with 409.
export async function update(store, key, fallback, mutate) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const entry = await store.getWithMetadata(key, { type: 'json' });
    const data = entry?.data ?? fallback();
    const result = mutate(data);
    if (result === false) return { data, result };
    const saved = await store.setJSON(key, data, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
    if (saved?.modified) return { data, result };
  }
  throw conflict();
}

// In-process adapter for tests.
export function memoryAdapter() {
  const items = new Map();
  return {
    items,
    async getWithMetadata(key) {
      const item = items.get(key);
      return item ? { data: structuredClone(item.data), etag: item.etag } : null;
    },
    async setJSON(key, data, condition = {}) {
      const current = items.get(key);
      if (condition.onlyIfNew ? current : condition.onlyIfMatch && current?.etag !== condition.onlyIfMatch) return { modified: false };
      const etag = randomUUID();
      items.set(key, { data: structuredClone(data), etag });
      return { modified: true, etag };
    },
    async delete(key) { items.delete(key); },
  };
}

const rate = ({ up, down }) => (up + down ? up / (up + down) : null);
const trimLessons = data => {
  while (data.lessons.length > limits.lessons) {
    const index = data.lessons.findLastIndex(item => item.source !== 'manual');
    data.lessons.splice(index >= 0 ? index : data.lessons.length - 1, 1);
  }
};
const sortThreads = threads => [...threads].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
const slug = name => clip(name, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
export const botContexts = ['metrics', 'mail', 'none'];

export function createMemory(store) {
  const memory = {
    async listThreads(role) {
      const { threads } = await read(store, keys.index(role), () => ({ threads: [] }));
      return sortThreads(threads.map(entry => ({ ...entry, topic: entry.topic || topicFor(entry.title) })));
    },

    async getThread(role, id) {
      if (!validId(id)) return null;
      return read(store, keys.thread(role, id), () => null);
    },

    async getMemory(role) {
      const data = { ...emptyMemory(), ...(await read(store, keys.memory(role), emptyMemory)) };
      data.playbookMeta = { ...emptyMemory().playbookMeta, ...data.playbookMeta };
      return data;
    },

    async createThread(role, firstPrompt) {
      const thread = { id: randomUUID(), role, title: clip(firstPrompt, 60) || 'New chat', topic: topicFor(firstPrompt), createdAt: now(), updatedAt: now(), messages: [] };
      await store.setJSON(keys.thread(role, thread.id), thread, { onlyIfNew: true });
      const dropped = [];
      await update(store, keys.index(role), () => ({ threads: [] }), index => {
        dropped.length = 0;
        index.threads.unshift({ id: thread.id, title: thread.title, topic: thread.topic, updatedAt: thread.updatedAt, count: 0 });
        // Pinned chats are never trimmed. The oldest unpinned chat goes first.
        while (index.threads.length > limits.threads) {
          const position = index.threads.findLastIndex(entry => !entry.pinned);
          if (position < 0) break;
          dropped.push(index.threads.splice(position, 1)[0].id);
        }
      });
      await Promise.all(dropped.map(id => store.delete(keys.thread(role, id))));
      return thread;
    },

    // Appends one exchange and refreshes the index entry. Returns the stored assistant message.
    async appendExchange(role, id, user, assistant) {
      const userMessage = { id: randomUUID(), role: 'user', content: clip(user, limits.message), at: now() };
      const reply = { id: randomUUID(), role: 'assistant', content: clip(assistant.content, limits.message), at: now(), meta: assistant.meta || {} };
      const { data } = await update(store, keys.thread(role, id), () => null, thread => {
        if (!thread) throw fail('Chat not found.', 404);
        thread.messages.push(userMessage, reply);
        if (thread.messages.length > limits.messages) thread.messages.splice(0, thread.messages.length - limits.messages);
        thread.updatedAt = reply.at;
      });
      await update(store, keys.index(role), () => ({ threads: [] }), index => {
        const position = index.threads.findIndex(entry => entry.id === id);
        const entry = position >= 0 ? index.threads.splice(position, 1)[0] : { id, title: data.title, topic: data.topic || topicFor(data.title) };
        index.threads.unshift({ ...entry, updatedAt: data.updatedAt, count: data.messages.length });
      });
      return { userMessage, reply, title: data.title };
    },

    async renameThread(role, id, title) {
      const value = clip(title, 60);
      if (!value) throw fail('Enter a chat title.', 400);
      await update(store, keys.thread(role, id), () => null, thread => {
        if (!thread) throw fail('Chat not found.', 404);
        thread.title = value;
      });
      await update(store, keys.index(role), () => ({ threads: [] }), index => {
        const entry = index.threads.find(item => item.id === id);
        if (!entry) return false;
        entry.title = value;
      });
    },

    async pinThread(role, id, pinned) {
      await update(store, keys.index(role), () => ({ threads: [] }), index => {
        const entry = index.threads.find(item => item.id === id);
        if (!entry) throw fail('Chat not found.', 404);
        if (pinned && !entry.pinned && index.threads.filter(item => item.pinned).length >= limits.pinned) {
          throw fail('Unpin a chat first. Up to ' + limits.pinned + ' chats can be pinned.', 409);
        }
        if (Boolean(entry.pinned) === pinned) return false;
        if (pinned) entry.pinned = true;
        else delete entry.pinned;
      });
    },

    async deleteThread(role, id) {
      await store.delete(keys.thread(role, id));
      await update(store, keys.index(role), () => ({ threads: [] }), index => {
        const before = index.threads.length;
        index.threads = index.threads.filter(entry => entry.id !== id);
        if (index.threads.length === before) return false;
      });
    },

    // Case-insensitive search over chat titles and message text for one agent. Capped results.
    async searchThreads(role, query) {
      const needle = clip(query, 80).toLowerCase();
      if (needle.length < 2) throw fail('Enter at least 2 characters to search.', 400);
      const index = await memory.listThreads(role);
      const results = [];
      for (let start = 0; start < index.length && results.length < limits.searchResults; start += 10) {
        const batch = await Promise.all(index.slice(start, start + 10).map(entry => memory.getThread(role, entry.id).then(thread => ({ entry, thread }))));
        for (const { entry, thread } of batch) {
          if (results.length >= limits.searchResults) break;
          const titleHit = entry.title.toLowerCase().includes(needle);
          const message = thread?.messages.find(item => item.content.toLowerCase().includes(needle));
          if (!titleHit && !message) continue;
          let snippet = '';
          if (message) {
            const at = message.content.toLowerCase().indexOf(needle);
            snippet = (at > 40 ? '...' : '') + message.content.slice(Math.max(0, at - 40), at + needle.length + 80).replace(/\s+/g, ' ');
          }
          results.push({ id: entry.id, title: entry.title, updatedAt: entry.updatedAt, pinned: Boolean(entry.pinned), messageId: message?.id || null, snippet });
        }
      }
      return results;
    },

    async recordRun(role, { approved } = {}) {
      await update(store, keys.memory(role), emptyMemory, data => {
        data.stats.runs++;
        if (approved === true) data.stats.qcPass++;
        if (approved === false) data.stats.qcFail++;
      });
    },

    async recordQcFinding(role, finding) {
      const text = clip(finding, limits.lesson);
      if (!text) return;
      await update(store, keys.memory(role), emptyMemory, data => {
        data.qcFindings.unshift({ text, at: now() });
        data.qcFindings.length = Math.min(data.qcFindings.length, limits.qcFindings);
      });
    },

    async addLesson(role, text, source = 'manual') {
      const value = clip(text, limits.lesson);
      if (!value) throw fail('Enter a lesson.', 400);
      const lesson = { id: randomUUID(), text: value, source, at: now(), consolidated: false };
      await update(store, keys.memory(role), emptyMemory, data => {
        data.lessons.unshift(lesson);
        trimLessons(data);
      });
      return lesson;
    },

    async deleteLesson(role, lessonId) {
      await update(store, keys.memory(role), emptyMemory, data => {
        const before = data.lessons.length;
        data.lessons = data.lessons.filter(item => item.id !== lessonId);
        if (data.lessons.length === before) return false;
      });
    },

    async resetMemory(role) {
      await store.setJSON(keys.memory(role), emptyMemory(), {});
    },

    // Shared company memory: facts and rules every agent receives. Separate from per-agent memory.
    async getShared() {
      return (await read(store, keys.shared(), () => ({ entries: [] }))).entries;
    },

    async addShared(text) {
      const value = clip(text, limits.sharedText);
      if (!value) throw fail('Enter a company fact or rule.', 400);
      const entry = { id: randomUUID(), text: value, at: now() };
      await update(store, keys.shared(), () => ({ entries: [] }), data => {
        if (data.entries.length >= limits.shared) throw fail('Company memory is full (' + limits.shared + ' entries). Delete one first.', 409);
        data.entries.unshift(entry);
      });
      return entry;
    },

    async deleteShared(id) {
      await update(store, keys.shared(), () => ({ entries: [] }), data => {
        const before = data.entries.length;
        data.entries = data.entries.filter(item => item.id !== id);
        if (data.entries.length === before) return false;
      });
    },

    // Custom bots the operator creates over time. Each bot gets its own chats and memory.
    async getBots() {
      return (await read(store, keys.bots(), () => ({ bots: [] }))).bots;
    },

    async saveBot(input, existingId = null) {
      const name = clip(input?.name, 40);
      const description = clip(input?.description, limits.botDescription);
      const instructions = clip(input?.instructions, limits.botInstructions);
      const context = input?.context ?? 'none';
      if (!name || !instructions || !botContexts.includes(context)) throw fail('Enter a name, instructions and a valid data source for the bot.', 400);
      let saved;
      await update(store, keys.bots(), () => ({ bots: [] }), data => {
        if (existingId) {
          const bot = data.bots.find(item => item.id === existingId);
          if (!bot) throw fail('Bot not found.', 404);
          Object.assign(bot, { name, description, instructions, context, updatedAt: now() });
          saved = bot;
          return;
        }
        const id = 'bot-' + slug(name);
        if (id.length < 6) throw fail('Use a bot name with at least 2 letters or digits.', 400);
        if (data.bots.some(item => item.id === id)) throw fail('A bot with this name already exists.', 409);
        if (data.bots.length >= limits.bots) throw fail('Up to ' + limits.bots + ' custom bots. Delete one first.', 409);
        saved = { id, name, description, instructions, context, createdAt: now() };
        data.bots.push(saved);
      });
      return saved;
    },

    async deleteBot(id) {
      let found = false;
      await update(store, keys.bots(), () => ({ bots: [] }), data => {
        const before = data.bots.length;
        data.bots = data.bots.filter(item => item.id !== id);
        found = data.bots.length !== before;
        if (!found) return false;
      });
      if (!found) throw fail('Bot not found.', 404);
      const threads = await memory.listThreads(id);
      await Promise.all([...threads.map(entry => store.delete(keys.thread(id, entry.id))), store.delete(keys.index(id)), store.delete(keys.memory(id))]);
    },

    // Rates an assistant message. Positive replies become retrievable examples,
    // negative replies and notes feed the next reflection. The agent that wrote the reply learns
    // (meta.agent when the main bot delegated), and its current playbook version is scored.
    async feedback(role, threadId, messageId, rating, note = '', canLearn = () => true) {
      if (![1, -1].includes(rating)) throw fail('Invalid rating.', 400);
      const correction = clip(note, limits.lesson);
      let previous = 0, previousVersion = null, prompt = '', answer = '', learner = role;
      const learnerMemory = await (async () => {
        const thread = await memory.getThread(role, threadId);
        const message = thread?.messages.find(item => item.id === messageId && item.role === 'assistant');
        if (message?.meta?.agent && message.meta.agent !== role && await canLearn(message.meta.agent)) learner = message.meta.agent;
        return memory.getMemory(learner);
      })();
      const version = learnerMemory.playbookMeta.version;
      await update(store, keys.thread(role, threadId), () => null, thread => {
        if (!thread) throw fail('Chat not found.', 404);
        const index = thread.messages.findIndex(item => item.id === messageId && item.role === 'assistant');
        if (index < 0) throw fail('Message not found.', 404);
        const message = thread.messages[index];
        previous = message.rating || 0;
        previousVersion = message.ratedVersion ?? null;
        prompt = thread.messages.slice(0, index).findLast(item => item.role === 'user')?.content || '';
        answer = [message.meta?.buildSummary, message.content, message.meta?.modules?.map(item => item.title + ' (' + item.type + ', ' + item.page + ')').join('; ')]
          .filter(Boolean).join('\n');
        message.rating = rating;
        message.ratedVersion = version;
        if (correction) message.note = correction;
      });
      let rolledBack = null;
      const { data } = await update(store, keys.memory(learner), emptyMemory, data => {
        rolledBack = null;
        data.playbookMeta = { ...emptyMemory().playbookMeta, ...data.playbookMeta };
        data.versions ||= [];
        data.rollbacks ||= [];
        const meta = data.playbookMeta;
        if (previous === 1) data.stats.up--;
        if (previous === -1) data.stats.down--;
        if (previous && previousVersion === meta.version) meta[previous === 1 ? 'up' : 'down']--;
        if (rating === 1) data.stats.up++;
        else data.stats.down++;
        meta[rating === 1 ? 'up' : 'down']++;
        data.exemplars = data.exemplars.filter(item => item.messageId !== messageId);
        data.disliked = data.disliked.filter(item => item.messageId !== messageId);
        if (rating === 1) {
          data.exemplars.unshift({ messageId, prompt: clip(prompt, 500), answer: clip(answer, 1500), at: now() });
          data.exemplars.length = Math.min(data.exemplars.length, limits.exemplars);
        } else {
          data.disliked.unshift({ messageId, prompt: clip(prompt, 400), answer: clip(answer, 800), note: correction, at: now() });
          data.disliked.length = Math.min(data.disliked.length, limits.disliked);
        }
        if (correction) {
          data.lessons.unshift({ id: randomUUID(), text: correction, source: rating === 1 ? 'praise' : 'correction', at: now(), consolidated: false });
          trimLessons(data);
        }
        if (previous !== rating || correction) data.stats.feedbackSinceReflect++;
        rolledBack = evaluateWindow(data);
      });
      return { data, learner, rolledBack };
    },

    // Rewrites the playbook from the current playbook, lessons and rated replies. Keeps the previous versions.
    async reflect(role, model, agentName) {
      const current = await memory.getMemory(role);
      const material = {
        currentPlaybook: current.playbook,
        lessons: current.lessons.map(({ text, source }) => ({ text, source })),
        likedReplies: current.exemplars.slice(0, 6).map(({ prompt, answer }) => ({ prompt, answer: answer.slice(0, 600) })),
        dislikedReplies: current.disliked.slice(0, 6).map(({ prompt, answer, note }) => ({ prompt, answer: answer.slice(0, 500), note })),
        qcRejections: current.qcFindings.map(item => item.text),
        stats: current.stats,
      };
      const result = await model(
        'You maintain the operating playbook for the ' + agentName + ' agent of LocalCare Props, a real estate wholesaler. ' +
        'Merge the current playbook, operator lessons, liked replies and disliked replies into at most ' + limits.playbookRules +
        ' short imperative rules that will make future answers more useful to this operator. ' +
        'Operator lessons outrank older rules. Liked replies show the preferred focus, depth and format. Disliked replies and QC rejections show what to avoid. ' +
        'Keep each rule specific, testable and under 200 characters. Do not include figures that go stale, secrets, or rules that weaken accuracy or safety. ' +
        'Never use em dashes or en dashes. Return JSON {"playbook":["rule", ...]}.',
        material, true,
      );
      if (!result || typeof result !== 'object' || Array.isArray(result) || Object.keys(result).some(key => key !== 'playbook')
        || !Array.isArray(result.playbook) || result.playbook.length > limits.playbookRules
        || result.playbook.some(rule => typeof rule !== 'string' || !rule.trim() || rule.length > 240)) {
        throw fail('Reflection returned an invalid playbook.', 502);
      }
      const consolidated = new Set(current.lessons.map(item => item.id));
      const { data } = await update(store, keys.memory(role), emptyMemory, data => {
        data.playbookMeta = { ...emptyMemory().playbookMeta, ...data.playbookMeta };
        data.versions ||= [];
        const meta = data.playbookMeta;
        data.versions.unshift({ version: meta.version, playbook: data.playbook, at: meta.at, up: meta.up, down: meta.down });
        data.versions.length = Math.min(data.versions.length, limits.versions);
        const version = meta.version + 1;
        data.playbook = result.playbook.map(rule => clip(rule, 240));
        data.playbookMeta = { version, at: now(), up: 0, down: 0, restored: false, evaluated: false };
        for (const lesson of data.lessons) {
          if (consolidated.has(lesson.id) && lesson.source !== 'manual' && !lesson.consolidated) Object.assign(lesson, { consolidated: true, consolidatedIn: version });
        }
        data.stats.reflections++;
        data.stats.feedbackSinceReflect = 0;
        data.stats.lastReflectAt = now();
      });
      return data;
    },

    // Manual restore of a kept playbook version.
    async restorePlaybook(role, version) {
      const { data } = await update(store, keys.memory(role), emptyMemory, data => {
        data.versions ||= [];
        data.rollbacks ||= [];
        const position = data.versions.findIndex(item => item.version === version);
        if (position < 0) throw fail('Playbook version not found.', 404);
        restore(data, position, true);
      });
      return data;
    },
  };
  return memory;
}

function restore(data, position, manual) {
  const meta = { ...emptyMemory().playbookMeta, ...data.playbookMeta };
  const target = data.versions.splice(position, 1)[0];
  data.rollbacks.unshift({ at: now(), from: meta.version, to: target.version, fromRate: rate(meta), toRate: rate(target), manual });
  data.rollbacks.length = Math.min(data.rollbacks.length, limits.rollbackLog);
  data.versions.unshift({ version: meta.version, playbook: data.playbook, at: meta.at, up: meta.up, down: meta.down });
  data.versions.length = Math.min(data.versions.length, limits.versions);
  // Lessons merged into the abandoned playbook become active again.
  for (const lesson of data.lessons) if (lesson.consolidatedIn === meta.version) Object.assign(lesson, { consolidated: false, consolidatedIn: undefined });
  data.playbook = target.playbook;
  data.playbookMeta = { version: target.version, at: now(), up: 0, down: 0, restored: true, evaluated: true };
}

// After the evaluation window (6 ratings under a new playbook), roll back automatically when the helpful rate
// fell 20 or more points below the previous version (which needs at least 3 ratings as a baseline).
function evaluateWindow(data) {
  const meta = data.playbookMeta;
  if (meta.restored || meta.evaluated || meta.up + meta.down < limits.rollbackWindow) return null;
  meta.evaluated = true;
  const previous = data.versions[0];
  if (!previous || previous.up + previous.down < limits.rollbackBaseline) return null;
  const drop = rate(previous) - rate(meta);
  if (drop < limits.rollbackDrop - 1e-9) return null;
  restore(data, 0, false);
  return data.rollbacks[0];
}

// Automatic reflection waits while a new playbook is still inside its evaluation window.
export function shouldReflect(data) {
  const meta = data.playbookMeta || {};
  const windowOpen = meta.version > 0 && !meta.restored && !meta.evaluated;
  return data.stats.feedbackSinceReflect >= limits.reflectEvery && !windowOpen;
}

// Learned guidance for one request: playbook, open lessons, QC rejections and the most similar approved answers.
export function guidanceFor(role, data, prompt) {
  if (!data) return '';
  const parts = [];
  if (data.playbook?.length) parts.push('Operator playbook learned from feedback. Follow it unless it conflicts with the rules above:\n' + data.playbook.map(rule => '- ' + rule).join('\n'));
  const lessons = (data.lessons || []).filter(item => item.source === 'manual' || !item.consolidated).slice(0, 10);
  if (lessons.length) parts.push('Operator instructions and corrections (newest first):\n' + lessons.map(item => '- ' + item.text).join('\n'));
  if (role === 'build' && data.qcFindings?.length) parts.push('Recent QC rejections. Do not repeat these problems:\n' + data.qcFindings.slice(0, 3).map(item => '- ' + item.text.slice(0, 240)).join('\n'));
  const query = tokens(prompt);
  const matches = (data.exemplars || [])
    .map(item => ({ item, score: similarity(query, tokens(item.prompt)) }))
    .filter(({ score }) => score >= 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2);
  if (matches.length) parts.push('Answers the operator approved for similar requests. Match their focus and format, and recompute every figure from the current data:\n' +
    matches.map(({ item }) => 'Request: ' + item.prompt.slice(0, 300) + '\nApproved answer: ' + item.answer.slice(0, 700)).join('\n\n'));
  return parts.join('\n\n').slice(0, 3200);
}

// Shared company facts for every agent's system prompt.
export function sharedFor(entries) {
  if (!entries?.length) return '';
  return 'LocalCare Props company facts and rules from the operator. They apply to every agent. Use them unless the current data shows otherwise:\n' +
    entries.map(item => '- ' + item.text).join('\n');
}

// Recent turns as chat messages for the model: the last 6 messages, each clipped, then trimmed
// from the oldest until the total fits the character budget.
export function historyFor(thread, budget = limits.historyBudget) {
  const turns = (thread?.messages || []).slice(-limits.history).map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: [message.meta?.buildSummary, message.content].filter(Boolean).join('\n').slice(0, limits.historyChars),
  }));
  let total = turns.reduce((sum, turn) => sum + turn.content.length, 0);
  while (turns.length && total > budget) total -= turns.shift().content.length;
  return turns;
}

export function publicMemory(data) {
  const { stats, playbook, lessons, exemplars, qcFindings } = data;
  const meta = { ...emptyMemory().playbookMeta, ...data.playbookMeta };
  const rated = stats.up + stats.down;
  return {
    stats: { ...stats, helpfulRate: rated ? stats.up / rated : null, exemplars: exemplars.length },
    playbook,
    playbookVersion: { version: meta.version, at: meta.at, ratings: meta.up + meta.down, helpfulRate: rate(meta), restored: meta.restored, evaluated: meta.evaluated },
    versions: (data.versions || []).map(({ version, playbook: rules, at, up, down }) => ({ version, rules: rules.length, at, ratings: up + down, helpfulRate: rate({ up, down }) })),
    rollbacks: data.rollbacks || [],
    lessons: lessons.map(({ id, text, source, at, consolidated }) => ({ id, text, source, at, consolidated })),
    qcFindings,
  };
}
