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
const { openJarvisStore } = await import('../netlify/functions/lib/jarvis-store.mjs');
const { runAlertCheck } = await import('../netlify/functions/lib/alerts.mjs');
const { mailSettings, syncMailbox } = await import('../netlify/functions/lib/jarvis-mail.mjs');
const { postBriefing } = await import('../netlify/functions/lib/slack.mjs');
const { createJarvisHandler } = await import('../netlify/functions/jarvis.mjs');
const mcp = (await import('../netlify/functions/mcp.mjs')).default;

// JARVIS storage: Supabase when set (shared with Netlify), else the container volume.
const supabase = Boolean(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim());
const localJarvis = supabase ? null : localKeyedStore(join(dataDir, 'jarvis'));
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
const lastRun = {};
async function run(name, now = Date.now()) {
  const started = Date.now();
  try {
    if (!dryRun && !(await claimRun(name, { now, env, by: 'vm' }))) { lastRun[name] = { at: new Date(now).toISOString(), result: 'skipped: slot already ran' }; return; }
    const result = await jobs[name]();
    lastRun[name] = { at: new Date(now).toISOString(), ms: Date.now() - started, result };
    if (dryRun || result?.sent || result?.error || result?.posted || result?.messages !== undefined) console.log(name, JSON.stringify(result));
  } catch (error) {
    lastRun[name] = { at: new Date(now).toISOString(), error: error.message };
    console.log(name + ' failed', error.message);
  }
}

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
      storage: supabase ? 'supabase' : 'local', data: env.DATA_MODE === 'sample' ? 'sample' : 'live', lastRun,
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
  for (const name of dueJobs(now)) {
    if (busy.has(name)) continue;
    busy.add(name);
    run(name, now).finally(() => busy.delete(name));
  }
  ticker = setTimeout(tick, 60000 - (Date.now() % 60000) + 500);
}

const port = Number(env.PORT || 8080);
server.listen(port, env.HOST || '0.0.0.0', async () => {
  const mode = dryRun ? 'dry-run' : schedulesOn(env) === 'vm' ? 'on' : 'off';
  console.log('LCP MCP server on port ' + port + ' · schedules ' + mode + ' · storage ' + (supabase ? 'supabase' : 'local disk') + ' · data ' + (env.DATA_MODE === 'sample' ? 'sample' : 'live'));
  if (dryRun) {
    for (const name of Object.keys(jobs)) await run(name);
    console.log('[dry-run] done. Each job fired once. Blocked calls: ' + (dryRunLog.join(', ') || 'none') + '. No timers started.');
  } else if (mode === 'on') {
    ticker = setTimeout(tick, 60000 - (Date.now() % 60000) + 500);
  }
});
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    clearTimeout(ticker);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}
