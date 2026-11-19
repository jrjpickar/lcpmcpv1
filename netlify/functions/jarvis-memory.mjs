// Chat history, learned memory, company memory and custom bots for the JARVIS agents. Studio administrator key required.
// GET  ?role=build                  -> chats, learned memory, company memory and bots
// GET  ?role=build&thread=<id>      -> one chat with its messages
// GET  ?role=build&q=<text>         -> search chat titles and messages (max 20 results)
// POST { action, role, ... }        -> feedback, rename, delete, pin, lesson-add, lesson-delete, reflect, reset,
//                                      playbook-restore, shared-add, shared-delete, bot-create, bot-update, bot-delete
import { json } from './lib/auth.mjs';
import { DEFAULT_MODEL } from './lib/groq.mjs';
import { agentNames, builtinRoles, groqModel, modelTimeout, rolePattern } from './lib/jarvis-agents.mjs';
import { botContexts, createMemory, limits, openJarvisStore, publicMemory, shouldReflect, validId } from './lib/jarvis-memory.mjs';
import { jarvisAccess, readBody } from './lib/studio.mjs';

const actions = ['feedback', 'rename', 'delete', 'pin', 'lesson-add', 'lesson-delete', 'reflect', 'reset', 'playbook-restore',
  'shared-add', 'shared-delete', 'bot-create', 'bot-update', 'bot-delete'];
const invalid = () => Object.assign(new Error('Invalid memory request.'), { agentStatus: 400 });
const isText = (value, max) => typeof value === 'string' && value.length <= max;

function checkCommand(command) {
  if (!actions.includes(command?.action) || typeof command.role !== 'string' || !rolePattern.test(command.role)) throw invalid();
  const { action } = command;
  if (['feedback', 'rename', 'delete', 'pin'].includes(action) && !validId(command.threadId)) throw invalid();
  if (action === 'feedback' && (!validId(command.messageId) || ![1, -1].includes(command.rating)
    || (command.note !== undefined && !isText(command.note, limits.lesson)))) throw invalid();
  if (['rename', 'lesson-add'].includes(action) && !isText(command.text, limits.lesson)) throw invalid();
  if (action === 'shared-add' && !isText(command.text, limits.sharedText)) throw invalid();
  if (action === 'pin' && typeof command.pinned !== 'boolean') throw invalid();
  if (['lesson-delete', 'shared-delete'].includes(action) && !validId(command.id ?? command.lessonId)) throw invalid();
  if (action === 'playbook-restore' && !Number.isSafeInteger(command.version)) throw invalid();
  if (['bot-create', 'bot-update'].includes(action)) {
    const bot = command.bot;
    if (!bot || typeof bot !== 'object' || !isText(bot.name, 40) || !isText(bot.instructions, limits.botInstructions)
      || (bot.description !== undefined && !isText(bot.description, limits.botDescription)) || !botContexts.includes(bot.context ?? 'none')) throw invalid();
  }
  if (['bot-update', 'bot-delete'].includes(action) && !command.role.startsWith('bot-')) throw invalid();
}

export function createJarvisMemoryHandler({ env = process.env, fetchImpl = fetch, openStore = () => openJarvisStore(env) } = {}) {
  async function reflect(memory, role, name) {
    if (!env.GROQ_API_KEY) throw Object.assign(new Error('Set GROQ_API_KEY to let agents reflect on feedback.'), { agentStatus: 503 });
    return memory.reflect(role, groqModel(env.GROQ_API_KEY, fetchImpl, { model: env.JARVIS_GROQ_MODEL?.trim() || DEFAULT_MODEL, timeoutMs: modelTimeout(env) }), name);
  }

  return async function handler(request) {
    const url = new URL(request.url);
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
    const access = jarvisAccess(request, env);
    if (!access) return json({ error: 'Administrator key rejected.' }, 401);
    let command;
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Origin rejected.' }, 403);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
      try {
        command = await readBody(request, 8192);
        checkCommand(command);
      } catch {
        return json({ error: 'Invalid memory request.' }, 400);
      }
    }
    const role = command?.role ?? url.searchParams.get('role');
    if (typeof role !== 'string' || !rolePattern.test(role)) return json({ error: 'Select a JARVIS agent.' }, 400);
    let memory;
    try {
      memory = createMemory(await openStore());
    } catch {
      return json({ error: 'JARVIS memory storage is unavailable.' }, 503);
    }
    try {
      const bots = await memory.getBots();
      const known = id => builtinRoles.includes(id) || bots.some(bot => bot.id === id);
      const nameOf = id => agentNames[id] || bots.find(bot => bot.id === id)?.name || id;
      if (command?.action !== 'bot-create' && !known(role)) return json({ error: 'Bot not found.' }, 404);
      const snapshot = async (extra = {}) => json({ ok: true, ...extra, memory: publicMemory(await memory.getMemory(role)),
        shared: await memory.getShared(), bots: await memory.getBots() });
      if (!command) {
        const id = url.searchParams.get('thread');
        const q = url.searchParams.get('q');
        if (id) {
          const thread = await memory.getThread(role, id);
          return thread ? json({ thread }) : json({ error: 'Chat not found.' }, 404);
        }
        if (q !== null) return json({ results: await memory.searchThreads(role, q) });
        const [threads, data, shared] = await Promise.all([memory.listThreads(role), memory.getMemory(role), memory.getShared()]);
        return json({ threads, memory: publicMemory(data), shared, bots, limits: { pinned: limits.pinned, shared: limits.shared, threads: limits.threads } });
      }
      const { action } = command;
      if (action === 'rename') await memory.renameThread(role, command.threadId, command.text);
      if (action === 'delete') await memory.deleteThread(role, command.threadId);
      if (action === 'pin') await memory.pinThread(role, command.threadId, command.pinned);
      if (action === 'lesson-add') await memory.addLesson(role, command.text);
      if (action === 'lesson-delete') await memory.deleteLesson(role, command.id ?? command.lessonId);
      if (action === 'reset') await memory.resetMemory(role);
      if (action === 'playbook-restore') await memory.restorePlaybook(role, command.version);
      if (action === 'shared-add') await memory.addShared(command.text);
      if (action === 'shared-delete') await memory.deleteShared(command.id);
      if (action === 'bot-create') return snapshot({ bot: await memory.saveBot(command.bot) });
      if (action === 'bot-update') return snapshot({ bot: await memory.saveBot(command.bot, role) });
      if (action === 'bot-delete') {
        await memory.deleteBot(role);
        return json({ ok: true, shared: await memory.getShared(), bots: await memory.getBots() });
      }
      if (action === 'reflect') {
        await reflect(memory, role, nameOf(role));
        return snapshot({ reflection: 'updated' });
      }
      if (action === 'feedback') {
        const { data, learner, rolledBack } = await memory.feedback(role, command.threadId, command.messageId, command.rating, command.note || '', known);
        let reflection = null;
        // Consolidate automatically after every few ratings, once the current playbook's evaluation window is closed.
        if (!rolledBack && shouldReflect(data) && env.GROQ_API_KEY) {
          try {
            await reflect(memory, learner, nameOf(learner));
            reflection = 'updated';
          } catch {
            reflection = 'failed';
          }
        }
        return snapshot({ reflection, learner, rolledBack });
      }
      return snapshot();
    } catch (error) {
      return json({ error: error.agentStatus ? error.message : 'JARVIS memory storage is unavailable.' }, error.agentStatus || 503);
    }
  };
}

export default createJarvisMemoryHandler();
export const config = { path: '/api/jarvis-memory' };
