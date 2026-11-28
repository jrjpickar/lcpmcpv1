import { readJson } from './read-json.mjs';
// Data loaders. Each returns the normalized shape lcp-metrics.js expects.
//
//   Dialer (Triple Line):  GET {DIALER_URL}/api/dashboard/dispositions?from&to   header x-dashboard-key: DIALER_EXPORT_KEY
//   GHL:                   opportunities/search, contacts/{id}, conversations/messages/export (SMS), users
//   Ledger (LocalCare):    GET {LEDGER_URL}/api/mcp-export                         header x-mcp-key: LEDGER_EXPORT_KEY
//
// Sample mode (DATA_MODE=sample, or GHL not configured) uses public/sample-data.js only.
// Results are cached per function instance for CACHE_SECONDS (default 300).

import { setTimeout as delay } from 'node:timers/promises';
import Sample from '../../../public/sample-data.js';
import Metrics from '../../../public/lcp-metrics.js';

const GHL_API = 'https://services.leadconnectorhq.com';
const env = (name, fallback = '') => process.env[name] || fallback;
const envInt = (name, fallback) => { const n = Number.parseInt(process.env[name] || '', 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
const cache = new Map();
const pending = new Map();
const reference = new Map();
const reportBudgetMs = 7000;

function cachedReference(key, ttl, load, fetchImpl) {
  if (fetchImpl !== fetch) return load();
  const hit = reference.get(key);
  if (hit?.until > Date.now()) return hit.result;
  const entry = { until: Date.now() + ttl };
  entry.result = load().catch(error => {
    if (reference.get(key) === entry) reference.delete(key);
    throw error;
  });
  reference.set(key, entry);
  return entry.result;
}

function pacificMidnight(day) {
  const standard = Date.parse(day + 'T08:00:00Z');
  return new Date(Metrics.dayKey(standard - 3600000) === day ? standard - 3600000 : standard).toISOString();
}
let sampleData = null;

export function mode() {
  if (env('DATA_MODE') === 'sample') return 'sample';
  return env('GHL_ACCESS_TOKEN') && env('GHL_LOCATION_ID') ? 'live' : 'sample';
}

export function sourceStatus() {
  const m = mode();
  return {
    mode: m,
    dialer: m === 'live' && Boolean(env('DIALER_URL') && env('DIALER_EXPORT_KEY')),
    ghl: m === 'live',
    ledger: m === 'live' && Boolean(env('LEDGER_URL') && env('LEDGER_EXPORT_KEY')),
    workflows: m === 'live' && Boolean(env('DATA_DASHBOARD_URL') && env('DATA_DASHBOARD_KEY')),
    groq: Boolean(env('GROQ_API_KEY')),
  };
}

// Loads data that covers [from - lookback, to] so touches before a qualification are counted.
export async function loadData({ from, to, fetchImpl = fetch } = {}) {
  if (mode() === 'sample') {
    sampleData ||= Sample.generate();
    return sampleData;
  }
  const lookback = envInt('TOUCH_LOOKBACK_DAYS', 60);
  const start = Metrics.shiftDay(from, -lookback);
  const key = `${start}|${to}`;
  if (fetchImpl !== fetch) return loadLiveData(start, from, to, lookback, fetchImpl);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < envInt('CACHE_SECONDS', 300) * 1000) return hit.data;
  if (pending.has(key)) return pending.get(key);
  const request = loadLiveData(start, from, to, lookback, fetchImpl).then(data => {
    if (data.meta.timedOut && hit) return { ...hit.data, meta: { ...hit.data.meta, warnings: ['Live refresh timed out. Showing the last complete report.'], stale: true } };
    if (!data.meta.warnings.length) {
      cache.set(key, { at: Date.now(), data });
      if (cache.size > 12) cache.delete(cache.keys().next().value);
    }
    return data;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

async function loadLiveData(start, from, to, lookback, fetchImpl) {
  const deadline = AbortSignal.timeout(reportBudgetMs);
  const reportFetch = (url, options = {}) => {
    deadline.throwIfAborted();
    return fetchImpl(url, {
      ...options,
      signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
    });
  };
  const warnings = [];
  const safe = async (label, fn, fallback) => {
    try { return await fn(); } catch (error) {
      warnings.push(`${label}: ${deadline.aborted ? 'Report time limit reached' : error.message}`);
      return fallback;
    }
  };
  const users = safe('GHL users', () => cachedReference('users', 600000, () => fetchGhlUsers(reportFetch, deadline), fetchImpl), {});
  const pipelines = safe('GHL pipelines', () => cachedReference('pipelines', 600000,
    () => ghl(`/opportunities/pipelines?locationId=${encodeURIComponent(env('GHL_LOCATION_ID'))}`, { fetchImpl: reportFetch, deadline }), fetchImpl), {});
  const opportunitiesRead = safe('GHL opportunities', () => ghlOpportunities(start, pipelines, users, reportFetch, 'all', deadline), []);
  const [calls, opportunities, openOpps, sms, inboundCalls, ledger, contacts] = await Promise.all([
    safe('Dialer', () => dialerCalls(start, to, reportFetch), []),
    opportunitiesRead,
    safe('GHL open opportunities', () => ghlOpportunities(null, pipelines, users, reportFetch, 'open', deadline), []),
    safe('GHL SMS', async () => {
      const messages = await ghlSms(start, to, {}, reportFetch, deadline);
      const names = await users;
      return messages.map(message => ({ ...message, rep: names[message.rep] || message.rep }));
    }, []),
    safe('GHL inbound calls', () => ghlInboundCalls(Metrics.shiftDay(to, -Math.min(31, lookback)), to, reportFetch, undefined, deadline), []),
    safe('Ledger', () => cachedReference('ledger', 300000, () => ledgerExport(reportFetch), fetchImpl), { deals: [], spend: [], ap: null }),
    safe('GHL contacts', async () => ghlContacts(await opportunitiesRead, from, to, reportFetch, deadline), []),
  ]);
  const seen = new Set(opportunities.map(o => o.id));
  for (const o of openOpps) if (!seen.has(o.id)) opportunities.push(o); // stage aging needs every open deal, not only recent ones
  return { calls, sms, inboundCalls, contacts, opportunities, deals: ledger.deals, spend: ledger.spend, ap: ledger.ap,
    meta: { mode: 'live', label: 'LIVE', loadedAt: new Date().toISOString(), from: start, to, warnings, timedOut: deadline.aborted } };
}

// ---------------- Dialer ----------------
// Dialer queue id -> label. Optional MANUAL_ACTION_QUEUES (same JSON as the dialer); otherwise the id is tidied.
let listLabels = null;
export function listLabel(id) {
  if (!id) return '';
  if (!listLabels) { listLabels = {}; try { for (const q of JSON.parse(env('MANUAL_ACTION_QUEUES') || '[]')) if (q?.id) listLabels[q.id] = q.label || q.id; } catch { /* ignore bad JSON */ } }
  return listLabels[id] || String(id).replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function normalizeDispositionRow(row) {
  return {
    callerId: row.callerId || '',
    list: listLabel(row.action),
    id: row.id || row.sid || '',
    at: row.at,
    rep: String(row.agent || '').trim() || 'Unknown',
    contactId: row.contactId || '',
    disposition: row.dispositionId || '',
    connected: Boolean(row.connected),
    duration: Number.isFinite(row.duration) ? row.duration : 0,
  };
}

export async function dialerCalls(from, to, fetchImpl = fetch) {
  const base = env('DIALER_URL').replace(/\/+$/, '');
  const key = env('DIALER_EXPORT_KEY');
  if (!base || !key) return [];
  const out = [];
  // The dialer export accepts at most 62 days per request.
  for (let start = from; start <= to; start = Metrics.shiftDay(start, 60)) {
    const end = Metrics.shiftDay(start, 59) < to ? Metrics.shiftDay(start, 59) : to;
    const payload = await readJson(`${base}/api/dashboard/dispositions?from=${start}&to=${end}`, {
      headers: { 'x-dashboard-key': key, accept: 'application/json' }, signal: AbortSignal.timeout(20000),
    }, { fetchImpl });
    for (const day of Object.values(payload.days || {})) for (const row of day.rows || []) if (row?.at) out.push(normalizeDispositionRow(row));
  }
  return out;
}

// ---------------- GHL ----------------
async function ghl(path, { method = 'GET', body, version = '2021-07-28', fetchImpl = fetch, deadline } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetchImpl(`${GHL_API}${path}`, {
      method, signal: AbortSignal.timeout(25000), body: body ? JSON.stringify(body) : undefined,
      headers: { Accept: 'application/json', Authorization: `Bearer ${env('GHL_ACCESS_TOKEN')}`, Version: version, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    });
    if (res.status === 429 || res.status >= 500) {
      void res.body?.cancel().catch(() => {});
      if (attempt < 3) await delay(600 * (attempt + 1), undefined, { signal: deadline });
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} on ${path.split('?')[0]}`);
    return res.json();
  }
  throw new Error(`rate limited on ${path.split('?')[0]}`);
}

function ghlUsers(fetchImpl) {
  return cachedReference('users', 600000, () => fetchGhlUsers(fetchImpl), fetchImpl);
}

async function fetchGhlUsers(fetchImpl, deadline) {
  const payload = await ghl(`/users/?locationId=${encodeURIComponent(env('GHL_LOCATION_ID'))}`, { fetchImpl, deadline });
  const map = {};
  for (const u of payload.users || []) map[u.id] = u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id;
  return map;
}

export function normalizeOpportunity(o, users = {}, pipelines = {}) {
  return {
    id: o.id, contactId: o.contactId || o.contact?.id || '', name: o.name || '',
    createdAt: o.createdAt || o.dateAdded, rep: users[o.assignedTo] || (o.assignedTo ? o.assignedTo : 'Unassigned'),
    pipeline: pipelines[o.pipelineId]?.name || o.pipelineName || o.pipelineId || '',
    stage: pipelines[o.pipelineId]?.stages?.[o.pipelineStageId] || o.pipelineStageName || '',
    status: o.status || 'open', value: Number(o.monetaryValue) || 0,
    stageAt: o.lastStageChangeAt || o.lastStatusChangeAt || o.updatedAt || o.createdAt || null,
  };
}

async function ghlOpportunities(start, pipelineRead, users, fetchImpl, status, deadline) {
  const payload = await pipelineRead;
  const pipelines = Object.fromEntries((payload.pipelines || []).map(p => [p.id, { name: p.name, stages: Object.fromEntries((p.stages || []).map(s => [s.id, s.name])) }]));
  const startMs = start ? Date.parse(pacificMidnight(start)) : -Infinity;
  const out = [];
  let cursor = null;
  for (let page = 0; page < envInt('GHL_MAX_OPP_PAGES', 60); page++) {
    const params = new URLSearchParams({ location_id: env('GHL_LOCATION_ID'), status, limit: '100', order: 'added_desc' });
    if (cursor) { params.set('start_after', cursor.startAfter); params.set('start_after_id', cursor.startAfterId); }
    const payload = await ghl(`/opportunities/search?${params}`, { fetchImpl, deadline });
    const rows = payload.opportunities || [];
    let older = false;
    for (const o of rows) { const n = normalizeOpportunity(o, {}, pipelines); if (Date.parse(n.createdAt) < startMs) { older = true; continue; } out.push(n); }
    if (older || rows.length < 100 || !payload.meta?.startAfterId) break;
    cursor = { startAfter: String(payload.meta.startAfter), startAfterId: payload.meta.startAfterId };
  }
  const names = await users;
  return out.map(opportunity => ({ ...opportunity, rep: names[opportunity.rep] || opportunity.rep }));
}

// Only contacts behind opportunities in range are fetched (city / ZIP for the location view).
async function ghlContacts(opportunities, from, to, fetchImpl, deadline) {
  const start = Date.parse(pacificMidnight(from)), end = Date.parse(pacificMidnight(Metrics.shiftDay(to, 1)));
  const ids = [...new Set(opportunities.filter(o => {
    const timestamp = Date.parse(o.createdAt);
    return o.contactId && timestamp >= start && timestamp < end;
  }).map(o => o.contactId))].slice(0, envInt('GHL_MAX_CONTACTS', 400));
  const out = [];
  for (let i = 0; i < ids.length; i += 8) {
    deadline?.throwIfAborted();
    const batch = await Promise.all(ids.slice(i, i + 8).map(id => ghl(`/contacts/${encodeURIComponent(id)}`, { fetchImpl, deadline }).then(p => p.contact || p).catch(error => { if (deadline?.aborted) throw error; return null; })));
    for (const c of batch) if (c?.id) out.push({ id: c.id, name: c.contactName || [c.firstName, c.lastName].filter(Boolean).join(' '), city: c.city || '', zip: String(c.postalCode || '').slice(0, 5) });
  }
  return out;
}

export function normalizeSms(m, users = {}) {
  const direction = String(m.direction || '').toLowerCase() === 'inbound' ? 'inbound' : 'outbound';
  const rep = direction === 'inbound' ? '' : (users[m.userId] || (m.userId ? m.userId : (/workflow|campaign|bulk/i.test(m.source || '') ? 'Workflow' : 'Automation')));
  const out = { id: m.id || m.messageId || '', at: m.dateAdded || m.createdAt, rep, contactId: m.contactId || '', direction };
  if (direction === 'inbound') out.body = String(m.body || '').slice(0, 300); // classified for reply quality; only aggregates leave the server
  return out;
}

async function ghlSms(start, to, users, fetchImpl, deadline) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < envInt('GHL_MAX_SMS_PAGES', 40); page++) {
    const params = new URLSearchParams({ locationId: env('GHL_LOCATION_ID'), channel: 'SMS', limit: '1000', sortBy: 'createdAt', sortOrder: 'desc',
      startDate: pacificMidnight(start), endDate: pacificMidnight(Metrics.shiftDay(to, 1)) });
    if (cursor) params.set('cursor', cursor);
    const payload = await ghl(`/conversations/messages/export?${params}`, { fetchImpl, version: 'v3', deadline });
    for (const m of payload.messages || []) out.push(normalizeSms(m, users));
    cursor = payload.nextCursor;
    if (!cursor) break;
  }
  return out;
}

// Inbound seller calls (GHL call messages), used only as speed-to-lead events.
export async function ghlInboundCalls(start, to, fetchImpl = fetch, maxPages = envInt('GHL_MAX_CALL_PAGES', 6), deadline) {
  const out = [];
  let cursor = null;
  for (let page = 0; page < maxPages; page++) {
    const params = new URLSearchParams({ locationId: env('GHL_LOCATION_ID'), channel: 'Call', limit: '1000', sortBy: 'createdAt', sortOrder: 'desc',
      startDate: pacificMidnight(start), endDate: pacificMidnight(Metrics.shiftDay(to, 1)) });
    if (cursor) params.set('cursor', cursor);
    const payload = await ghl(`/conversations/messages/export?${params}`, { fetchImpl, version: 'v3', deadline });
    for (const m of payload.messages || []) if (String(m.direction || '').toLowerCase() === 'inbound' && m.contactId) out.push({ id: m.id || m.messageId, at: m.dateAdded || m.createdAt, contactId: m.contactId });
    cursor = payload.nextCursor;
    if (!cursor) break;
  }
  return out;
}

// Light load for the 5-minute alert check: today and yesterday only.
export async function loadAlertData({ now = Date.now(), fetchImpl = fetch } = {}) {
  if (mode() === 'sample') { sampleData ||= Sample.generate({ now }); return sampleData; }
  const today = Metrics.dayKey(now), yesterday = Metrics.shiftDay(today, -1);
  const users = await ghlUsers(fetchImpl).catch(() => ({}));
  const [calls, sms, inboundCalls] = await Promise.all([
    dialerCalls(yesterday, today, fetchImpl),
    ghlSms(yesterday, today, users, fetchImpl),
    ghlInboundCalls(yesterday, today, fetchImpl, 2).catch(() => []),
  ]);
  return { calls, sms, inboundCalls, opportunities: [], meta: { mode: 'live' } };
}

// Once a day: 7-day caller ID baseline, 7-day opt-out rate and 8-week list decay.
export async function loadBaselineData({ now = Date.now(), fetchImpl = fetch } = {}) {
  if (mode() === 'sample') { sampleData ||= Sample.generate({ now }); return sampleData; }
  const today = Metrics.dayKey(now);
  const users = await ghlUsers(fetchImpl).catch(() => ({}));
  const [calls, sms] = await Promise.all([dialerCalls(Metrics.shiftDay(today, -56), Metrics.shiftDay(today, -1), fetchImpl), ghlSms(Metrics.shiftDay(today, -7), Metrics.shiftDay(today, -1), users, fetchImpl)]);
  return { calls, sms, opportunities: [], meta: { mode: 'live' } };
}

// ---------------- Ledger ----------------
export function normalizeLedger(payload = {}) {
  const num = v => (v == null || v === '' ? null : Number(v));
  return {
    deals: (payload.deals || []).map(d => ({ opportunityId: d.opportunityId, propertyAddress: d.propertyAddress || null, assignmentFee: num(d.assignmentFee), contractPrice: num(d.contractPrice),
      feeReceived: num(d.feeReceived), feeReceivedDate: d.feeReceivedDate || null, contractDate: d.contractDate || null, expectedCloseDate: d.expectedCloseDate || null,
      emdAmount: num(d.emdAmount), emdStatus: d.emdStatus || 'none', closingCosts: num(d.closingCosts) })),
    spend: (payload.spend || []).filter(x => x?.date && Number.isFinite(Number(x.amount))).map(x => ({ date: String(x.date).slice(0, 10), category: x.category || 'Uncategorized', amount: Number(x.amount) })),
    ap: payload.ap ? { owed: Number(payload.ap.owed) || 0, count: Number(payload.ap.count) || 0 } : null,
  };
}

async function ledgerExport(fetchImpl) {
  const base = env('LEDGER_URL').replace(/\/+$/, '');
  if (!base || !env('LEDGER_EXPORT_KEY')) return { deals: [], spend: [], ap: null };
  const payload = await readJson(`${base}/api/mcp-export`, {
    headers: { 'x-mcp-key': env('LEDGER_EXPORT_KEY'), accept: 'application/json' }, signal: AbortSignal.timeout(15000),
  }, { fetchImpl });
  return normalizeLedger(payload);
}

// ---------------- Workflows (from the v2 data dashboard's workflow feed) ----------------
// GET {DATA_DASHBOARD_URL}/api/workflow-feed?days=N  Authorization: Bearer DATA_DASHBOARD_KEY (= its DASHBOARD_EMBED_KEY)
const wfCache = new Map();
export async function loadWorkflows(days = 30, fetchImpl = fetch) {
  const d = Math.min(120, Math.max(7, Math.round(Number(days) || 30)));
  if (mode() === 'sample') return Sample.workflows(d);
  const base = env('DATA_DASHBOARD_URL').replace(/\/+$/, '');
  if (!base || !env('DATA_DASHBOARD_KEY')) return { configured: false, days: d, error: 'Set DATA_DASHBOARD_URL and DATA_DASHBOARD_KEY to show workflow stats.' };
  const hit = wfCache.get(d);
  if (hit && Date.now() - hit.at < 120000) return hit.data;
  const p = await readJson(`${base}/api/workflow-feed?days=${d}`, {
    headers: { authorization: `Bearer ${env('DATA_DASHBOARD_KEY')}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000),
  }, { fetchImpl }).catch(error => {
    if (!error.upstreamStatus) throw error;
    throw Object.assign(new Error(`Workflow feed failed (HTTP ${error.upstreamStatus})`), { status: 502 });
  });
  const data = { configured: p.configured !== false, days: d, feed: p.feed || null, overview: p.overview || {}, weekly: p.weekly || [],
    workflows: (p.workflows || []).map(w => ({ id: w.id, name: w.name, status: w.status, entered: w.entered || 0, finished: w.finished || 0, skipped: w.skipped || 0, failed: w.failed || 0, completionRate: w.completionRate ?? null })),
    reasons: (p.reasons || []).slice(0, 20).map(r => ({ event: r.event, workflow: r.workflow, step: r.step, reason: r.reason, count: r.count })) };
  wfCache.set(d, { at: Date.now(), data });
  return data;
}
