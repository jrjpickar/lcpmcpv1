import { json } from './lib/auth.mjs';
import { loadBrainStatus } from './lib/brain-status.mjs';
import { buildReport, paramsFrom } from './lib/report.mjs';
import { readBody, studioAuthorized } from './lib/studio.mjs';
import { initialConfig, metrics, pages, validateConfig } from '../../public/studio-schema.mjs';

const roles = new Set(['systems', 'market', 'build', 'qc']);

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

function workerUrl(raw, local) {
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.username || url.password || (url.protocol !== 'https:' && !(local && loopback && url.protocol === 'http:'))) {
    throw new TypeError('Invalid worker URL.');
  }
  if (url.pathname !== '/run' || url.search || url.hash) throw new TypeError('Invalid worker route.');
  return url;
}

export function createJarvisHandler({ env = process.env, local = false, fetchImpl = fetch, readSystems = systemContext } = {}) {
  return async function handler(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    if (!studioAuthorized(request, env.LCP_STUDIO_KEY || '')) return json({ error: 'Administrator key rejected.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
    let worker;
    try {
      if ((env.LCP_JARVIS_TOKEN || '').length < 32) throw new TypeError();
      worker = workerUrl(env.LCP_JARVIS_URL || (local ? 'http://127.0.0.1:4180/run' : ''), local);
    } catch {
      return json({ error: 'Configure the JARVIS worker URL and service token.' }, 503);
    }

    let role, prompt, filters, modules;
    const catalog = { pages, metrics };
    try {
      const body = await readBody(request, 16384);
      ({ role, prompt, filters, modules } = body);
      if (!roles.has(role) || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) throw new TypeError();
      if (role === 'systems' && (!filters || typeof filters !== 'object' || Array.isArray(filters))) throw new TypeError();
      if (role === 'qc') {
        validateConfig({ ...initialConfig(), modules });
        if (Buffer.byteLength(JSON.stringify(modules)) > 6000) return json({ error: 'Reduce the draft modules to 6 KB for one QC review.' }, 400);
        if (!modules.length) return json({ error: 'Add a draft module before running QC.' }, 400);
        modules = modules.map(({ id, ...module }) => module);
      }
    } catch {
      return json({ error: 'Invalid agent request or module configuration.' }, 400);
    }

    let context = { catalog };
    if (role === 'systems') {
      try {
        context = await readSystems(filters);
      } catch (error) {
        return json({ error: 'System metrics are unavailable for this filter.' }, error.status === 400 ? 400 : 502);
      }
    }
    if (role === 'qc') context.modules = modules;

    try {
      const response = await fetchImpl(worker, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(local ? 80000 : 23000),
        headers: { authorization: 'Bearer ' + env.LCP_JARVIS_TOKEN, 'content-type': 'application/json' },
        body: JSON.stringify({ role, prompt: prompt.trim(), context }),
      });
      const result = await readBody(response, 32768);
      if (!response.ok) {
        const status = [429, 502, 503].includes(response.status) ? response.status : 502;
        return json({ error: status === response.status && typeof result?.error === 'string' ? result.error.slice(0, 300) : 'JARVIS worker rejected the request.' }, status);
      }
      if (typeof result?.answer !== 'string' || !Array.isArray(result.trace)) throw new TypeError();
      if (result.modules !== undefined) {
        if (role !== 'build' || result.approved !== true || result.trace.join(',') !== 'build,qc' || result.modules?.length > 4) throw new TypeError();
        validateConfig({ ...initialConfig(), modules: result.modules });
      }
      return json(result);
    } catch (error) {
      return json({ error: error.name === 'TimeoutError' ? 'JARVIS timed out.' : 'JARVIS worker is unreachable or returned invalid output.' }, 502);
    }
  };
}

export default createJarvisHandler();
export const config = { path: '/api/jarvis' };
