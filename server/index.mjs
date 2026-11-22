// LCP MCP server for the Docker container on the Google Cloud e2-micro VM. Ported from the A2Z server pattern.
// Netlify keeps the dashboard, Studio, JARVIS, voice and Slack events. This server runs:
//   /mcp     the same read-only MCP handler as Netlify (Authorization: Bearer <MCP_AUTH_TOKEN>)
//   /health  no key, for the Docker healthcheck
//   timers   alerts (every 5 min, 9am to 9pm Pacific), mail sync (every 30 min), Slack briefing (weekdays 7:05 Pacific),
//            only when RUN_SCHEDULES_ON=vm. Set the same value on Netlify so its scheduled functions exit.
// The compose file binds the port to 127.0.0.1. Reach /mcp through an SSH tunnel.
//
// Env: MCP_AUTH_TOKEN (required, 16+ characters). DATA_DIR (default /data). PORT (default 8080), HOST (default 0.0.0.0 inside the container).
//      SCHEDULER_DRY_RUN=1 fires each job once at startup with Slack, Groq, Gemini and Workers AI calls blocked, then starts no timers.
// Intel (optional): JARVIS storage is SQLite on the volume (DATA_DIR/jarvis.sqlite) unless Supabase is set.
//      INTEL_WORKER_ON=vm runs queued deep research tasks here (every minute). INTEL_REPOS are re-indexed daily at 3:10 Pacific.
//      DEV_RUNNER=1 runs the sandboxed dev runner (server/dev-runner.mjs) for DEV_REPOS. SLACK_APP_TOKEN starts Slack Socket Mode.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';

const env = process.env;
const token = env.MCP_AUTH_TOKEN?.trim() || '';
if (token.length < 16) {
  console.error('MCP_AUTH_TOKEN is missing or shorter than 16 characters. Set it in .env. Generate one with: openssl rand -hex 32');
  process.exit(1);
}
// The existing /mcp handler checks MCP_KEY. This server uses MCP_AUTH_TOKEN as that key so there is one MCP secret.
env.MCP_KEY = token;
if (!env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_KEY) env.SUPABASE_SERVICE_ROLE_KEY = env.SUPABASE_KEY;
// The VM has no request deadline, so model calls may take longer than on Netlify (7 s there).
env.MODEL_TIMEOUT_MS ||= '20000';
const dataDir = env.DATA_DIR || '/data';
const dryRun = env.SCHEDULER_DRY_RUN === '1';

// Dry run: block every write to Slack and every model call before any module captures fetch.
const blocked = /(^|\.)(slack\.com|api\.groq\.com|generativelanguage\.googleapis\.com|api\.cloudflare\.com|openrouter\.ai)$/;
const dryRunLog = [];
if (dryRun) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    const webhook = env.ALERT_WEBHOOK_URL && url.href === new URL(env.ALERT_WEBHOOK_URL).href;
    if (!webhook && !blocked.test(url.hostname)) return realFetch(input, init);
    dryRunLog.push((init.method || 'GET') + ' ' + url.hostname);
    console.log('[dry-run] blocked', init.method || 'GET', url.hostname + url.pathname.replace(/\/services\/.+$/, '/services/***'));
    if (url.hostname.endsWith('slack.com')) return Response.json({ ok: true, ts: '0.0' });
    if (webhook) return new Response('ok');
    return Response.json({ choices: [{ message: { content: 'Dry run: no model call was made.' } }], usage: { total_tokens: 0 } });
  };
}

const { schedulesOn, dueJobs, claimRun } = await import('../netlify/functions/lib/schedules.mjs');
const { localKeyedStore } = await import('../netlify/functions/lib/local-store.mjs');
const { sqliteKeyedStore } = await import('../netlify/functions/lib/intel/sqlite-store.mjs');
const { createIntelWorker } = await import('../netlify/functions/intel-worker-background.mjs');
const { createDevRunner } = await import('./dev-runner.mjs');
const { startSlackSocket } = await import('./slack-socket.mjs');
const { openJarvisStore } = await import('../netlify/functions/lib/jarvis-store.mjs');
const { runAlertCheck } = await import('../netlify/functions/lib/alerts.mjs');
const { mailSettings, syncMailbox } = await import('../netlify/functions/lib/jarvis-mail.mjs');
const { postBriefing } = await import('../netlify/functions/lib/slack.mjs');
const { createJarvisHandler } = await import('../netlify/functions/jarvis.mjs');
const mcp = (await import('../netlify/functions/mcp.mjs')).default;

// JARVIS storage: Supabase when set (shared with Netlify), else the container volume.
const supabase = Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim());
// SQLite on the persistent volume (durable across restarts). Netlify never uses this: its filesystem is not durable.
const localJarvis = supabase ? null : await sqliteKeyedStore(join(dataDir, 'jarvis.sqlite'));
// One-time import of the older file store (DATA_DIR/jarvis/*.json) into SQLite, so chats and snapshots survive the upgrade.
if (localJarvis && !(await localJarvis.getWithMetadata('migrated/file-store'))) {
  const { readdirSync, readFileSync, existsSync } = await import('node:fs');
  const dir = join(dataDir, 'jarvis');
  let imported = 0;
  if (existsSync(dir)) for (const name of readdirSync(dir).filter(n => n.endsWith('.json'))) {
    try {
      const entry = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      const key = name.slice(0, -5).replaceAll('__', '/');
      if (entry && 'data' in entry && (await localJarvis.setJSON(key, entry.data, { onlyIfNew: true })).modified) imported++;
    } catch { /* skip unreadable files */ }
  }
  await localJarvis.setJSON('migrated/file-store', { at: new Date().toISOString(), imported });
  if (imported) console.log('Imported ' + imported + ' JARVIS records from the file store into SQLite.');
}
const openStore = async () => (supabase ? openJarvisStore(env) : localJarvis);
// Alert state (cooldowns and baseline) on the volume so a restart does not repost.
const alertFiles = localKeyedStore(join(dataDir, 'alerts'));
const alertStore = {
  async get(key) { return (await alertFiles.getWithMetadata(key))?.data ?? null; },
  async setJSON(key, value) { await alertFiles.setJSON(key, value, {}); },
};

const jobs = {
  'alerts-scheduled': async () => runAlertCheck({ store: alertStore, force: dryRun }),
  'jarvis-mail-sync': async () => {
    if (!mailSettings(env).enabled) return { skipped: 'mail not configured' };
    const snapshot = await syncMailbox({ env, store: await openStore() });
    return { messages: snapshot.messages.length };
  },
  'slack-briefing': async () => postBriefing({ env, jarvis: createJarvisHandler({ env, openStore }) }),
};
const intelWorker = createIntelWorker({ env, openStore });
const devRunner = env.DEV_RUNNER === '1' ? createDevRunner({ env, openStore }) : null;
const extraJobs = {
  'intel-worker': async () => (await intelWorker({ taskId: null, queued: true })) ? { ran: 1 } : { idle: true },
  'knowledge-sync': async () => {
    const repos = String(env.INTEL_REPOS || '').split(',').map(s => s.trim()).filter(Boolean);
    const reports = [];
    for (const repo of repos) { try { reports.push(await intelWorker({ sync: { repo, scope: 'lcp' } })); } catch (error) { reports.push({ repo, error: error.message }); } }
    return { repos: reports.map(r => ({ repo: r?.repo, indexed: r?.indexed, unchanged: r?.unchanged, pruned: r?.pruned, failed: r?.failed?.length ?? r?.error })) };
  },
  'dev-runner': async () => { const task = await devRunner.tick(); return task ? { task: task.id, status: task.status } : { idle: true }; },
};
Object.assign(jobs, extraJobs);
// Extra VM timetable (not shared with Netlify, so no lease needed): worker and dev runner every minute, repo sync daily.
function extraDue(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  const due = [];
  if (env.INTEL_WORKER_ON === 'vm') due.push('intel-worker');
  if (devRunner) due.push('dev-runner');
  if (env.INTEL_REPOS?.trim() && p.hour === 3 && p.minute === 10) due.push('knowledge-sync');
  return due;
}
const lastRun = {};
async function run(name, now = Date.now()) {
  const started = Date.now();
  try {
    if (!dryRun && !extraJobs[name] && !(await claimRun(name, { now, env, by: 'vm' }))) { lastRun[name] = { at: new Date(now).toISOString(), result: 'skipped: slot already ran' }; return; }
    const result = await jobs[name]();
    lastRun[name] = { at: new Date(now).toISOString(), ms: Date.now() - started, result };
    if (dryRun || result?.sent || result?.error || result?.posted || result?.messages !== undefined) console.log(name, JSON.stringify(result));
  } catch (error) {
    lastRun[name] = { at: new Date(now).toISOString(), error: error.message };
    console.log(name + ' failed', error.message);
  }
}

// Slack Socket Mode (optional). Off in dry run so nothing reaches Slack.
const slack = dryRun ? { status: () => 'off (dry run)', stop: () => {} } : startSlackSocket({ env, openStore, jarvis: createJarvisHandler({ env, openStore }) });
const started = Date.now();
const digest = value => createHash('sha256').update(value).digest();
const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(body); };

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  if (url.pathname === '/health') {
    if (!['GET', 'HEAD'].includes(req.method)) return send(res, 405, '', { Allow: 'GET, HEAD' });
    return send(res, 200, req.method === 'HEAD' ? '' : JSON.stringify({
      status: 'ok', service: 'lcp-mcp', uptimeSeconds: Math.round((Date.now() - started) / 1000), time: new Date().toISOString(),
      schedules: dryRun ? 'dry-run' : schedulesOn(env) === 'vm' ? 'vm' : 'off (RUN_SCHEDULES_ON is not vm)',
      storage: supabase ? 'supabase' : 'sqlite', data: env.DATA_MODE === 'sample' ? 'sample' : 'live', lastRun,
      intel: { worker: env.INTEL_WORKER_ON === 'vm' ? 'on' : 'off', devRunner: devRunner ? 'on' : 'off', slackSocket: slack.status() },
    }), { 'Content-Type': 'application/json' });
  }
  if (url.pathname !== '/mcp') return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  const auth = /^Bearer (.+)$/i.exec(req.headers.authorization || '')?.[1] || '';
  if (!timingSafeEqual(digest(auth), digest(token))) return send(res, 401, JSON.stringify({ error: 'Unauthorized' }), { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' });
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : await readBody(req, 65536);
  if (body === null) return send(res, 413, JSON.stringify({ error: 'Request body exceeds the size limit.' }), { 'Content-Type': 'application/json' });
  const response = await mcp(new Request(url, { method: req.method, headers: req.headers, body }));
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()));
}

const server = http.createServer((req, res) => {
  const begin = Date.now();
  handle(req, res).catch(error => {
    console.error('Request failed', req.method, req.url.split('?')[0], error.message);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'Server error' }), { 'Content-Type': 'application/json' });
    else res.end();
  }).finally(() => {
    // Paths only. No query strings, headers or bodies in logs.
    if (req.url !== '/health') console.log(new Date().toISOString(), req.method, req.url.split('?')[0], res.statusCode, Date.now() - begin + 'ms');
  });
});
server.requestTimeout = 60000;
server.headersTimeout = 20000;

// Minute ticker aligned to the clock. Each due job runs once per slot; a job still running is not started again.
let ticker = null;
const busy = new Set();
function tick() {
  const now = Date.now();
  for (const name of [...(schedulesOn(env) === 'vm' ? dueJobs(now) : []), ...extraDue(now)]) {
    if (busy.has(name)) continue;
    busy.add(name);
    run(name, now).finally(() => busy.delete(name));
  }
  ticker = setTimeout(tick, 60000 - (Date.now() % 60000) + 500);
}

const port = Number(env.PORT || 8080);
server.listen(port, env.HOST || '0.0.0.0', async () => {
  const mode = dryRun ? 'dry-run' : schedulesOn(env) === 'vm' ? 'on' : 'off';
  console.log('LCP MCP server on port ' + port + ' · schedules ' + mode + ' · storage ' + (supabase ? 'supabase' : 'sqlite') + ' · data ' + (env.DATA_MODE === 'sample' ? 'sample' : 'live'));
  if (dryRun) {
    for (const name of Object.keys(jobs).filter(name => !extraJobs[name])) await run(name);
    console.log('[dry-run] done. Each job fired once. Blocked calls: ' + (dryRunLog.join(', ') || 'none') + '. No timers started.');
  } else if (mode === 'on' || extraDue(Date.now() - (Date.now() % 60000) + 1).length || devRunner || env.INTEL_WORKER_ON === 'vm') {
    ticker = setTimeout(tick, 60000 - (Date.now() % 60000) + 500);
  }
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearTimeout(ticker);
    slack.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
