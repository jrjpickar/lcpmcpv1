// Netlify background function (up to 15 minutes): deep research tasks and GitHub repo indexing queued by /api/intel.
// Only accepts work signed with LCP_STUDIO_KEY by /api/intel. With INTEL_WORKER_ON=vm the VM worker handles the queue instead.
import { verifyWorker } from './lib/slack.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { createIntel } from './lib/intel/orchestrator.mjs';
import { modelLogger } from './lib/model-log.mjs';
import { compactForModel } from './lib/groq.mjs';
import { buildReport, paramsFrom } from './lib/report.mjs';
import { audit } from './lib/intel/safety.mjs';

export function createIntelWorker({ env = process.env, fetchImpl = fetch, openStore = () => openJarvisStore(env) } = {}) {
  return async function work(payload) {
    const store = await openStore();
    const logger = modelLogger({ openStore: async () => store });
    const intel = createIntel({ env: { ...env, MODEL_TIMEOUT_MS: env.MODEL_TIMEOUT_MS || '20000' }, fetchImpl: logger.wrap(fetchImpl), store,
      readLive: async filters => compactForModel(await buildReport(paramsFrom(filters || { preset: '30d' }))) });
    try {
      if (payload.taskId) return await intel.processQueued(payload.taskId);
      if (payload.queued) return await intel.processQueued();
      if (payload.sync) {
        const report = await intel.knowledge.syncRepo({ ...payload.sync, deadlineMs: 12 * 60000 });
        await audit(store, { actor: 'intel-worker', action: 'knowledge.sync', target: report.repo, result: 'indexed ' + report.indexed + ', unchanged ' + report.unchanged + ', pruned ' + report.pruned + ', failed ' + report.failed.length });
        return report;
      }
      return null;
    } finally { await logger.flush(2000); }
  };
}

export default async request => {
  const body = await request.text();
  if (!verifyWorker(process.env.LCP_STUDIO_KEY || '', body, request.headers.get('x-lcp-intel-worker'))) return new Response('', { status: 401 });
  try { await createIntelWorker()(JSON.parse(body)); }
  catch (error) { console.log('Intel worker failed', error.message); }
  return new Response('', { status: 202 });
};
export const config = {};
