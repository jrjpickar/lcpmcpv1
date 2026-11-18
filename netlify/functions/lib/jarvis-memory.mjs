// Persistent chat threads and learned memory for the JARVIS agents.
// Each agent keeps its own threads, operator lessons, approved answers and a playbook
// that a reflection pass rewrites from feedback. Storage is any key/value adapter with
// getWithMetadata, setJSON (conditional writes) and delete, such as Netlify Blobs.
import { randomUUID } from 'node:crypto';

export const limits = {
  threads: 50, messages: 80, message: 6000, history: 6, historyChars: 1200,
  lessons: 30, lesson: 300, exemplars: 25, disliked: 10, qcFindings: 5, playbookRules: 10, reflectEvery: 5,
};
export async function openJarvisStore() {
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: 'lcp-jarvis', consistency: 'strong' });
}

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

const clip = (value, max) => String(value ?? '').replace(/[–—]/g, '-').trim().slice(0, max);
const now = () => new Date().toISOString();
const keys = {
  index: role => 'index/' + role,
  thread: (role, id) => 'thread/' + role + '/' + id,
  memory: role => 'memory/' + role,
};
const emptyMemory = () => ({
  playbook: [], lessons: [], exemplars: [], disliked: [], qcFindings: [],
  stats: { runs: 0, up: 0, down: 0, qcPass: 0, qcFail: 0, reflections: 0, feedbackSinceReflect: 0, lastReflectAt: null },
});
const conflict = () => Object.assign(new Error('Memory changed during the update. Retry.'), { agentStatus: 409 });

async function read(store, key, fallback) {
  const entry = await store.getWithMetadata(key, { type: 'json' });
  return entry?.data ?? fallback();
}

async function update(store, key, fallback, mutate) {
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

export function createMemory(store) {
  const memory = {
    async listThreads(role) {
      return (await read(store, keys.index(role), () => ({ threads: [] }))).threads;
    },

    async getThread(role, id) {
      if (!validId(id)) return null;
      return read(store, keys.thread(role, id), () => null);
    },

    async getMemory(role) {
      return { ...emptyMemory(), ...(await read(store, keys.memory(role), emptyMemory)) };
    },

    async createThread(role, firstPrompt) {
      const thread = { id: randomUUID(), role, title: clip(firstPrompt, 60) || 'New chat', createdAt: now(), updatedAt: now(), messages: [] };
      await store.setJSON(keys.thread(role, thread.id), thread, { onlyIfNew: true });
      const dropped = [];
      await update(store, keys.index(role), () => ({ threads: [] }), index => {
        index.threads.unshift({ id: thread.id, title: thread.title, updatedAt: thread.updatedAt, count: 0 });
        while (index.threads.length > limits.threads) dropped.push(index.threads.pop().id);
      });
      await Promise.all(dropped.map(id => store.delete(keys.thread(role, id))));
      return thread;
    },

    // Appends one exchange and refreshes the index entry. Returns the stored assistant message.
    async appendExchange(role, id, user, assistant) {
      const userMessage = { id: randomUUID(), role: 'user', content: clip(user, limits.message), at: now() };
      const reply = { id: randomUUID(), role: 'assistant', content: clip(assistant.content, limits.message), at: now(), meta: assistant.meta || {} };
      const { data } = await update(store, keys.thread(role, id), () => null, thread => {
        if (!thread) throw Object.assign(new Error('Chat not found.'), { agentStatus: 404 });
        thread.messages.push(userMessage, reply);
        if (thread.messages.length > limits.messages) thread.messages.splice(0, thread.messages.length - limits.messages);
        thread.updatedAt = reply.at;
      });
      await update(store, keys.index(role), () => ({ threads: [] }), index => {
        const position = index.threads.findIndex(entry => entry.id === id);
        const entry = position >= 0 ? index.threads.splice(position, 1)[0] : { id, title: data.title };
        index.threads.unshift({ ...entry, updatedAt: data.updatedAt, count: data.messages.length });
      });
      return { userMessage, reply, title: data.title };
    },

    async renameThread(role, id, title) {
      const value = clip(title, 60);
      if (!value) throw Object.assign(new Error('Enter a chat title.'), { agentStatus: 400 });
      await update(store, keys.thread(role, id), () => null, thread => {
        if (!thread) throw Object.assign(new Error('Chat not found.'), { agentStatus: 404 });
        thread.title = value;
      });
      await update(store, keys.index(role), () => ({ threads: [] }), index => {
        const entry = index.threads.find(item => item.id === id);
        if (!entry) return false;
        entry.title = value;
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
      if (!value) throw Object.assign(new Error('Enter a lesson.'), { agentStatus: 400 });
      const lesson = { id: randomUUID(), text: value, source, at: now(), consolidated: false };
      await update(store, keys.memory(role), emptyMemory, data => {
        data.lessons.unshift(lesson);
        // Keep manual lessons first when trimming.
        while (data.lessons.length > limits.lessons) {
          const index = data.lessons.findLastIndex(item => item.source !== 'manual');
          data.lessons.splice(index >= 0 ? index : data.lessons.length - 1, 1);
        }
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

    // Rates an assistant message. Positive replies become retrievable examples,
    // negative replies and notes feed the next reflection.
    async feedback(role, threadId, messageId, rating, note = '') {
      if (![1, -1].includes(rating)) throw Object.assign(new Error('Invalid rating.'), { agentStatus: 400 });
      const correction = clip(note, limits.lesson);
      let previous = 0;
      let prompt = '';
      let answer = '';
      await update(store, keys.thread(role, threadId), () => null, thread => {
        if (!thread) throw Object.assign(new Error('Chat not found.'), { agentStatus: 404 });
        const index = thread.messages.findIndex(item => item.id === messageId && item.role === 'assistant');
        if (index < 0) throw Object.assign(new Error('Message not found.'), { agentStatus: 404 });
        const message = thread.messages[index];
        previous = message.rating || 0;
        prompt = thread.messages.slice(0, index).findLast(item => item.role === 'user')?.content || '';
        answer = [message.meta?.buildSummary, message.content, message.meta?.modules?.map(item => item.title + ' (' + item.type + ', ' + item.page + ')').join('; ')]
          .filter(Boolean).join('\n');
        message.rating = rating;
        if (correction) message.note = correction;
      });
      const { data } = await update(store, keys.memory(role), emptyMemory, data => {
        if (previous === 1) data.stats.up--;
        if (previous === -1) data.stats.down--;
        if (rating === 1) data.stats.up++;
        else data.stats.down++;
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
          while (data.lessons.length > limits.lessons) {
            const index = data.lessons.findLastIndex(item => item.source !== 'manual');
            data.lessons.splice(index >= 0 ? index : data.lessons.length - 1, 1);
          }
        }
        if (previous !== rating || correction) data.stats.feedbackSinceReflect++;
      });
      return data;
    },

    // Rewrites the playbook from the current playbook, lessons and rated replies.
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
        'You maintain the operating playbook for the ' + agentName + ' agent of a real estate wholesaler. ' +
        'Merge the current playbook, operator lessons, liked replies and disliked replies into at most ' + limits.playbookRules +
        ' short imperative rules that will make future answers more useful to this operator. ' +
        'Operator lessons outrank older rules. Liked replies show the preferred focus, depth and format. Disliked replies and QC rejections show what to avoid. ' +
        'Keep each rule specific, testable and under 200 characters. Do not include figures that go stale, secrets, or rules that weaken accuracy or safety. ' +
        'Never use em dashes or en dashes. Return JSON {"playbook":["rule", ...]}.',
        material, true,
      );
      if (!Array.isArray(result?.playbook) || result.playbook.length > limits.playbookRules
        || result.playbook.some(rule => typeof rule !== 'string' || !rule.trim() || rule.length > 240)) {
        throw Object.assign(new Error('Reflection returned an invalid playbook.'), { agentStatus: 502 });
      }
      const consolidated = new Set(current.lessons.map(item => item.id));
      const { data } = await update(store, keys.memory(role), emptyMemory, data => {
        data.playbook = result.playbook.map(rule => clip(rule, 240));
        for (const lesson of data.lessons) if (consolidated.has(lesson.id) && lesson.source !== 'manual') lesson.consolidated = true;
        data.stats.reflections++;
        data.stats.feedbackSinceReflect = 0;
        data.stats.lastReflectAt = now();
      });
      return data;
    },
  };
  return memory;
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

// Recent turns as chat messages for the model.
export function historyFor(thread) {
  return (thread?.messages || []).slice(-limits.history).map(message => ({
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: [message.meta?.buildSummary, message.content].filter(Boolean).join('\n').slice(0, limits.historyChars),
  }));
}

export function publicMemory(data) {
  const { stats, playbook, lessons, exemplars, qcFindings } = data;
  const rated = stats.up + stats.down;
  return {
    stats: { ...stats, helpfulRate: rated ? stats.up / rated : null, exemplars: exemplars.length },
    playbook,
    lessons: lessons.map(({ id, text, source, at, consolidated }) => ({ id, text, source, at, consolidated })),
    qcFindings,
  };
}
