// /api/intel: knowledge, memory, research, tool registry, approvals, dev tasks and system status for the Brain control room.
// Auth: Studio key (x-lcp-studio-key), like JARVIS. POST needs a same-origin Origin header and a JSON body.
// GET  ?view=status | tools | memory&q= | knowledge&q= | documents&scope= | tasks | task&id= | audit | usage | dev | devtask&id= | artifact&id=
// POST { op, ... } with op in: research, memory.add, memory.update, memory.delete, memory.purge, knowledge.ingest, knowledge.delete,
//      knowledge.sync, tool.run, tool.approve, dev.create, dev.cancel
import { json } from './lib/auth.mjs';
import { jarvisAccess, readBody } from './lib/studio.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { createIntel } from './lib/intel/orchestrator.mjs';
import { allowedScopes } from './lib/intel/knowledge.mjs';
import { webSettings } from './lib/intel/web.mjs';
import { audit, readAudit } from './lib/intel/safety.mjs';
import { MODEL_LOG_KEY, modelLogger, usageSummary, withCosts } from './lib/model-log.mjs';
import { compactForModel } from './lib/groq.mjs';
import { buildReport, paramsFrom } from './lib/report.mjs';
import { loadBrainStatus } from './lib/brain-status.mjs';
import { schedulesOn } from './lib/schedules.mjs';
import { workerSignature } from './lib/slack.mjs';

const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const readLive = async filters => compactForModel(await buildReport(paramsFrom(filters && typeof filters === 'object' ? filters : { preset: '30d' })));

export function createIntelHandler({ env = process.env, fetchImpl = fetch, openStore = () => openJarvisStore(env), live = readLive, dispatch = null } = {}) {
  return async function handler(request) {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
    const access = jarvisAccess(request, env);
    if (!access) return json({ error: 'Administrator key rejected.' }, 401);
    let store;
    try { store = await openStore(); } catch { return json({ error: 'JARVIS storage is unavailable.' }, 503); }
    const logger = modelLogger({ openStore: async () => store });
    const intel = createIntel({ env, fetchImpl: logger.wrap(fetchImpl), store, readLive: live });
    const done = async (body, status = 200) => { await logger.flush(800); return json(body, status); };
    const fail = (error, fallback = 'The request failed.') => json({ error: error?.status ? error.message : fallback }, error?.status >= 400 && error?.status < 600 ? error.status : 502);

    if (request.method === 'GET') {
      const params = new URL(request.url).searchParams;
      const view = params.get('view') || 'status';
      try {
        if (view === 'status') {
          const [knowledge, memory, tools, tasks, dev, log, health] = await Promise.all([
            intel.knowledge.status(), intel.facts.stats(), intel.registry.list(), intel.tasks(), intel.dev.list(),
            store.getWithMetadata(MODEL_LOG_KEY, { type: 'json' }).then(e => e?.data).catch(() => null),
            loadBrainStatus(env, fetchImpl).catch(() => null),
          ]);
          const router = intel.router().status();
          return json({
            knowledgeSources: {
              live: { status: 'ok', note: 'LCP report, dialer, GHL, Ledger and Twilio through the existing MCP tools. Authoritative for current data.' },
              internal: { status: Object.values(knowledge.scopes).some(s => s.documents) ? 'ok' : 'empty', ...knowledge },
              web: { status: webSettings(env).enabled ? 'ok' : 'off', ...webSettings(env), keyless: ['wikipedia', 'github', 'npm'] },
              memory: { status: 'ok', ...memory },
            },
            providers: router.providers, routes: router.routes, cooling: router.cooling,
            tools: { total: tools.tools.length, available: tools.tools.filter(t => t.available).length, needApproval: tools.tools.filter(t => t.approval !== 'none').length, servers: tools.servers.map(({ tools: list, ...s }) => ({ ...s, tools: list.length })) },
            tasks: tasks.slice(0, 15), dev: { runnerOn: 'VM (DEV_RUNNER=1)', repos: String(env.DEV_REPOS || '').split(',').filter(Boolean), tasks: dev.slice(0, 10) },
            usage: withCosts(usageSummary(log), env),
            health: health ? Object.fromEntries(Object.entries(health).filter(([, v]) => v && typeof v === 'object' && 'status' in v).map(([k, v]) => [k, { status: v.status, detail: v.detail || v.message || null }])) : null,
            storage: env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim() ? 'supabase' : 'netlify-blobs', schedules: schedulesOn(env), scopes: allowedScopes(env),
          });
        }
        if (view === 'tools') return json(await intel.registry.list({ fresh: params.get('fresh') === '1' }));
        if (view === 'memory') return json({ items: await intel.facts.search(params.get('q') || '', { kinds: params.get('kind') ? [params.get('kind')] : undefined, limit: 30, status: params.get('status') || undefined }) });
        if (view === 'knowledge') return done(await intel.knowledge.search(params.get('q') || '', { limit: 8 }));
        if (view === 'documents') return json({ documents: await intel.knowledge.list(params.get('scope') || 'lcp') });
        if (view === 'tasks') return json({ tasks: await intel.tasks() });
        if (view === 'task' && uuid.test(params.get('id') || '')) { const task = await intel.task(params.get('id')); return task ? json(task) : json({ error: 'Task not found.' }, 404); }
        if (view === 'audit') return json({ rows: await readAudit(store, 100) });
        if (view === 'usage') return json(withCosts(usageSummary(await store.getWithMetadata(MODEL_LOG_KEY, { type: 'json' }).then(e => e?.data).catch(() => null)), env));
        if (view === 'dev') return json({ tasks: await intel.dev.list(), repos: String(env.DEV_REPOS || '').split(',').filter(Boolean) });
        if (view === 'devtask' && uuid.test(params.get('id') || '')) { const task = await intel.dev.get(params.get('id')); return task ? json(task) : json({ error: 'Task not found.' }, 404); }
        if (view === 'artifact' && uuid.test(params.get('id') || '')) {
          const artifact = await intel.dev.artifact(params.get('id'));
          if (!artifact) return json({ error: 'No artifact for this task.' }, 404);
          if (params.get('format') === 'zip') return new Response(Buffer.from(artifact.zipBase64, 'base64'), { headers: { 'content-type': 'application/zip', 'content-disposition': 'attachment; filename="dev-' + params.get('id').slice(0, 8) + '.zip"', 'cache-control': 'private, no-store' } });
          return json({ files: artifact.files, patch: artifact.patch, createdAt: artifact.createdAt });
        }
        return json({ error: 'Unknown view.' }, 400);
      } catch (error) { return fail(error, 'The view could not be loaded.'); }
    }

    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
    let body;
    try { body = await readBody(request, 3 * 1048576); if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.op !== 'string') throw new TypeError(); }
    catch { return json({ error: 'Invalid request.' }, 400); }
    const actor = 'studio-key';
    try {
      switch (body.op) {
        case 'research': {
          if (body.deep === true) {
            const task = await intel.enqueue(body.objective, { web: body.web, remember: body.remember, by: actor });
            const work = JSON.stringify({ taskId: task.id });
            const secret = env.LCP_STUDIO_KEY || '';
            try {
              if (dispatch) await dispatch(work);
              else if (env.INTEL_WORKER_ON !== 'vm') await fetchImpl(new URL('/.netlify/functions/intel-worker-background', request.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcp-intel-worker': workerSignature(secret, work) }, body: work, signal: AbortSignal.timeout(2500) });
            } catch { /* the VM worker or a retry picks it up */ }
            return json({ queued: true, id: task.id, status: 'queued' }, 202);
          }
          const record = await intel.run(body.objective, { web: body.web, remember: body.remember, filters: body.filters, by: actor });
          return done(record, record.status === 'failed' ? 502 : 200);
        }
        case 'memory.add': { const r = await intel.facts.add(body, { scope: body.scope || 'lcp', by: actor }); await audit(store, { actor, action: body.op, target: r.item.id, result: r.status }); return json(r); }
        case 'memory.update': { const r = await intel.facts.edit(body.id, body, { scope: body.scope || 'lcp' }); await audit(store, { actor, action: body.op, target: body.id, result: 'ok' }); return json(r); }
        case 'memory.delete': { const r = await intel.facts.remove(body.id, { scope: body.scope || 'lcp' }); await audit(store, { actor, action: body.op, target: body.id, result: 'ok' }); return json(r); }
        case 'memory.purge': { const r = await intel.facts.purge({ scope: body.scope || 'lcp', kind: body.kind, olderThanDays: body.olderThanDays }); await audit(store, { actor, action: body.op, result: String(r.purged) }); return json(r); }
        case 'knowledge.ingest': {
          const docs = Array.isArray(body.documents) ? body.documents.slice(0, 20) : [body];
          const results = [];
          for (const doc of docs) {
            try { results.push(await intel.knowledge.ingest({ scope: doc.scope || body.scope || 'lcp', path: doc.path, content: doc.content, encoding: doc.encoding, source: doc.source || 'upload' })); }
            catch (error) { results.push({ path: doc.path, status: 'failed', error: error.message }); }
          }
          await audit(store, { actor, action: body.op, result: results.map(r => r.status).join(','), detail: results.map(r => r.path) });
          return done({ results });
        }
        case 'knowledge.delete': { const r = await intel.knowledge.remove(body.scope || 'lcp', body.ids || body.id); await audit(store, { actor, action: body.op, result: String(r.removed) }); return json(r); }
        case 'knowledge.sync': {
          // Repo indexing can exceed a request. Run it in the background function; the VM also syncs INTEL_REPOS daily.
          const work = JSON.stringify({ sync: { repo: body.repo, ref: body.ref, scope: body.scope || 'lcp' } });
          if (dispatch) await dispatch(work);
          else await fetchImpl(new URL('/.netlify/functions/intel-worker-background', request.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-lcp-intel-worker': workerSignature(env.LCP_STUDIO_KEY || '', work) }, body: work, signal: AbortSignal.timeout(2500) }).catch(() => {});
          await audit(store, { actor, action: body.op, target: String(body.repo || '').slice(0, 120), result: 'started' });
          return json({ started: true, repo: body.repo }, 202);
        }
        case 'tool.run': {
          if (typeof body.tool !== 'string') return json({ error: 'tool is required.' }, 400);
          const r = await intel.registry.execute(body.tool, body.args || {}, { by: actor });
          await audit(store, { actor, action: body.op, target: body.tool, result: r.status, detail: r.error || '' });
          return done(r, r.status === 'ok' || r.status === 'approval_required' ? 200 : r.status === 'invalid' ? 400 : r.status === 'unavailable' ? 503 : 502);
        }
        case 'tool.approve': {
          const r = await intel.registry.approve(body.id, { decision: body.decision === 'reject' ? 'reject' : 'approve', by: actor });
          await audit(store, { actor, action: body.op, target: r.tool || String(body.id).slice(0, 36), result: r.status, detail: r.error || '' });
          return json(r, r.status === 'ok' || r.status === 'rejected' ? 200 : r.status === 'expired' ? 410 : 400);
        }
        case 'dev.create': { const r = await intel.dev.create(body, { by: actor }); await audit(store, { actor, action: body.op, target: r.id, result: 'queued', detail: body.repo }); return json(r, 202); }
        case 'dev.cancel': { const r = await intel.dev.cancel(body.id); await audit(store, { actor, action: body.op, target: body.id, result: r.status }); return json(r); }
        default: return json({ error: 'Unknown op.' }, 400);
      }
    } catch (error) {
      await audit(store, { actor, action: body.op, result: 'error', detail: error.message });
      return fail(error);
    }
  };
}

export default createIntelHandler();
export const config = { path: '/api/intel' };
