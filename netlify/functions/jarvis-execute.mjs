// JARVIS execution sandbox (ported from A2Z). Studio key or HighLevel admin session, same origin and JSON required.
// POST { action: "validate", plan }                -> static checks and the plan hash. No SQL runs.
// POST { action: "run", plan, planHash, filters? } -> runs the validated plan on a throwaway copy of LCP aggregates.
// GET                                               -> recent audit log.
// Nothing is applied to production. Set JARVIS_EXECUTE=off to disable the endpoint.
import { randomUUID } from 'node:crypto';
import { json } from './lib/auth.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { update } from './lib/jarvis-memory.mjs';
import { runPlan, sandboxTables, validatePlan } from './lib/jarvis-sandbox.mjs';
import { buildReport, paramsFrom } from './lib/report.mjs';
import { jarvisAccess, readBody } from './lib/studio.mjs';

export const LOG_KEY = 'exec/log';
const emptyLog = () => ({ entries: [] });

export function createExecuteHandler({ env = process.env, openStore = () => openJarvisStore(env), readReport = filters => buildReport(paramsFrom(filters)), run = runPlan } = {}) {
  let running = false;
  return async function handler(request) {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
    const access = jarvisAccess(request, env);
    if (!access) return json({ error: 'Administrator key rejected.' }, 401);
    if (env.JARVIS_EXECUTE === 'off') return json({ error: 'Execution is disabled (JARVIS_EXECUTE=off).' }, 403);
    if (request.method === 'GET') {
      try {
        const entry = await (await openStore()).getWithMetadata(LOG_KEY, { type: 'json' });
        return json({ entries: (entry?.data?.entries || []).slice(0, 20) });
      } catch {
        return json({ error: 'JARVIS storage is unavailable.' }, 503);
      }
    }
    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
    let body;
    try {
      body = await readBody(request, 16384);
      if (!body || typeof body !== 'object' || !['validate', 'run'].includes(body.action)) throw new TypeError();
      if (body.filters !== undefined && (!body.filters || typeof body.filters !== 'object' || Array.isArray(body.filters))) throw new TypeError();
      if (body.action === 'run' && (typeof body.planHash !== 'string' || !/^[0-9a-f]{64}$/.test(body.planHash))) throw new TypeError();
    } catch {
      return json({ error: 'Invalid execution request.' }, 400);
    }
    const checked = validatePlan(body.plan);
    const validation = { ok: checked.ok, errors: checked.errors, warnings: checked.warnings };
    if (body.action === 'validate') return json({ validation, plan: checked.ok ? checked.plan : null, planHash: checked.hash });
    if (!checked.ok) return json({ error: 'The plan failed validation.', validation }, 422);
    if (checked.hash !== body.planHash) return json({ error: 'The plan changed after validation. Validate it again before running.' }, 409);
    if (running) return json({ error: 'Another sandbox run is in progress. Retry shortly.' }, 429);
    running = true;
    const entry = { id: randomUUID(), at: new Date().toISOString(), by: access.userId || 'studio key', task: checked.plan.task, planHash: checked.hash, outcome: 'running' };
    let store;
    try {
      // Fail closed: no run without an audit record.
      try {
        store = await openStore();
        await update(store, LOG_KEY, emptyLog, log => { log.entries.unshift(entry); log.entries.length = Math.min(log.entries.length, 50); });
      } catch {
        return json({ error: 'JARVIS storage is unavailable, so the run was not started.' }, 503);
      }
      let result;
      try {
        result = await run(checked.plan, sandboxTables(await readReport(body.filters || { preset: '30d' })));
      } catch (error) {
        result = { outcome: 'failed', applied: false, error: error.agentStatus ? error.message : 'The sandbox could not run this plan.', steps: [], checks: [], staged: [] };
      }
      await update(store, LOG_KEY, emptyLog, log => {
        const saved = log.entries.find(item => item.id === entry.id);
        if (!saved) return false;
        Object.assign(saved, { outcome: result.outcome, staged: result.staged.length, finishedAt: new Date().toISOString() });
      }).catch(() => {});
      return json({ runId: entry.id, validation, ...result });
    } finally {
      running = false;
    }
  };
}

export default createExecuteHandler();
export const config = { path: '/api/jarvis-execute' };
