// Chat history and learned memory for the JARVIS agents. Studio administrator key required.
// GET  ?role=build                -> threads and learned memory for the agent
// GET  ?role=build&thread=<id>    -> one chat with its messages
// POST { action, role, ... }      -> feedback, rename, delete, lesson-add, lesson-delete, reflect, reset
import { json } from './lib/auth.mjs';
import { groqModel, roles } from './lib/jarvis-agents.mjs';
import { createMemory, limits, openJarvisStore, publicMemory, validId } from './lib/jarvis-memory.mjs';
import { readBody, studioAuthorized } from './lib/studio.mjs';

const agentNames = { systems: 'Systems and KPIs', market: 'Market news', build: 'Build developer', qc: 'QC developer' };
const actions = ['feedback', 'rename', 'delete', 'lesson-add', 'lesson-delete', 'reflect', 'reset'];
const invalid = () => Object.assign(new Error('Invalid memory request.'), { agentStatus: 400 });

export function createJarvisMemoryHandler({ env = process.env, fetchImpl = fetch, openStore = openJarvisStore } = {}) {
  async function reflect(memory, role) {
    if (!env.GROQ_API_KEY) throw Object.assign(new Error('Set GROQ_API_KEY to let agents reflect on feedback.'), { agentStatus: 503 });
    return memory.reflect(role, groqModel(env.GROQ_API_KEY, fetchImpl), agentNames[role]);
  }

  return async function handler(request) {
    const url = new URL(request.url);
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
    if (!studioAuthorized(request, env.LCP_STUDIO_KEY || '')) return json({ error: 'Administrator key rejected.' }, 401);
    let command;
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Origin rejected.' }, 403);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
      try {
        command = await readBody(request, 8192);
        if (!actions.includes(command?.action) || !roles.includes(command.role)) throw invalid();
        if (['feedback', 'rename', 'delete'].includes(command.action) && !validId(command.threadId)) throw invalid();
        if (command.action === 'feedback' && (!validId(command.messageId) || ![1, -1].includes(command.rating)
          || (command.note !== undefined && (typeof command.note !== 'string' || command.note.length > limits.lesson)))) throw invalid();
        if (['rename', 'lesson-add'].includes(command.action) && (typeof command.text !== 'string' || command.text.length > limits.lesson)) throw invalid();
        if (command.action === 'lesson-delete' && !validId(command.lessonId)) throw invalid();
      } catch {
        return json({ error: 'Invalid memory request.' }, 400);
      }
    }
    const role = command?.role ?? url.searchParams.get('role');
    if (!roles.includes(role)) return json({ error: 'Select a JARVIS agent.' }, 400);
    let memory;
    try {
      memory = createMemory(await openStore());
    } catch {
      return json({ error: 'JARVIS memory storage is unavailable.' }, 503);
    }
    try {
      if (!command) {
        const id = url.searchParams.get('thread');
        if (id) {
          const thread = await memory.getThread(role, id);
          return thread ? json({ thread }) : json({ error: 'Chat not found.' }, 404);
        }
        const [threads, data] = await Promise.all([memory.listThreads(role), memory.getMemory(role)]);
        return json({ threads, memory: publicMemory(data) });
      }
      const { action } = command;
      if (action === 'rename') await memory.renameThread(role, command.threadId, command.text);
      if (action === 'delete') await memory.deleteThread(role, command.threadId);
      if (action === 'lesson-add') await memory.addLesson(role, command.text);
      if (action === 'lesson-delete') await memory.deleteLesson(role, command.lessonId);
      if (action === 'reset') await memory.resetMemory(role);
      let reflection = null;
      if (action === 'reflect') {
        await reflect(memory, role);
        reflection = 'updated';
      }
      if (action === 'feedback') {
        const data = await memory.feedback(role, command.threadId, command.messageId, command.rating, command.note || '');
        // Consolidate automatically after every few feedback events.
        if (data.stats.feedbackSinceReflect >= limits.reflectEvery && env.GROQ_API_KEY) {
          try {
            await reflect(memory, role);
            reflection = 'updated';
          } catch {
            reflection = 'failed';
          }
        }
      }
      return json({ ok: true, reflection, memory: publicMemory(await memory.getMemory(role)) });
    } catch (error) {
      return json({ error: error.agentStatus ? error.message : 'JARVIS memory storage is unavailable.' }, error.agentStatus || 503);
    }
  };
}

export default createJarvisMemoryHandler();
export const config = { path: '/api/jarvis-memory' };
