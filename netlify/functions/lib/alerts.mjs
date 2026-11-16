// Server-side alert check. No Groq, no browser: rules from lcp-metrics.js, state in Netlify Blobs, post to Slack.
//
// Frugal by design:
//  - runs every 5 min, 9am to 9pm Pacific (the cron covers both PDT and PST; outside hours it exits before any request)
//  - each run reads only today + yesterday (dialer export, GHL SMS, GHL inbound calls)
//  - 7-day caller ID rates, 7-day opt-out rate and 8-week list decay are built once a day and cached in Blobs
//  - every alert has a key; Slack gets it once (hot replies: once per reply), cooldown ALERT_COOLDOWN_MIN for the rest
import { getStore } from '@netlify/blobs';
import Metrics from '../../../public/lcp-metrics.js';
import { loadAlertData, loadBaselineData, mode } from './sources.mjs';

const STATE_KEY = 'alerts/state', BASE_KEY = 'alerts/baseline';
const envNum = (name, fallback) => { const n = Number(process.env[name]); return Number.isFinite(n) && n > 0 ? n : fallback; };

export function alertConfig() {
  return {
    replyWaitMinutes: envNum('ALERT_REPLY_WAIT_MIN', 15), hotSlaHours: envNum('ALERT_HOT_SLA_HOURS', 24), warmSlaHours: envNum('ALERT_WARM_SLA_HOURS', 72),
    callerIdDrop: envNum('ALERT_CALLER_ID_DROP', 0.4), callerIdMinDials: envNum('ALERT_CALLER_ID_MIN_DIALS', 20), callerIdMinBaseline: 100,
    stuckDays: envNum('STUCK_DAYS', 14), optOutSpike: envNum('ALERT_OPT_OUT_SPIKE', 2), optOutMin: 5, overdueMin: envNum('ALERT_OVERDUE_MIN', 3),
  };
}

// 9:00 to 20:59 Pacific, DST aware.
export function withinHours(now = Date.now(), start = envNum('ALERT_START_HOUR', 9), end = envNum('ALERT_END_HOUR', 21)) {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now))) % 24;
  return h >= start && h < end;
}

function memoryStore() {
  const m = new Map();
  return { async get(k) { return m.has(k) ? JSON.parse(m.get(k)) : null; }, async setJSON(k, v) { m.set(k, JSON.stringify(v)); } };
}
let fallbackStore = null;
export function alertStore() {
  try { return getStore({ name: 'lcp-mcp', consistency: 'strong' }); } catch { return (fallbackStore ||= memoryStore()); }
}

export function buildBaseline(data, now = Date.now()) {
  const today = Metrics.dayKey(now), cfg = alertConfig();
  const from = Metrics.shiftDay(today, -7), to = Metrics.shiftDay(today, -1);
  const callerIds = {};
  for (const c of data.calls || []) {
    if (!c.callerId) continue;
    const d = Metrics.dayKey(c.at); if (d < from || d > to) continue;
    const b = callerIds[c.callerId] ||= { dials: 0, connected: 0 }; b.dials++; if (c.connected) b.connected++;
  }
  const sig = Metrics.signalsSection(data, { tz: Metrics.TZ, from, to, now, cfg, repOk: () => true, qualifiedContacts: {}, qualifying: /acq|retail/i });
  return { day: today, builtAt: new Date(now).toISOString(), callerIds, optOutRate: sig.replyQuality.optOutRate, lists: sig.lists.map(({ weekly, ...l }) => l) };
}

export async function currentAlerts({ now = Date.now(), store = alertStore(), fetchImpl = fetch } = {}) {
  const today = Metrics.dayKey(now), cfg = alertConfig();
  let baseline = await store.get(BASE_KEY, { type: 'json' }).catch(() => null);
  if (!baseline || baseline.day !== today) {
    baseline = buildBaseline(await loadBaselineData({ now, fetchImpl }), now);
    await store.setJSON(BASE_KEY, baseline).catch(e => console.error('Baseline cache write failed', e));
  }
  const data = await loadAlertData({ now, fetchImpl });
  const sig = Metrics.signalsSection(data, { tz: Metrics.TZ, from: today, to: today, now, cfg, repOk: () => true, qualifiedContacts: {}, qualifying: /acq|retail/i, baseline: { callerIds: baseline.callerIds } });
  sig.lists = (baseline.lists || []).map(l => ({ ...l, weekly: [] }));
  return { alerts: Metrics.alertsFrom(sig, { cfg, today, baselineOptOut: baseline.optOutRate }), baseline };
}

const contactUrl = id => process.env.GHL_LOCATION_ID ? `${(process.env.GHL_APP_URL || 'https://app.gohighlevel.com').replace(/\/+$/, '')}/v2/location/${process.env.GHL_LOCATION_ID}/contacts/detail/${encodeURIComponent(id)}` : null;
const clean = s => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])).replace(/[–—]/g, '-');

export function slackMessage(alerts, now = Date.now()) {
  const time = new Date(now).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' });
  const icon = { high: ':red_circle:', medium: ':large_orange_circle:', low: ':white_circle:' };
  const lines = [`*LCP alerts* · ${time}${process.env.DASHBOARD_URL ? ` · <${process.env.DASHBOARD_URL}|Open dashboard>` : ''}`];
  for (const a of alerts) {
    lines.push(`${icon[a.severity] || ''} *${clean(a.title)}*: ${clean(a.detail)}`);
    for (const it of a.items || []) {
      const url = contactUrl(it.contactId), who = url ? `<${url}|${it.call ? 'Inbound call' : 'Reply'}>` : (it.call ? 'Inbound call' : 'Reply');
      lines.push(`      ${who} · ${it.waitMinutes >= 120 ? Math.round(it.waitMinutes / 6) / 10 + ' h' : it.waitMinutes + ' min'}${it.snippet ? ` · "${clean(it.snippet).slice(0, 80)}"` : ''}`);
    }
  }
  return { text: lines.join('\n') };
}

export async function postSlack(body, fetchImpl = fetch) {
  const url = process.env.ALERT_WEBHOOK_URL;
  if (!url) throw new Error('ALERT_WEBHOOK_URL is not set.');
  const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`Slack webhook failed (HTTP ${res.status})`);
}

// The scheduled entry point. Returns what it did; never throws to the scheduler.
export async function runAlertCheck({ now = Date.now(), store = alertStore(), fetchImpl = fetch, force = false } = {}) {
  if (!force && !withinHours(now)) return { skipped: 'outside 9am to 9pm Pacific' };
  if (!process.env.ALERT_WEBHOOK_URL) return { skipped: 'ALERT_WEBHOOK_URL not set' };
  if (mode() === 'sample' && process.env.ALERT_ALLOW_SAMPLE !== '1') return { skipped: 'sample mode (set ALERT_ALLOW_SAMPLE=1 to test Slack with sample data)' };
  try {
    const { alerts } = await currentAlerts({ now, store, fetchImpl });
    const state = (await store.get(STATE_KEY, { type: 'json' }).catch(() => null)) || { sent: {} };
    const cooldown = envNum('ALERT_COOLDOWN_MIN', 120) * 60000;
    const isNew = k => !state.sent[k] || now - state.sent[k] > cooldown;
    const fresh = alerts.filter(a => a.itemKeys ? a.itemKeys.some(k => !state.sent[k]) : isNew(a.key));
    if (!fresh.length) return { alerts: alerts.length, sent: 0 };
    await postSlack(slackMessage(fresh, now), fetchImpl);
    for (const a of fresh) for (const k of a.itemKeys || [a.key]) state.sent[k] = now;
    for (const [k, t] of Object.entries(state.sent)) if (now - t > 3 * 86400000) delete state.sent[k];
    await store.setJSON(STATE_KEY, state);
    return { alerts: alerts.length, sent: fresh.length };
  } catch (error) {
    console.error('Alert check failed', error);
    return { error: error.message };
  }
}
