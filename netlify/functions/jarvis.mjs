import { gooseModel } from './lib/goose.mjs';
import { brainEditMessage, brainHealthIntent } from '../../public/jarvis-intent.mjs';
import { compileAgents, groqModel, latestNews, roles } from './lib/jarvis-agents.mjs';
import { createMemory, guidanceFor, historyFor, openJarvisStore, validId } from './lib/jarvis-memory.mjs';
import { json } from './lib/auth.mjs';
import { loadBrainStatus } from './lib/brain-status.mjs';
import { buildReport, paramsFrom } from './lib/report.mjs';
import { readBody, studioAuthorized } from './lib/studio.mjs';
import { initialConfig, metrics, pages, trends, validateConfig } from '../../public/studio-schema.mjs';

async function systemContext(filters) {
  const [report, health] = await Promise.all([
    buildReport(paramsFrom(filters)),
    loadBrainStatus(),
  ]);
  const { from, to, rep } = report.range;
  const { mode, dialer, ghl, ledger, workflows } = report.sources;
  const previous = report.previous?.kpis;
  const changes = Object.fromEntries(Object.entries(report.kpis)
    .filter(([key, value]) => Number.isFinite(value) && Number.isFinite(previous?.[key]))
    .map(([key, value]) => [key, Number((value - previous[key]).toFixed(6))]));
  return {
    range: { from, to, repFiltered: Boolean(rep) },
    current: report.kpis,
    absoluteChanges: changes,
    previous: report.previous ? {
      from: report.previous.range.from,
      to: report.previous.range.to,
      kpis: report.previous.kpis,
    } : null,
    coverage: { mode, dialer, ghl, ledger, workflows, warnings: report.sources.warnings?.length || 0 },
    checks: {
      twilioBilling: health.billing?.status || 'not checked',
      groq: health.groq?.status || 'not checked',
    },
  };
}

const remember = /^\s*(?:\/remember\b|remember(?:\s+this)?\s*:)\s*/i;
const agentNames = { systems: 'Systems and KPIs', market: 'Market news', build: 'Build developer', qc: 'QC developer' };

function assistantRecord(result) {
  const meta = {};
  for (const name of ['trace', 'approved', 'buildSummary', 'engine', 'unavailable']) if (result[name] !== undefined) meta[name] = result[name];
  if (result.sources?.length) meta.sources = result.sources.slice(0, 12);
  if (result.modules?.length) meta.modules = result.modules;
  return { content: result.answer || result.error || '', meta };
}

export function createJarvisHandler({ env = process.env, fetchImpl = fetch, readSystems = systemContext, createGooseModel = gooseModel, openStore = openJarvisStore } = {}) {
  let running = false;
  return async function handler(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    if (!studioAuthorized(request, env.LCP_STUDIO_KEY || '')) return json({ error: 'Administrator key rejected.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
    let role, prompt, previousTask, filters, modules, intent, engine, threadId, newThread;
    const catalog = { pages, metrics, trends, moduleTypes: {
      note: 'Static text',
      metric: 'Live report KPI selected by metric ID',
      health: 'Live System health from Brain 3D. Only page brain. No additional fields.',
      panel: 'Composes 1 to 6 titled blocks. Supports note with text, metric with metric, trend with series, or health on Brain with no extra fields.',
    } };
    try {
      const body = await readBody(request, 16384);
      ({ role, prompt, previousTask = '', filters, modules, engine = 'groq', threadId, newThread = false } = body);
      if (!roles.includes(role) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) throw new TypeError();
      if ((threadId !== undefined && !validId(threadId)) || typeof newThread !== 'boolean') throw new TypeError();
      if (!['groq', 'goose'].includes(engine) || (engine === 'goose' && role !== 'build')) throw new TypeError();
      if (typeof previousTask !== 'string' || previousTask.length > 1000) throw new TypeError();
    } catch {
      return json({ error: 'Invalid agent request or module configuration.' }, 400);
    }

    // Chat mode: load the thread and the agent's learned memory. Stateless calls skip storage.
    const requestedRole = role;
    let memory = null, thread = null, learned = null;
    if (threadId || newThread) {
      try {
        memory = createMemory(await openStore());
        [thread, learned] = await Promise.all([threadId ? memory.getThread(role, threadId) : null, memory.getMemory(role)]);
      } catch {
        return json({ error: 'JARVIS memory storage is unavailable.' }, 503);
      }
      if (threadId && !thread) return json({ error: 'Chat not found. Start a new chat.' }, 404);
      if (!previousTask) previousTask = (thread?.messages || []).findLast(message => message.role === 'user')?.content.slice(0, 1000) || '';
    }
    async function reply(result, status = 200) {
      if (!memory || status !== 200) return json(result, status);
      try {
        thread ??= await memory.createThread(requestedRole, prompt);
        const { reply: stored, title } = await memory.appendExchange(requestedRole, thread.id, prompt.trim(), assistantRecord(result));
        if (result.trace && !result.lesson) {
          await memory.recordRun(requestedRole, { approved: result.approved });
          if (result.approved === false && result.trace.includes('qc') && requestedRole === 'build') await memory.recordQcFinding('build', result.answer);
        }
        return json({ ...result, threadId: thread.id, messageId: stored.id, title });
      } catch (error) {
        return json({ ...result, memoryError: error.agentStatus === 404 ? 'Chat not found.' : 'The reply was not saved to chat history.' });
      }
    }

    const lesson = remember.exec(prompt);
    if (lesson && memory) {
      const text = prompt.slice(lesson[0].length);
      try {
        const saved = await memory.addLesson(requestedRole, text);
        return reply({ answer: 'Saved. The ' + agentNames[requestedRole] + ' agent will follow this on every future request: ' + saved.text, lesson: saved.id });
      } catch (error) {
        return json({ error: error.agentStatus === 400 ? 'Add the instruction after "remember:".' : 'The lesson was not saved.' }, error.agentStatus === 400 ? 400 : 503);
      }
    }

    try {
      intent = ['build', 'systems'].includes(role) ? brainHealthIntent(prompt, previousTask) : null;
      if (intent === 'edit' || intent === 'read') return reply({ answer: intent === 'edit' ? brainEditMessage : 'Open Brain 3D and select System health for the current integration checks.', trace: ['systems'] });
      if (filters !== undefined && (!filters || typeof filters !== 'object' || Array.isArray(filters))) throw new TypeError();
      if (role === 'systems' && intent !== 'build' && !filters) throw new TypeError();
      if (intent !== 'build' && role === 'qc') {
        validateConfig({ ...initialConfig(), modules });
        if (Buffer.byteLength(JSON.stringify(modules)) > 6000) return json({ error: 'Reduce the draft modules to 6 KB for one QC review.' }, 400);
        if (!modules.length) return json({ error: 'Add a draft module before running QC.' }, 400);
      }
    } catch {
      return json({ error: 'Invalid agent request or module configuration.' }, 400);
    }

    if (intent === 'build') role = 'build';
    const key = env.GROQ_API_KEY;
    if (!key) return json({ error: 'Set GROQ_API_KEY from a Groq Free project.' }, 503);
    if (running) return json({ error: 'JARVIS is processing another task. Retry shortly.' }, 429);
    running = true;
    try {
      let context = { catalog, requiredModule: intent === 'build' ? 'health' : null };
      if (role === 'systems') {
        try {
          context = await readSystems(filters);
        } catch (error) {
          return json({ error: 'System metrics are unavailable for this filter.' }, error.status === 400 ? 400 : 502);
        }
      }
      if (role === 'qc') context.modules = modules;
      const model = groqModel(key, fetchImpl);
      const graph = compileAgents(model, () => latestNews(fetchImpl), () => readSystems(filters),
        engine === 'goose' ? createGooseModel(key) : model);
      const guidance = memory ? { memory: guidanceFor(role, role === requestedRole ? learned : await memory.getMemory(role), prompt), history: historyFor(thread) } : null;
      const { result } = await graph.invoke({ role, prompt: prompt.trim(), previousTask, context, guidance }, { recursionLimit: 8 });
      return reply(engine === 'goose' ? { ...result, engine } : result);
    } catch (error) {
      return json({ error: error.agentStatus ? error.message : 'JARVIS could not complete the task. Check your provider settings and retry.' }, error.agentStatus || 502);
    } finally {
      running = false;
    }
  };
}

export default createJarvisHandler();
export const config = { path: '/api/jarvis' };
