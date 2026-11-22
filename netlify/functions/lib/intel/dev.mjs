// Development tasks: queue side (Netlify and VM) for the sandboxed dev runner (server/dev-runner.mjs, VM only).
// Netlify never runs code: it validates the request, checks the repo allowlist and queues it. The VM runner claims it,
// works in an isolated workspace, runs allowlisted commands, and writes back a patch and a ZIP of changed files.
// Nothing is deployed. DEV_REPOS = comma list of owner/repo that may be used.
import { randomUUID } from 'node:crypto';
import { update } from '../jarvis-memory.mjs';
import { clip } from './text.mjs';
import { containsSecret } from './safety.mjs';

export const DEV_INDEX = 'dev/index';
export const devKey = id => 'dev/task/' + id;
export const devArtifactKey = id => 'dev/artifact/' + id;
export const devRepos = (env = process.env) => String(env.DEV_REPOS || '').split(',').map(s => s.trim()).filter(s => /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s));

export function createDev({ store, env = process.env, now = Date.now }) {
  async function index(mutate) {
    return update(store, DEV_INDEX, () => ({ tasks: [] }), data => { mutate(data); data.tasks = data.tasks.slice(0, 40); });
  }
  async function create({ repo, objective, ref }, { by = 'operator' } = {}) {
    const allowed = devRepos(env);
    if (!allowed.some(r => r.toLowerCase() === String(repo || '').toLowerCase())) throw Object.assign(new Error('Repository is not in DEV_REPOS. Allowed: ' + (allowed.join(', ') || 'none') + '.'), { status: 403 });
    const text = clip(String(objective || '').trim(), 2000);
    if (text.length < 10) throw Object.assign(new Error('Describe the change in at least 10 characters.'), { status: 400 });
    if (containsSecret(text)) throw Object.assign(new Error('Remove secrets from the objective.'), { status: 422 });
    if (ref !== undefined && !/^[\w./-]{1,100}$/.test(ref)) throw Object.assign(new Error('Invalid ref.'), { status: 400 });
    const task = { id: randomUUID(), repo: allowed.find(r => r.toLowerCase() === repo.toLowerCase()), ref: ref || null, objective: text, status: 'queued', by,
      createdAt: new Date(now()).toISOString(), log: [], attempts: [] };
    await store.setJSON(devKey(task.id), task);
    await index(data => { data.tasks.unshift({ id: task.id, repo: task.repo, objective: clip(text, 120), status: 'queued', createdAt: task.createdAt }); });
    return { id: task.id, status: 'queued', repo: task.repo, note: 'The VM dev runner (DEV_RUNNER=1) picks this up within a minute. Nothing is deployed.' };
  }
  async function list() { return (await store.getWithMetadata(DEV_INDEX, { type: 'json' }))?.data?.tasks || []; }
  async function get(id) { return (await store.getWithMetadata(devKey(id), { type: 'json' }))?.data || null; }
  async function artifact(id) { return (await store.getWithMetadata(devArtifactKey(id), { type: 'json' }))?.data || null; }
  async function cancel(id) {
    const entry = await store.getWithMetadata(devKey(id), { type: 'json' });
    if (!entry?.data) throw Object.assign(new Error('Task not found.'), { status: 404 });
    if (!['queued', 'running'].includes(entry.data.status)) return { id, status: entry.data.status };
    await store.setJSON(devKey(id), { ...entry.data, status: 'cancelled', finishedAt: new Date(now()).toISOString() }, { onlyIfMatch: entry.etag });
    await setIndexStatus(id, 'cancelled');
    return { id, status: 'cancelled' };
  }
  async function setIndexStatus(id, status) { await index(data => { const t = data.tasks.find(x => x.id === id); if (t) t.status = status; }).catch(() => {}); }
  // Runner: claim the oldest queued task with a conditional write.
  async function claim(by = 'vm') {
    for (const summary of [...await list()].reverse()) {
      if (summary.status !== 'queued') continue;
      const entry = await store.getWithMetadata(devKey(summary.id), { type: 'json' });
      if (entry?.data?.status !== 'queued') continue;
      const task = { ...entry.data, status: 'running', startedAt: new Date(now()).toISOString(), runner: by };
      const saved = await store.setJSON(devKey(summary.id), task, { onlyIfMatch: entry.etag });
      if (saved?.modified) { await setIndexStatus(task.id, 'running'); return task; }
    }
    return null;
  }
  async function save(task) {
    await store.setJSON(devKey(task.id), task);
    await setIndexStatus(task.id, task.status);
  }
  return { create, list, get, artifact, cancel, claim, save };
}
