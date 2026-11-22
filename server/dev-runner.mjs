// Sandboxed development runner. VM only (DEV_RUNNER=1). Never on Netlify, never against live business systems.
// Flow per task: download the allowlisted repo (GitHub tarball, read-only token) -> isolated workspace under DEV_WORKDIR ->
// pick relevant files (BM25, no model) -> retrieve internal docs, memory and optional web docs -> model proposes edits as JSON ->
// edits applied with path checks -> allowlisted commands run (npm ci --ignore-scripts, npm test, npm run build/lint, node --test) ->
// failures fed back, up to DEV_MAX_ATTEMPTS -> unified diff + ZIP of changed files saved to storage. Nothing is pushed or deployed.
// Limits: one task at a time, wall clock DEV_TASK_MINUTES (15), command timeout DEV_COMMAND_SECONDS (240), child heap 256 MB,
// output tails only, child env without any secrets (PATH, HOME, CI, npm cache only), shell never used.
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile, realpath, lstat, readdir } from 'node:fs/promises';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { createDev, devArtifactKey } from '../netlify/functions/lib/intel/dev.mjs';
import { untarGz, unifiedDiff, zip } from '../netlify/functions/lib/intel/archive.mjs';
import { bm25, clip, tokenize } from '../netlify/functions/lib/intel/text.mjs';
import { createRouter } from '../netlify/functions/lib/intel/router.mjs';
import { createKnowledge, typeOf } from '../netlify/functions/lib/intel/knowledge.mjs';
import { createFacts } from '../netlify/functions/lib/intel/memory.mjs';
import { research } from '../netlify/functions/lib/intel/web.mjs';
import { audit, redact, UNTRUSTED_RULE } from '../netlify/functions/lib/intel/safety.mjs';

const ALLOWED_SCRIPTS = ['test', 'build', 'lint', 'typecheck', 'check'];
const SKIP = /(?:^|\/)(?:node_modules|\.git|dist|build|coverage|\.netlify|vendor)(?:\/|$)|package-lock\.json$|\.min\.js$|(?:^|\/)\.env/;

// Resolve a repo-relative path inside the workspace or throw. Refuses .., absolute paths, .git, node_modules and symlink escapes.
export async function safePath(root, rel) {
  const clean = normalize(String(rel || '')).replace(/^(\.\/)+/, '');
  if (!clean || clean.startsWith('..') || clean.startsWith(sep) || /(?:^|[\\/])(?:\.git|node_modules)(?:[\\/]|$)|(?:^|[\\/])\.env/.test(clean)) throw new Error('Path not allowed: ' + rel);
  const target = join(root, clean);
  const realRoot = await realpath(root);
  let probe = target;
  for (;;) {
    try { const real = await realpath(probe); if (real !== realRoot && !real.startsWith(realRoot + sep)) throw new Error('Path escapes the workspace: ' + rel); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; probe = dirname(probe); }
  }
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error('Symlinks cannot be edited: ' + rel); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { abs: target, rel: clean.split(sep).join('/') };
}

// Only these command shapes run. Arguments are fixed here, never taken from the model.
export function commandFor(id, pkg) {
  if (id === 'install') return ['npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--prefer-offline']];
  if (id === 'node-test') return ['node', ['--test']];
  if (ALLOWED_SCRIPTS.includes(id) && pkg?.scripts?.[id]) return ['npm', id === 'test' ? ['test'] : ['run', id]];
  return null;
}

export function runCommand(cmd, args, { cwd, timeoutMs, cacheDir }) {
  return new Promise(resolve => {
    const started = Date.now();
    const env = { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin', HOME: cwd, CI: '1', NODE_ENV: 'test', npm_config_cache: cacheDir,
      npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', NODE_OPTIONS: '--max-old-space-size=256' };
    const child = spawn(cmd, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    const keep = chunk => { out = (out + chunk.toString('utf8')).slice(-24000); };
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } out += '\n[killed: timeout]'; }, timeoutMs);
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, ms: Date.now() - started, output: 'Could not start ' + cmd + ': ' + error.message }); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, ms: Date.now() - started, output: redact(out, { keepContacts: true }).slice(-8000) }); });
  });
}

async function walk(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs).split(sep).join('/');
    if (SKIP.test(rel)) continue;
    if (entry.isDirectory()) await walk(root, abs, out);
    else if (entry.isFile() && typeOf(rel)) out.push(rel);
    if (out.length > 4000) break;
  }
  return out;
}

export function applyEdits(files, edits) {
  const changed = new Map();
  const errors = [];
  for (const edit of Array.isArray(edits) ? edits.slice(0, 20) : []) {
    if (!edit || typeof edit.path !== 'string') { errors.push('Edit without a path.'); continue; }
    const current = changed.has(edit.path) ? changed.get(edit.path) : files.get(edit.path) ?? null;
    if (typeof edit.content === 'string') {
      if (edit.content.length > 200000) { errors.push(edit.path + ': file too large'); continue; }
      changed.set(edit.path, edit.content); continue;
    }
    if (typeof edit.search !== 'string' || typeof edit.replace !== 'string' || !edit.search) { errors.push(edit.path + ': needs search and replace, or content.'); continue; }
    if (current === null) { errors.push(edit.path + ': file does not exist; use content to create it.'); continue; }
    const first = current.indexOf(edit.search);
    if (first < 0) { errors.push(edit.path + ': search text not found.'); continue; }
    if (current.indexOf(edit.search, first + 1) >= 0) { errors.push(edit.path + ': search text matches more than once; include more context.'); continue; }
    changed.set(edit.path, current.slice(0, first) + edit.replace + current.slice(first + edit.search.length));
  }
  return { changed, errors };
}

export function createDevRunner({ env = process.env, openStore, fetchImpl = fetch, log = console.log }) {
  const workdir = env.DEV_WORKDIR || join(env.DATA_DIR || '/data', 'dev');
  const maxAttempts = Math.min(5, Math.max(1, Number(env.DEV_MAX_ATTEMPTS) || 3));
  const commandMs = Math.min(600, Math.max(30, Number(env.DEV_COMMAND_SECONDS) || 240)) * 1000;
  const taskMs = Math.min(60, Math.max(3, Number(env.DEV_TASK_MINUTES) || 15)) * 60000;
  let busy = false;

  async function download(repo, ref) {
    const headers = { 'user-agent': 'LCP-JARVIS-Dev', accept: 'application/vnd.github+json', ...(env.GITHUB_TOKEN?.trim() ? { authorization: 'Bearer ' + env.GITHUB_TOKEN.trim() } : {}) };
    const response = await fetchImpl('https://api.github.com/repos/' + repo + '/tarball' + (ref ? '/' + encodeURIComponent(ref) : ''), { headers, redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error('GitHub tarball HTTP ' + response.status);
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > 50 * 1048576) throw new Error('Repository archive exceeds 50 MB.');
    return untarGz(buffer);
  }

  async function runTask(task, store) {
    const dev = createDev({ store, env });
    const deadline = Date.now() + taskMs;
    const note = text => { task.log.push({ at: new Date().toISOString(), text: clip(text, 400) }); };
    const root = join(workdir, task.id, 'repo');
    await rm(join(workdir, task.id), { recursive: true, force: true });
    await mkdir(root, { recursive: true });
    try {
      const entries = await download(task.repo, task.ref);
      for (const file of entries) {
        if (/(?:^|\/)(?:node_modules|\.git)(?:\/|$)|(?:^|\/)\.env/.test(file.path)) continue;
        const { abs } = await safePath(root, file.path);
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, file.content);
      }
      note('Downloaded ' + task.repo + ' (' + entries.length + ' files) into an isolated workspace.');
      const paths = await walk(root);
      const original = new Map();
      for (const rel of paths) { try { const text = await readFile(join(root, rel), 'utf8'); if (text.length <= 200000) original.set(rel, text); } catch { /* skip unreadable */ } }
      let pkg = null;
      try { pkg = JSON.parse(original.get('package.json') || 'null'); } catch { /* not a Node repo */ }
      // Relevant files: BM25 over path + content, top 8 within 60 KB.
      const list = [...original.keys()];
      const scores = bm25(tokenize(task.objective), list.map(p => tokenize(p + ' ' + p + ' ' + original.get(p).slice(0, 20000))));
      const picked = []; let size = 0;
      for (const [p] of list.map((p, i) => [p, scores[i]]).sort((a, b) => b[1] - a[1])) {
        const text = original.get(p);
        if (size + text.length > 60000) continue;
        picked.push(p); size += text.length;
        if (picked.length >= 8) break;
      }
      note('Selected files: ' + picked.join(', '));
      // Research: internal docs, memory, and web docs when the objective names a library or doc.
      const knowledge = createKnowledge({ store, env, fetchImpl });
      const facts = createFacts({ store, env });
      const [docs, memories, webDocs] = await Promise.all([
        knowledge.search(task.objective, { limit: 4 }).catch(() => ({ results: [] })),
        facts.search(task.objective, { limit: 5, kinds: ['architecture', 'decision', 'bug', 'fix', 'instruction', 'preference'] }).catch(() => []),
        /\b(?:docs?|api|library|package|sdk|upgrade|deprecat)/i.test(task.objective) ? research(task.objective, { env, fetchImpl, pages: 1, budgetMs: 15000 }).catch(() => null) : null,
      ]);
      const scripts = ['test', 'build', 'lint'].filter(id => pkg?.scripts?.[id]);
      const plan = scripts.length ? scripts : (paths.some(p => /\.test\.m?js$/.test(p)) ? ['node-test'] : []);
      const router = createRouter({ env, fetchImpl, store, timeoutMs: 90000 });
      const cache = join(workdir, '.npm-cache');
      let feedback = null, best = null;
      if (pkg && !(await readdir(root)).includes('package-lock.json')) note('No package-lock.json: dependencies are not installed.');
      if (pkg && (await readdir(root)).includes('package-lock.json')) {
        const install = await runCommand(...commandFor('install', pkg), { cwd: root, timeoutMs: Math.min(commandMs * 2, deadline - Date.now()), cacheDir: cache });
        task.install = { code: install.code, ms: install.ms, tail: install.output.slice(-1500) };
        note('npm ci --ignore-scripts exited ' + install.code + '.');
      }
      for (let attempt = 1; attempt <= maxAttempts && Date.now() < deadline - 60000; attempt++) {
        const current = await createDev({ store, env }).get(task.id);
        if (current?.status === 'cancelled') { task.status = 'cancelled'; note('Cancelled by the operator.'); return task; }
        const context = {
          objective: task.objective, repo: task.repo, attempt, rule: UNTRUSTED_RULE,
          files: Object.fromEntries(picked.map(p => [p, original.get(p)])), otherPaths: list.filter(p => !picked.includes(p)).slice(0, 300),
          evidence: '<evidence>' + JSON.stringify({ docs: docs.results.map(d => ({ path: d.path, text: d.text })), memory: memories.map(m => m.kind + ': ' + m.text),
            web: (webDocs?.findings || []).slice(0, 4).map(f => ({ url: f.url, text: f.text })) }) + '</evidence>',
          commands: plan, previousFailure: feedback,
        };
        let proposal;
        try {
          const { output, model } = await router.call(attempt > 1 ? 'debugging' : 'coding',
            'You are a senior engineer working in an isolated copy of a repository. Make the smallest change that meets the objective and keeps existing behavior. ' +
            'Find the root cause before editing. Return JSON {"rootCause": string, "summary": string, "edits": [{"path": string, "search": string, "replace": string} or {"path": string, "content": string}], "tests": string}. ' +
            'search must match the current file text exactly once. Use content only for new files. Do not edit lockfiles, secrets or CI config. If the objective cannot be met, return edits [] and explain.',
            context, { structured: true });
          proposal = output; task.model = model;
        } catch (error) { note('Model call failed: ' + error.message); task.attempts.push({ attempt, error: clip(error.message, 300) }); break; }
        const { changed, errors } = applyEdits(original, proposal?.edits);
        if (!changed.size) { task.attempts.push({ attempt, summary: clip(proposal?.summary || '', 600), errors }); feedback = 'No applicable edits. ' + errors.join(' '); note('Attempt ' + attempt + ': no applicable edits.'); continue; }
        // Fresh files for each attempt: restore originals, then write this attempt's edits.
        if (best) for (const p of best.changed.keys()) {
          const { abs } = await safePath(root, p);
          if (original.has(p)) await writeFile(abs, original.get(p)); else await rm(abs, { force: true });
        }
        for (const [p, text] of changed) { const { abs } = await safePath(root, p); await mkdir(dirname(abs), { recursive: true }); await writeFile(abs, text); }
        const results = [];
        for (const id of plan) {
          if (Date.now() > deadline - 30000) { results.push({ command: id, code: null, output: 'skipped: task time budget reached' }); break; }
          const [cmd, args] = commandFor(id, pkg);
          const run = await runCommand(cmd, args, { cwd: root, timeoutMs: Math.min(commandMs, deadline - Date.now()), cacheDir: cache });
          results.push({ command: [cmd, ...args].join(' '), code: run.code, ms: run.ms, output: run.output.slice(-2500) });
          if (run.code !== 0) break;
        }
        const passed = results.length > 0 && results.every(r => r.code === 0);
        task.attempts.push({ attempt, rootCause: clip(proposal.rootCause || '', 600), summary: clip(proposal.summary || '', 800), files: [...changed.keys()], errors,
          results: results.map(r => ({ command: r.command, code: r.code, ms: r.ms, tail: r.output.slice(-1200) })), passed });
        best = { changed, passed, proposal };
        note('Attempt ' + attempt + ': ' + changed.size + ' files changed, ' + (plan.length ? (passed ? 'all checks passed.' : 'checks failed.') : 'no test command found.'));
        if (passed || !plan.length) break;
        const failed = results.find(r => r.code !== 0);
        feedback = 'Command "' + failed.command + '" exited ' + failed.code + '. Output tail:\n' + failed.output.slice(-3000);
      }
      if (!best) { task.status = 'failed'; task.error = 'No usable change was produced.'; return task; }
      const patch = [...best.changed].map(([p, text]) => unifiedDiff(p, original.get(p) ?? null, text)).join('\n');
      const archive = zip([...best.changed].map(([p, text]) => ({ path: p, content: text })));
      if (archive.length <= 2 * 1048576) await store.setJSON(devArtifactKey(task.id), { zipBase64: archive.toString('base64'), patch: patch.slice(0, 400000), files: [...best.changed.keys()], createdAt: new Date().toISOString() });
      await writeFile(join(workdir, task.id, 'patch.zip'), archive);
      Object.assign(task, { status: best.passed ? 'validated' : plan.length ? 'failed-checks' : 'unvalidated', files: [...best.changed.keys()], summary: clip(best.proposal?.summary || '', 1000),
        rootCause: clip(best.proposal?.rootCause || '', 800), artifactBytes: archive.length, deployed: false });
      await facts.add({ kind: best.passed ? 'fix' : 'outcome', text: 'Dev task on ' + task.repo + ': ' + clip(task.objective, 200) + ' => ' + task.status + '. ' + clip(task.summary, 300), tags: ['dev'] }, { scope: 'lcp', by: 'dev-runner' }).catch(() => {});
      return task;
    } catch (error) {
      task.status = 'failed'; task.error = clip(redact(error.message), 400); note('Failed: ' + task.error);
      return task;
    } finally {
      task.finishedAt = new Date().toISOString();
      await rm(root, { recursive: true, force: true }).catch(() => {}); // the patch.zip stays next to it
      await dev.save(task).catch(error => log('dev task save failed', error.message));
      await audit(store, { actor: 'dev-runner', action: 'dev.run', target: task.id, result: task.status, detail: { repo: task.repo, files: task.files || [] } });
    }
  }

  // One claim per tick. Returns the finished task or null.
  async function tick() {
    if (busy) return null;
    busy = true;
    try {
      const store = await openStore();
      const task = await createDev({ store, env }).claim('vm');
      if (!task) return null;
      log('dev task', task.id, task.repo);
      return await runTask(task, store);
    } finally { busy = false; }
  }
  return { tick, runTask };
}
