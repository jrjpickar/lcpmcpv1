import { gooseModel } from './lib/goose.mjs';
import { brainEditMessage, brainHealthIntent } from '../../public/jarvis-intent.mjs';
import { agentNames, builtinRoles, modelTimeout, cloudflareModel, CLOUDFLARE_MODEL, compileAgents, geminiModel, GEMINI_MODEL, groqModel, latestNews, rolePattern } from './lib/jarvis-agents.mjs';
import { createGroqFailover } from './lib/jarvis-failover.mjs';
import { createMemory, guidanceFor, historyFor, limits, openJarvisStore, sharedFor, validId } from './lib/jarvis-memory.mjs';
import { INSTRUCTIONS_KEY, instructionsText } from './jarvis-instructions.mjs';
import { mailboxContext, mailSettings } from './lib/jarvis-mail.mjs';
import { summarize, validatePlan } from './lib/jarvis-sandbox.mjs';
import { json } from './lib/auth.mjs';
import { loadBrainStatus } from './lib/brain-status.mjs';
import { buildReport, paramsFrom } from './lib/report.mjs';
import { jarvisAccess, readBody } from './lib/studio.mjs';
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

const rememberAll = /^\s*(?:\/remember-all\b|remember for all(?: agents)?\s*:)\s*/i;
const remember = /^\s*(?:\/remember\b|remember(?:\s+this)?\s*:)\s*/i;
const execute = /^\s*\/execute\b/i;

function assistantRecord(result) {
  const meta = {};
  for (const name of ['trace', 'approved', 'buildSummary', 'engine', 'unavailable', 'usage', 'agent', 'plan', 'planHash', 'warnings', 'validation', 'mailAsOf', 'execute', 'draft', 'provider']) if (result[name] !== undefined) meta[name] = result[name];
  if (result.sources?.length) meta.sources = result.sources.slice(0, 12);
  if (result.modules?.length) meta.modules = result.modules;
  if (meta.plan && Buffer.byteLength(JSON.stringify(meta.plan)) > 12000) delete meta.plan;
  return { content: result.answer || result.error || '', meta };
}

// Email agent model: Gemini (EMAIL_GEMINI_MODEL, else GEMINI_MODEL, else gemini-3.1-flash-lite) when GEMINI_API_KEY is set,
// falling back to Groq if the Gemini call fails. Without the Gemini key the Email agent uses Groq.
function emailModelFor({ env, fetchImpl, usage, geminiKey, groq }) {
  if (!geminiKey) return { emailProvider: () => 'groq' };
  const gemini = geminiModel(geminiKey, fetchImpl, { model: env.EMAIL_GEMINI_MODEL?.trim() || env.GEMINI_MODEL?.trim() || GEMINI_MODEL, usage, timeoutMs: modelTimeout(env) });
  let last = 'gemini';
  const emailModel = async (...args) => {
    try {
      last = 'gemini';
      return await gemini(...args);
    } catch (error) {
      if (!groq) throw error;
      last = 'groq';
      return groq(...args);
    }
  };
  return { emailModel, emailProvider: () => last };
}

export function createJarvisHandler({ env = process.env, fetchImpl = fetch, readSystems = systemContext, createGooseModel = gooseModel, openStore = () => openJarvisStore(env) } = {}) {
  let running = false;
  const timeoutMs = modelTimeout(env);
  const groq = createGroqFailover({ env, fetchImpl, timeoutMs });
  return async function handler(request) {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
    const access = jarvisAccess(request, env);
    if (!access) return json({ error: 'Administrator key rejected.' }, 401);
    if (request.method === 'GET') {
      const view = new URL(request.url).searchParams.get('view');
      if (view === 'models') return json({ configured: Boolean(env.GROQ_API_KEY), ...groq.status() });
      if (view !== 'mail') return json({ error: 'Select a JARVIS view.' }, 400);
      if (!access.mailbox) return json({ error: 'Mailbox access is not available.' }, 403);
      try {
        if (env.DATA_MODE !== 'sample' && !mailSettings(env).configured) return json({ configured: false });
        const store = env.DATA_MODE === 'sample' ? null : await Promise.resolve().then(openStore).catch(() => null);
        return json({ configured: true, ...await mailboxContext({ env, fetchImpl, store }) });
      } catch {
        return json({ error: 'The mailbox snapshot is unavailable.' }, 502);
      }
    }
    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
    let role, prompt, previousTask, filters, modules, intent, engine, threadId, newThread, plan;
    const catalog = { pages, metrics, trends, moduleTypes: {
      note: 'Static text',
      metric: 'Live report KPI selected by metric ID',
      health: 'Live System health from Brain 3D. Only page brain. No additional fields.',
      panel: 'Composes 1 to 6 titled blocks. Supports note with text, metric with metric, trend with series, or health on Brain with no extra fields.',
    } };
    try {
      const body = await readBody(request, 16384);
      ({ role, prompt, previousTask = '', filters, modules, engine = 'groq', threadId, newThread = false, plan } = body);
      if (typeof role !== 'string' || !rolePattern.test(role) || typeof prompt !== 'string' || !prompt.trim()) throw new TypeError();
      if (prompt.length > (execute.test(prompt) ? 12000 : 1000)) throw new TypeError();
      if (plan !== undefined && (role !== 'qc' || !plan || typeof plan !== 'object' || Array.isArray(plan))) throw new TypeError();
      if ((threadId !== undefined && !validId(threadId)) || typeof newThread !== 'boolean') throw new TypeError();
      if (!['groq', 'goose'].includes(engine) || (engine === 'goose' && role !== 'build')) throw new TypeError();
      if (typeof previousTask !== 'string' || previousTask.length > 1000) throw new TypeError();
    } catch {
      return json({ error: 'Invalid agent request or module configuration.' }, 400);
    }
    if (role === 'email' && !access.mailbox) return json({ error: 'Mailbox access is not enabled for this sign-in.' }, 403);

    // Chat mode: load the thread, the agent's learned memory, company memory and bots. Stateless calls skip storage,
    // except custom bots, which always need storage for their definition.
    const requestedRole = role;
    const chat = Boolean(threadId || newThread);
    let store = null, memory = null, thread = null, learned = null, shared = [], bots = [];
    if (chat || role.startsWith('bot-') || role === 'main') {
      try {
        store = await openStore();
        memory = createMemory(store);
        [thread, learned, shared, bots] = await Promise.all([
          threadId ? memory.getThread(role, threadId) : null,
          chat ? memory.getMemory(role) : null,
          chat ? memory.getShared() : [],
          role.startsWith('bot-') || role === 'main' ? memory.getBots() : [],
        ]);
      } catch {
        if (chat || role.startsWith('bot-')) return json({ error: 'JARVIS memory storage is unavailable.' }, 503);
        memory = null; // The main dispatcher still works statelessly without custom bots.
      }
      if (!chat) memory = null;
      if (threadId && !thread) return json({ error: 'Chat not found. Start a new chat.' }, 404);
      if (role.startsWith('bot-') && !bots.some(bot => bot.id === role)) return json({ error: 'Bot not found.' }, 404);
      if (!previousTask) previousTask = (thread?.messages || []).findLast(message => message.role === 'user')?.content.slice(0, 1000) || '';
    }
    const nameOf = id => agentNames[id] || bots.find(bot => bot.id === id)?.name || id;
    async function reply(result, status = 200) {
      if (!memory || status !== 200) return json(result, status);
      try {
        thread ??= await memory.createThread(requestedRole, execute.test(prompt) ? 'Execute: ' + (result.plan?.task || 'plan') : prompt);
        const { reply: stored, title } = await memory.appendExchange(requestedRole, thread.id, prompt.trim(), assistantRecord(result));
        if (result.trace && !result.lesson && !result.execute) {
          const agent = result.agent || requestedRole;
          await memory.recordRun(requestedRole, { approved: agent === requestedRole ? result.approved : undefined });
          if (agent !== requestedRole && (builtinRoles.includes(agent) || bots.some(bot => bot.id === agent))) await memory.recordRun(agent, { approved: result.approved });
          if (result.approved === false && result.trace.includes('qc') && agent === 'build') await memory.recordQcFinding('build', result.answer);
        }
        return json({ ...result, threadId: thread.id, messageId: stored.id, title });
      } catch (error) {
        return json({ ...result, memoryError: error.agentStatus === 404 ? 'Chat not found.' : 'The reply was not saved to chat history.' });
      }
    }

    const all = rememberAll.exec(prompt);
    const lesson = !all && remember.exec(prompt);
    if ((all || lesson) && memory) {
      const text = prompt.slice((all || lesson)[0].length);
      try {
        if (all) {
          const saved = await memory.addShared(text);
          return reply({ answer: 'Saved to company memory. Every agent will use this: ' + saved.text, lesson: saved.id, shared: true });
        }
        const saved = await memory.addLesson(requestedRole, text);
        return reply({ answer: 'Saved. The ' + nameOf(requestedRole) + ' agent will follow this on every future request: ' + saved.text, lesson: saved.id });
      } catch (error) {
        const status = [400, 409].includes(error.agentStatus) ? error.agentStatus : 503;
        return json({ error: status === 400 ? 'Add the instruction after "remember:".' : status === 409 ? error.message : 'The lesson was not saved.' }, status);
      }
    }

    // /execute { plan JSON }: validated here with no model call. Running happens in /api/jarvis-execute.
    if (execute.test(prompt)) {
      let input;
      try {
        input = JSON.parse(prompt.replace(execute, '').trim().replace(/^```(?:json)?|```$/g, '').trim());
      } catch {
        return reply({ answer: 'The /execute command needs a JSON plan after it. No changes were made.', execute: true, trace: ['execute'], validation: { ok: false, errors: ['Invalid JSON.'], warnings: [] } });
      }
      const checked = validatePlan(input);
      return reply({ answer: summarize(checked), execute: true, trace: ['execute'], validation: { ok: checked.ok, errors: checked.errors, warnings: checked.warnings },
        ...(checked.ok ? { plan: checked.plan, planHash: checked.hash } : {}) });
    }

    try {
      intent = ['build', 'systems'].includes(role) ? brainHealthIntent(prompt, previousTask) : null;
      if (intent === 'edit' || intent === 'read') return reply({ answer: intent === 'edit' ? brainEditMessage : 'Open Brain 3D and select System health for the current integration checks.', trace: ['systems'] });
      if (filters !== undefined && (!filters || typeof filters !== 'object' || Array.isArray(filters))) throw new TypeError();
      if (role === 'systems' && intent !== 'build' && !filters) throw new TypeError();
      if ((intent !== 'build' && role === 'qc' && !plan) || (role === 'main' && modules !== undefined)) {
        validateConfig({ ...initialConfig(), modules });
        if (Buffer.byteLength(JSON.stringify(modules)) > 6000) return json({ error: 'Reduce the draft modules to 6 KB for one QC review.' }, 400);
        if (!modules.length && role === 'qc') return json({ error: 'Add a draft module before running QC.' }, 400);
      }
    } catch {
      return json({ error: 'Invalid agent request or module configuration.' }, 400);
    }

    if (intent === 'build') role = 'build';
    const key = env.GROQ_API_KEY;
    const geminiKey = env.GEMINI_API_KEY?.trim();
    const cfAccount = env.CLOUDFLARE_ACCOUNT_ID?.trim(), cfToken = env.CLOUDFLARE_AI_TOKEN?.trim();
    if (!key && !(['gemini', 'email'].includes(role) && geminiKey) && !(role === 'cloudflare' && cfAccount && cfToken)) return json({ error: 'Set GROQ_API_KEY from a Groq Free project.' }, 503);
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
      if (['qc', 'main'].includes(role)) context.modules = Array.isArray(modules) ? modules : [];
      const usage = { total: 0, calls: 0 };
      const model = groqModel(key, groq.fetch, { model: groq.primary, usage, timeoutMs });
      const deps = {
        gemini: geminiKey ? geminiModel(geminiKey, fetchImpl, { model: env.GEMINI_MODEL?.trim() || GEMINI_MODEL, usage, timeoutMs: modelTimeout(env) }) : null,
        cloudflare: cfAccount && cfToken ? cloudflareModel(cfAccount, cfToken, fetchImpl, { model: env.CLOUDFLARE_AI_MODEL?.trim() || CLOUDFLARE_MODEL, usage, timeoutMs: modelTimeout(env) }) : null,
        // The Email agent needs mailbox access for this sign-in and a configured email app (or sample data).
        ...emailModelFor({ env, fetchImpl, usage, geminiKey, groq: key ? model : null }),
        mail: access.mailbox && (env.DATA_MODE === 'sample' || (() => { try { return mailSettings(env).configured; } catch { return false; } })())
          ? () => mailboxContext({ env, fetchImpl, store }) : null,
      };
      const graph = compileAgents(model, () => latestNews(fetchImpl), () => readSystems(filters),
        engine === 'goose' ? createGooseModel(key) : model, deps);
      // Custom instructions apply to every call, stateless ones included. Storage errors leave them out.
      let custom = '';
      try { custom = instructionsText((await (store || await openStore()).getWithMetadata(INSTRUCTIONS_KEY, { type: 'json' }))?.data); } catch { /* optional */ }
      const sharedText = [custom, sharedFor(shared)].filter(Boolean).join('\n\n');
      const budget = Math.min(20000, Math.max(1000, Number(env.JARVIS_HISTORY_CHARS) || limits.historyBudget));
      const history = memory ? historyFor(thread, budget) : [];
      const guidance = memory
        ? { shared: sharedText, memory: guidanceFor(role, role === requestedRole ? learned : await memory.getMemory(role), prompt), history }
        : sharedText ? { shared: sharedText } : null;
      // Agents the dispatcher delegates to load their own learned memory (chat mode only).
      if (memory) deps.guidance = async id => ({ shared: sharedText, memory: guidanceFor(id, await memory.getMemory(id), prompt), history });
      const { result } = await graph.invoke({ role, prompt: prompt.trim(), previousTask, context, guidance, bots, plan }, { recursionLimit: 8 });
      if (usage.total) result.usage = { totalTokens: usage.total, calls: usage.calls };
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
