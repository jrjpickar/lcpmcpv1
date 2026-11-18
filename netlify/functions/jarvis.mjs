import { brainEditMessage, brainHealthIntent } from '../../public/jarvis-intent.mjs';
import { compileAgents, groqModel, latestNews, roles } from './lib/jarvis-agents.mjs';
import { json } from './lib/auth.mjs';
import { loadBrainStatus } from './lib/brain-status.mjs';
import { buildReport, paramsFrom } from './lib/report.mjs';
import { readBody, studioAuthorized } from './lib/studio.mjs';
import { initialConfig, metrics, pages, validateConfig } from '../../public/studio-schema.mjs';

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

export function createJarvisHandler({ env = process.env, fetchImpl = fetch, readSystems = systemContext } = {}) {
  let running = false;
  return async function handler(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    if (!studioAuthorized(request, env.LCP_STUDIO_KEY || '')) return json({ error: 'Administrator key rejected.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
    let role, prompt, previousTask, filters, modules, intent;
    const catalog = { pages, metrics, moduleTypes: {
      note: 'Static text',
      metric: 'Live report KPI selected by metric ID',
      health: 'Live System health from Brain 3D. Only page brain. No additional fields.',
    } };
    try {
      const body = await readBody(request, 16384);
      ({ role, prompt, previousTask = '', filters, modules } = body);
      if (!roles.includes(role) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) throw new TypeError();
      if (typeof previousTask !== 'string' || previousTask.length > 1000) throw new TypeError();
      intent = ['build', 'systems'].includes(role) ? brainHealthIntent(prompt, previousTask) : null;
      if (intent === 'edit' || intent === 'read') return json({ answer: intent === 'edit' ? brainEditMessage : 'Open Brain 3D and select System health for the current integration checks.', trace: ['systems'] });
      if (intent !== 'build' && role === 'systems' && (!filters || typeof filters !== 'object' || Array.isArray(filters))) throw new TypeError();
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
      const graph = compileAgents(groqModel(key, fetchImpl), () => latestNews(fetchImpl));
      const { result } = await graph.invoke({ role, prompt: prompt.trim(), previousTask, context }, { recursionLimit: 8 });
      return json(result);
    } catch (error) {
      return json({ error: error.agentStatus ? error.message : 'JARVIS could not complete the task. Check your provider settings and retry.' }, error.agentStatus || 502);
    } finally {
      running = false;
    }
  };
}

export default createJarvisHandler();
export const config = { path: '/api/jarvis' };
