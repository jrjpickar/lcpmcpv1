// JARVIS in Slack: one bot user ("JARVIS") you can DM or @mention. Everything runs through the same JARVIS
// handlers as the dashboard, so lessons, company memory, bots, delegation, Gemini and plans are shared.
// Env: SLACK_BOT_TOKEN (xoxb-), SLACK_SIGNING_SECRET, SLACK_ALLOWED_USERS (comma list of Slack member IDs, required),
// SLACK_BRIEFING_CHANNEL (optional channel ID for the weekday briefing). LCP_STUDIO_KEY must be set (internal calls use it).
// Ported from A2Z. Separate from the Slack alert webhook (ALERT_WEBHOOK_URL), which keeps working on its own.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createJarvisHandler } from '../jarvis.mjs';
import { createJarvisMemoryHandler } from '../jarvis-memory.mjs';
import { createExecuteHandler } from '../jarvis-execute.mjs';
import { openJarvisStore } from './jarvis-store.mjs';

const fail = message => Object.assign(new Error(message), { slack: true });
const safeEqual = (a, b) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

export function slackSettings(env = process.env) {
  const token = env.SLACK_BOT_TOKEN?.trim(), secret = env.SLACK_SIGNING_SECRET?.trim();
  const allowed = (env.SLACK_ALLOWED_USERS || '').split(/[\s,]+/).map(id => id.trim()).filter(id => /^[UW][A-Z0-9]{2,20}$/.test(id));
  return { token, secret, allowed, briefingChannel: env.SLACK_BRIEFING_CHANNEL?.trim() || '', ready: Boolean(token && secret && allowed.length) };
}

// Slack request signing v0. Rejects requests older than 5 minutes (replay protection).
export function verifySlack(headers, body, secret, now = Date.now()) {
  const stamp = headers.get('x-slack-request-timestamp') || '', signature = headers.get('x-slack-signature') || '';
  if (!secret || !/^\d+$/.test(stamp) || Math.abs(now / 1000 - Number(stamp)) > 300) return false;
  const expected = 'v0=' + createHmac('sha256', secret).update('v0:' + stamp + ':' + body).digest('hex');
  return safeEqual(expected, signature);
}
// The events endpoint hands work to the background worker with this signature (no extra secret to manage).
export const workerSignature = (secret, body) => createHmac('sha256', secret).update('lcp-slack-worker:' + body).digest('hex');
export const verifyWorker = (secret, body, signature) => Boolean(secret) && safeEqual(workerSignature(secret, body), String(signature || ''));

export async function slackApi(token, method, payload, fetchImpl = fetch) {
  const response = await fetchImpl('https://slack.com/api/' + method, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!data.ok && !['already_reacted', 'no_reaction'].includes(data.error)) throw fail('Slack ' + method + ' failed: ' + (data.error || response.status));
  return data;
}

// Markdown from the agents to Slack mrkdwn.
export function toSlack(text) {
  return String(text || '').replace(/\*\*(.+?)\*\*/g, '*$1*').replace(/^#{1,6}\s+(.+)$/gm, '*$1*').replace(/^\s*[-*]\s+/gm, '• ').slice(0, 3900);
}

const AGENT_PREFIX = { jarvis: 'main', main: 'main', email: 'email', mail: 'email', systems: 'systems', kpi: 'systems', kpis: 'systems',
  market: 'market', news: 'market', dev: 'build', build: 'build', data: 'data', sql: 'data', qc: 'qc',
  gemini: 'gemini', cloudflare: 'cloudflare', workers: 'cloudflare', 'workers ai': 'cloudflare', llama: 'cloudflare' };
export const HELP = [
  '*JARVIS in Slack*',
  '• Just ask. JARVIS hands it to the right agent.',
  '• Talk to one agent: `systems:`, `market:`, `email:`, `dev:`, `data:`, `qc:`, `gemini:`, `workers:` or a bot name, then your message.',
  '• Teach: `remember: ...` (this agent) or `remember for all agents: ...` (company memory).',
  '• React :+1: or :-1: on a reply to rate it. JARVIS learns from it.',
  '• `run plan` runs the last Data sandbox plan on a throwaway copy. Nothing touches production.',
  '• `new chat` starts fresh. `help` shows this.',
].join('\n');

// "systems: how are dials?" -> { role: 'systems', prompt: 'how are dials?' }. Leaves "remember:" alone.
export function parseMessage(text, bots = []) {
  const clean = String(text || '').replace(/<@[A-Z0-9]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
  const lower = clean.toLowerCase();
  if (/^(help|\?)$/.test(lower)) return { command: 'help' };
  if (/^(new chat|reset|start over)$/.test(lower)) return { command: 'new' };
  if (/^run (the )?plan$/.test(lower)) return { command: 'run' };
  const match = /^([a-z][a-z0-9 -]{1,40}?)\s*:\s*([\s\S]+)$/i.exec(clean);
  if (match) {
    const key = match[1].trim().toLowerCase();
    if (AGENT_PREFIX[key]) return { role: AGENT_PREFIX[key], prompt: match[2].trim() };
    const bot = bots.find(item => item.name.toLowerCase() === key || item.id === key);
    if (bot) return { role: bot.id, prompt: match[2].trim() };
  }
  return { role: 'main', prompt: clean };
}

// Internal calls into the JARVIS handlers, authenticated with the Studio key like the dashboard JARVIS panel.
function internal(env, path, body, method = 'POST') {
  const origin = 'https://jarvis.internal';
  return new Request(origin + path, { method, headers: { origin, 'content-type': 'application/json', 'x-lcp-studio-key': env.LCP_STUDIO_KEY || '' }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}) });
}
const FILTERS = { preset: 'mtd' };
async function callHandler(handler, request) {
  const response = await handler(request);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw fail(data.error || 'JARVIS request failed (HTTP ' + response.status + ').');
  return data;
}

export function createSlackWorker({ env = process.env, fetchImpl = fetch, openStore = () => openJarvisStore(env),
  jarvis = createJarvisHandler({ env, fetchImpl, openStore }), memory = createJarvisMemoryHandler({ env, fetchImpl, openStore }), execute = createExecuteHandler({ env, openStore }) } = {}) {
  const { token, allowed } = slackSettings(env);
  const api = (method, payload) => slackApi(token, method, payload, fetchImpl);
  const keyFor = (...parts) => 'slack/' + createHash('sha256').update(parts.join(':')).digest('hex').slice(0, 32);
  const readJSON = async (store, key, fallback) => (await store.getWithMetadata(key))?.data ?? fallback;

  async function handleMessage(event) {
    const store = await openStore();
    const dm = event.channel_type === 'im';
    const thread = dm ? null : event.thread_ts || event.ts;
    const convKey = keyFor('conv', event.channel, thread || 'dm');
    const conv = await readJSON(store, convKey, { threads: {}, plan: null });
    const say = text => api('chat.postMessage', { channel: event.channel, text: toSlack(text), ...(thread ? { thread_ts: thread } : {}), unfurl_links: false });
    let bots = [];
    try { bots = (await callHandler(memory, internal(env, '/api/jarvis-memory?role=main', null, 'GET'))).bots || []; } catch { /* bots are optional */ }
    const parsed = parseMessage(event.text, bots);
    if (parsed.command === 'help' || (!parsed.command && !parsed.prompt)) return say(HELP);
    if (parsed.command === 'new') { await store.setJSON(convKey, { threads: {}, plan: null }); return say('Fresh start. Ask me anything.'); }
    if (parsed.command === 'run') {
      if (!conv.plan) return say('No plan to run yet. Ask `data:` for a sandbox plan first.');
      const result = await callHandler(execute, internal(env, '/api/jarvis-execute', { action: 'run', plan: conv.plan.plan, planHash: conv.plan.planHash, filters: FILTERS }));
      const checks = result.checks || [];
      return say('*Sandbox ' + result.outcome + '.* ' + checks.filter(c => c.ok).length + ' of ' + checks.length + ' checks passed. Applied to production: no.'
        + (result.error ? '\n' + result.error : '') + checks.filter(c => !c.ok).map(c => '\n• ' + c.check + ': ' + c.detail).join(''));
    }
    await api('reactions.add', { channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {});
    const body = { role: parsed.role, prompt: parsed.prompt.slice(0, 1000), ...(['market', 'qc', 'email'].includes(parsed.role) ? {} : { filters: FILTERS }) };
    const threadId = conv.threads[parsed.role];
    if (threadId) body.threadId = threadId; else body.newThread = true;
    let data;
    try {
      try { data = await callHandler(jarvis, internal(env, '/api/jarvis', body)); }
      catch (error) {
        if (!threadId || !/Chat not found/.test(error.message)) throw error;
        delete body.threadId; body.newThread = true;
        data = await callHandler(jarvis, internal(env, '/api/jarvis', body));
      }
    } catch (error) {
      await api('reactions.remove', { channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {});
      return say(':warning: ' + error.message);
    }
    if (data.threadId) conv.threads[parsed.role] = data.threadId;
    if (data.plan && data.planHash) conv.plan = { plan: data.plan, planHash: data.planHash };
    await store.setJSON(convKey, conv);
    const via = (data.trace || []).filter(id => id !== parsed.role && id !== 'execute');
    const names = { main: 'JARVIS', email: 'Email', systems: 'Systems', market: 'Market news', build: 'Build developer', data: 'Data sandbox', qc: 'QC', gemini: 'Gemini', cloudflare: 'Workers AI' };
    const footer = [via.length ? '_via ' + via.map(id => names[id] || bots.find(b => b.id === id)?.name || id).join(' > ') + '_' : '',
      data.plan && data.planHash ? '_Plan ready. QC ' + (data.approved ? 'approved' : 'did not approve') + ' it. Reply `run plan` to test it in the sandbox._' : ''].filter(Boolean).join('\n');
    const posted = await say((data.answer || 'No answer.') + (footer ? '\n\n' + footer : ''));
    await api('reactions.remove', { channel: event.channel, timestamp: event.ts, name: 'eyes' }).catch(() => {});
    if (posted?.ts && data.messageId && data.threadId) {
      await store.setJSON(keyFor('msg', event.channel, posted.ts), { role: parsed.role, threadId: data.threadId, messageId: data.messageId });
    }
  }

  async function handleReaction(event) {
    const rating = /^(\+1|thumbsup)(::skin-tone-\d)?$/.test(event.reaction) ? 1 : /^(-1|thumbsdown)(::skin-tone-\d)?$/.test(event.reaction) ? -1 : 0;
    if (!rating || event.item?.type !== 'message') return;
    const store = await openStore();
    const link = await readJSON(store, keyFor('msg', event.item.channel, event.item.ts), null);
    if (!link) return;
    await callHandler(memory, internal(env, '/api/jarvis-memory', { role: link.role, action: 'feedback', threadId: link.threadId, messageId: link.messageId, rating }));
    await api('reactions.add', { channel: event.item.channel, timestamp: event.item.ts, name: rating > 0 ? 'brain' : 'memo' }).catch(() => {});
  }

  return async function work(event) {
    if (!token || !event) return;
    if (!allowed.includes(event.user)) return; // Only the people listed in SLACK_ALLOWED_USERS can use JARVIS.
    if (event.type === 'reaction_added') return handleReaction(event);
    if (event.type === 'app_mention' || (event.type === 'message' && event.channel_type === 'im' && !event.subtype && !event.bot_id)) return handleMessage(event);
  };
}

// Weekday briefing into SLACK_BRIEFING_CHANNEL.
export async function postBriefing({ env = process.env, fetchImpl = fetch, jarvis = createJarvisHandler({ env, fetchImpl }) } = {}) {
  const { token, briefingChannel } = slackSettings(env);
  if (!token || !briefingChannel) return { skipped: true };
  const data = await callHandler(jarvis, internal(env, '/api/jarvis', { role: 'systems', filters: { preset: 'yesterday' },
    prompt: 'Morning briefing for Slack on yesterday. One short line each for: headline, dials and connect rate, texts, opportunities, qualified sellers, speed to lead, hot replies waiting, fees and pending, data source health. Then the top 3 actions for today. Use numbers.' }));
  await slackApi(token, 'chat.postMessage', { channel: briefingChannel, text: toSlack(':sunrise: *LocalCare Props morning briefing*\n' + (data.answer || '')), unfurl_links: false }, fetchImpl);
  return { posted: true };
}
