// Intel orchestrator: one task = gather (live data, internal docs, memory, web) -> shared context -> routed model -> checks -> record.
// Gathering is deterministic and parallel with per-step timeouts. Failed steps are recorded and reported, never hidden.
// Answers carry citations ([L1] live, [K1] internal, [M1] memory, [W1] web); an answer without citations is labeled model reasoning.
// Fast mode fits a Netlify request (about 8 s). Deep mode is queued and run by the background function or the VM worker.
import { randomUUID } from 'node:crypto';
import { update } from '../jarvis-memory.mjs';
import { modelTimeout } from '../jarvis-agents.mjs';
import { createKnowledge } from './knowledge.mjs';
import { createFacts } from './memory.mjs';
import { createRegistry } from './tools.mjs';
import { createRouter, classify } from './router.mjs';
import { createTaskContext, provenance } from './context.mjs';
import { githubRead, readPage, research, webSearch, webSettings } from './web.mjs';
import { createDev } from './dev.mjs';
import { audit } from './safety.mjs';
import { clip } from './text.mjs';

const TASK_INDEX = 'tasks/index';
const taskKey = id => 'tasks/' + id;
const urlPattern = /https:\/\/[^\s<>"')\]]+/g;

export function needs(objective, taskClass, { web } = {}) {
  const text = String(objective || '');
  const urls = text.match(urlPattern) || [];
  const live = ['data', 'operations'].includes(taskClass) || /\b(?:today|yesterday|this (?:week|month)|kpis?|dials?|leads?|opportunit|accounting|fees|workflow|twilio|ghl)\b/i.test(text);
  const wantsWeb = web === true || urls.length > 0 || /\b(?:latest|current version|release notes|docs?|documentation|github|npm|search the web|look up|online|research|news|best practice|compare (?:tools|vendors|options))\b/i.test(text)
    || (['research', 'coding', 'debugging'].includes(taskClass) && !live);
  return { live, internal: true, memory: true, web: web === false ? false : wantsWeb, urls: urls.slice(0, 2) };
}

async function step(steps, name, ms, fn) {
  const started = Date.now();
  const entry = { name, status: 'running' };
  steps.push(entry);
  try {
    const value = await Promise.race([fn(), new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('timed out after ' + ms + ' ms'), { timeout: true })), ms).unref?.())]);
    Object.assign(entry, { status: 'ok', ms: Date.now() - started });
    return value;
  } catch (error) {
    Object.assign(entry, { status: error.timeout ? 'timeout' : 'failed', ms: Date.now() - started, error: clip(error.message || 'failed', 200) });
    return null;
  }
}

export function createIntel({ env = process.env, fetchImpl = fetch, store, readLive = null, resolve, now = Date.now } = {}) {
  const knowledge = createKnowledge({ store, env, fetchImpl });
  const facts = createFacts({ store, env });
  const dev = createDev({ store, env });
  const web = {
    search: (query, options = {}) => webSearch(query, { env, fetchImpl, store, ...options }),
    read: (url, question) => readPage(url, { question, fetchImpl, resolve, store }),
    github: target => githubRead(target, { env, fetchImpl }),
  };
  const registry = createRegistry({ env, fetchImpl, store, services: { web, knowledge, facts, dev } });

  async function saveTask(record) {
    await store.setJSON(taskKey(record.id), record);
    const summary = { id: record.id, objective: clip(record.objective, 140), status: record.status, taskClass: record.taskClass, model: record.model || null,
      sources: record.provenance?.types || [], errors: (record.steps || []).filter(s => s.status !== 'ok').length, createdAt: record.createdAt, finishedAt: record.finishedAt || null };
    await update(store, TASK_INDEX, () => ({ tasks: [] }), data => {
      data.tasks = [summary, ...data.tasks.filter(t => t.id !== record.id)].slice(0, 60);
    }).catch(() => {});
  }

  // Main entry. options: { deep, web, scopes, budgetMs, by, remember, id }
  async function run(objective, options = {}) {
    const text = String(objective || '').trim();
    if (text.length < 3 || text.length > 2000) throw Object.assign(new Error('Describe the task in 3 to 2000 characters.'), { status: 400 });
    const deep = options.deep === true;
    const budgetMs = Math.max(3000, Math.min(deep ? 120000 : 9000, options.budgetMs || (deep ? 90000 : Number(env.INTEL_SYNC_BUDGET_MS) || 8000)));
    const started = now();
    const left = () => budgetMs - (now() - started);
    const taskClass = classify(text);
    const need = needs(text, taskClass, { web: options.web });
    const record = { id: options.id || randomUUID(), objective: text, taskClass, mode: deep ? 'deep' : 'fast', status: 'running', by: options.by || 'operator',
      createdAt: new Date(started).toISOString(), steps: [], need };
    const context = createTaskContext({ objective: text, taskClass, constraints: [
      'Live LCP data [L] is authoritative for current operations. Internal docs [K] and memory [M] describe how things are set up. Web [W] is external and may be outdated.',
      'Cite every factual claim with its id. Put anything not supported by evidence under assumptions.',
      'Do not claim actions were taken. Consequential actions need operator approval.',
    ] });
    const gatherMs = Math.max(1500, Math.floor(left() * (deep ? 0.5 : 0.45)));
    const jobs = [];
    if (need.memory) jobs.push(step(record.steps, 'memory', Math.min(gatherMs, 2500), async () => context.addMemory(await facts.search(text, { limit: 6 }))));
    if (need.internal) jobs.push(step(record.steps, 'internal', gatherMs, async () => {
      const found = await knowledge.search(text, { limit: deep ? 8 : 5 });
      context.addInternal(found.results);
      record.knowledgeMode = found.mode || 'none';
    }));
    if (need.live && readLive) jobs.push(step(record.steps, 'live', gatherMs, async () => context.addLive('lcp_report', await readLive(options.filters))));
    if (need.web && webSettings(env).enabled) {
      const githubUrl = need.urls.find(u => /^https:\/\/github\.com\/[^/]+\/[^/]+/.test(u));
      if (githubUrl) jobs.push(step(record.steps, 'github', gatherMs, async () => {
        const data = await web.github(githubUrl);
        context.addWeb([{ url: data.url || githubUrl, title: data.repo + (data.path ? '/' + data.path : ''), retrievedAt: data.retrievedAt, text: data.readme || data.content || JSON.stringify(data.entries || []), kind: 'retrieved' }]);
      }));
      for (const url of need.urls.filter(u => u !== githubUrl)) jobs.push(step(record.steps, 'fetch', gatherMs, async () => {
        const page = await web.read(url, text);
        context.addWeb(page.passages.map(p => ({ url: page.finalUrl, title: page.title, retrievedAt: page.retrievedAt, text: p.text, kind: 'retrieved' })));
      }));
      if (!need.urls.length) jobs.push(step(record.steps, 'web', gatherMs, async () => {
        const found = await research(text, { env, fetchImpl, resolve, store, pages: deep ? 3 : 1, limit: deep ? 6 : 4, budgetMs: gatherMs - 200 });
        context.addWeb(found.findings);
        if (found.failures.length) record.webFailures = found.failures;
      }));
    }
    await Promise.all(jobs);
    const view = context.forModel();
    record.contextTokens = view.tokens;

    const usage = { total: 0, calls: 0 };
    const timeoutMs = Math.max(1500, Math.min(modelTimeout(env), left() - 400));
    const router = createRouter({ env, fetchImpl, store, timeoutMs });
    let answer, assumptions = [], outstanding = [];
    try {
      const { output, model, attempts } = await router.call(taskClass === 'general' && view.citations.length ? 'research' : taskClass,
        'You are the LCP research and knowledge agent. Answer the objective from the evidence. Cite ids like [K1] after each claim. ' +
        'When evidence is missing or conflicting, say so. Return JSON {"answer": string (max 2500 chars), "assumptions": [strings], "outstanding": [strings]}.',
        view, { structured: true, usage, deadline: started + budgetMs - 300 });
      answer = clip(String(output?.answer || '').replace(/[–—]/g, '-'), 4000);
      assumptions = (Array.isArray(output?.assumptions) ? output.assumptions : []).slice(0, 6).map(a => clip(String(a), 300));
      outstanding = (Array.isArray(output?.outstanding) ? output.outstanding : []).slice(0, 6).map(a => clip(String(a), 200));
      Object.assign(record, { model, attempts });
      if (!answer) throw new Error('The model returned an empty answer.');
    } catch (error) {
      record.status = 'failed';
      record.error = clip(error.message, 400);
      record.attempts = error.attempts || record.attempts;
    }
    if (answer) {
      const prov = provenance(answer, view.citations);
      const checks = [{ check: 'citations resolve', ok: !prov.unknownCitations.length, detail: prov.unknownCitations.length ? 'Unknown ids: ' + prov.unknownCitations.join(', ') : 'all cited ids exist' },
        { check: 'evidence used', ok: !prov.modelOnly, detail: prov.modelOnly ? 'No citations. Treat as model reasoning.' : prov.types.join(', ') }];
      // Independent model check in deep mode, on a different model than the producer, when time allows.
      if (deep && !prov.modelOnly && left() > 4000) {
        try {
          const { output, model } = await router.call('verification', 'You are an independent verifier. Check each cited claim in the answer against the evidence. Return JSON {"supported": boolean, "issues": [strings]}.',
            { answer, evidence: view.evidence, citations: view.citations }, { structured: true, usage, exclude: [record.model] });
          checks.push({ check: 'independent verification', ok: output?.supported === true, detail: (output?.issues || []).slice(0, 4).join('; ') || 'no issues', model });
        } catch (error) { checks.push({ check: 'independent verification', ok: null, detail: 'skipped: ' + clip(error.message, 120) }); }
      }
      const failed = checks.some(c => c.ok === false);
      Object.assign(record, { status: 'done', answer, assumptions, outstanding, provenance: { types: prov.types, modelOnly: prov.modelOnly },
        verification: { status: failed ? 'issues' : checks.some(c => c.ok === null) ? 'partial' : prov.modelOnly ? 'unverified' : 'checked', checks } });
      // Research findings with sources are remembered (deduplicated) unless the caller opts out.
      const webCited = prov.cited.filter(s => s.type === 'web');
      if (options.remember !== false && webCited.length && !failed) {
        await facts.add({ kind: 'research', text: clip(text, 200) + ' => ' + clip(answer.replace(/\[[LKMW]\d+\]/g, ''), 600), source: webCited.map(s => s.url).slice(0, 3).join(' '), tags: [taskClass] }, { scope: 'lcp', by: 'research' }).catch(() => {});
      }
    }
    Object.assign(record, { sources: view.citations, usage: { totalTokens: usage.total, calls: usage.calls }, ms: now() - started, finishedAt: new Date(now()).toISOString() });
    await saveTask(record).catch(() => {});
    await audit(store, { actor: record.by, action: 'intel.run', target: record.id, result: record.status, detail: { class: taskClass, steps: record.steps.map(s => s.name + ':' + s.status), model: record.model || null } });
    return record;
  }

  async function enqueue(objective, options = {}) {
    const record = { id: randomUUID(), objective: clip(String(objective || ''), 2000), mode: 'deep', status: 'queued', options: { web: options.web, remember: options.remember }, by: options.by || 'operator', createdAt: new Date(now()).toISOString(), steps: [] };
    if (record.objective.length < 3) throw Object.assign(new Error('Describe the task in 3 to 2000 characters.'), { status: 400 });
    await saveTask(record);
    return record;
  }

  // Run one queued deep task by id (background function) or the oldest queued task (VM worker). Claims it with a conditional write.
  async function processQueued(id) {
    let targetId = id;
    if (!targetId) targetId = ((await store.getWithMetadata(TASK_INDEX, { type: 'json' }))?.data?.tasks || []).filter(t => t.status === 'queued').pop()?.id;
    if (!targetId) return null;
    const entry = await store.getWithMetadata(taskKey(targetId), { type: 'json' });
    if (entry?.data?.status !== 'queued') return null;
    const claim = await store.setJSON(taskKey(targetId), { ...entry.data, status: 'running' }, { onlyIfMatch: entry.etag });
    if (!claim?.modified) return null;
    return run(entry.data.objective, { ...entry.data.options, deep: true, id: targetId, by: entry.data.by });
  }

  async function tasks() { return (await store.getWithMetadata(TASK_INDEX, { type: 'json' }))?.data?.tasks || []; }
  async function task(id) { return (await store.getWithMetadata(taskKey(id), { type: 'json' }))?.data || null; }

  // Short memory digest for every JARVIS agent (one storage read, about 600 characters). Empty when nothing matches.
  async function memoryHint(prompt) {
    try {
      const items = await facts.search(prompt, { limit: 3 });
      return items.length ? 'Relevant saved memory (decisions and facts the operator recorded):\n' + items.map(i => '- (' + i.kind + ') ' + clip(i.text, 180)).join('\n') : '';
    } catch { return ''; }
  }

  return { run, enqueue, processQueued, tasks, task, knowledge, facts, registry, web, dev, memoryHint, router: () => createRouter({ env, fetchImpl, store }) };
}
