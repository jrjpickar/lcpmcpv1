// Dashboard data sync. Pulls the same sources the v2 data dashboard reads, straight from the source APIs,
// and keeps LCP's own copy. Read-only against every source. The data dashboard is not called except for two
// read-only GETs of settings it owns (tag visibility, batch settings), with the existing DATA_DASHBOARD_KEY.
//
//   GHL:     contacts/search, opportunities/search + pipelines, conversations/messages/export (SMS),
//            locations/{id}/tasks/search, calendars + calendars/events, users, contact custom fields
//   Twilio:  Calls.json (outbound dials), matched to GHL contacts by phone, reps by caller ID (dashboard roster)
//   Dialer:  POST {DIALER_URL}/api/dashboard/call-ownership (signed-in rep per call SID), same as the dashboard
//
// Load on GHL is kept low on purpose so the dashboard and dialer keep their rate limit headroom:
//   - Full contact pass once a night (1am to 5am Pacific); other runs read only new contacts.
//   - SMS and Twilio calls read only the last 2 days on normal runs; the full window (DASH_SYNC_DAYS) nightly.
//   - Tasks every 2 hours. Appointments: the last 31 days and next 45 on normal runs.
// Normalization and every metric rule come from the vendored dashboard modules in ./dash.
import { getStore } from '@netlify/blobs';
import { ghl, rowsFrom } from './dash/_ghl.mjs';
import { normalize } from './dash/_normalize.mjs';
import { normalizeTags } from './dash/_sms.mjs';
import { agentAssignments, fetchTwilioPage, crossReferenceCalls } from './dash/_twilio.mjs';
import { attributeDialerCalls } from './dash/_call-ownership.mjs';
import { fetchTasks } from './dash/_tasks.mjs';
import { fetchCustomFieldDefinitions, resolveQualificationFields, fetchAppointments, compactContact } from './dash/_lead-fields.mjs';
import { locationUsers, mergeUsers } from './dash/_ghl-users.mjs';
import { derive } from './dash-derived.mjs';

const DAY = 86400000;
const CHUNK = 4000;
export const PHASES = ['reference', 'contacts', 'opportunities', 'sms', 'calls', 'tasks', 'appointments', 'finalize'];
const envInt = (env, name, fallback) => { const n = Number.parseInt(env[name] || '', 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
// The vendored dashboard readers take a few settings from process.env. Set them from env for one call, then restore.
async function withEnv(vars, fn) {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) { if (v == null || v === '') delete process.env[k]; else process.env[k] = v; }
  try { return await fn(); }
  finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const pacificHour = now => Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', hourCycle: 'h23' }).format(new Date(now))) % 24;

export function dashStore() {
  return getStore({ name: 'lcp-dash', consistency: 'strong' });
}

export function syncConfigured(env = process.env) {
  return Boolean(env.GHL_ACCESS_TOKEN && env.GHL_LOCATION_ID && env.DATA_MODE !== 'sample');
}

// ---------------- chunked datasets ----------------
export async function saveSet(store, name, rows, extra = {}) {
  const chunks = Math.ceil(rows.length / CHUNK);
  for (let i = 0; i < chunks; i++) await store.setJSON(`dash/set/${name}/${i}`, rows.slice(i * CHUNK, (i + 1) * CHUNK));
  const old = await store.get(`dash/set/${name}`, { type: 'json' });
  for (let i = chunks; i < (old?.chunks || 0); i++) await store.delete?.(`dash/set/${name}/${i}`);
  const manifest = { chunks, rows: rows.length, at: new Date().toISOString(), ...extra };
  await store.setJSON(`dash/set/${name}`, manifest);
  return manifest;
}
export async function loadSet(store, name) {
  const manifest = await store.get(`dash/set/${name}`, { type: 'json' });
  if (!manifest) return { manifest: null, rows: [] };
  const rows = [];
  for (let i = 0; i < manifest.chunks; i++) rows.push(...((await store.get(`dash/set/${name}/${i}`, { type: 'json' })) || []));
  return { manifest, rows };
}
const mergeById = (oldRows, newRows, keep = () => true) => {
  const map = new Map(oldRows.map(r => [r.id, r]));
  for (const r of newRows) if (r?.id) map.set(r.id, r);
  return [...map.values()].filter(keep);
};

// ---------------- GHL readers ----------------
async function contactPage(request, env, searchAfter) {
  const body = { locationId: env.GHL_LOCATION_ID, pageLimit: 100, sort: [{ field: 'dateAdded', direction: 'desc' }] };
  if (searchAfter) body.searchAfter = searchAfter;
  const payload = await request('/contacts/search', { method: 'POST', body });
  const rows = rowsFrom(payload, 'contacts');
  const next = rows.at(-1)?.searchAfter ?? payload.searchAfter ?? payload.meta?.searchAfter ?? null;
  return { rows, next: rows.length < 100 ? null : next };
}
async function opportunityPage(request, env, cursor = {}) {
  const params = new URLSearchParams({ locationId: env.GHL_LOCATION_ID, status: 'all', limit: '100', order: 'added_desc' });
  if (cursor.startAfter) params.set('startAfter', cursor.startAfter);
  if (cursor.startAfterId) params.set('startAfterId', cursor.startAfterId);
  const payload = await request(`/opportunities/search?${params}`);
  const rows = rowsFrom(payload, 'opportunities');
  const next = payload.meta?.startAfter && payload.meta?.startAfterId ? { startAfter: String(payload.meta.startAfter), startAfterId: payload.meta.startAfterId } : null;
  return { rows, next: rows.length < 100 ? null : next };
}
async function smsPage(request, env, startDate, endDate, cursor) {
  const params = new URLSearchParams({ locationId: env.GHL_LOCATION_ID, channel: 'SMS', limit: '1000', sortBy: 'createdAt', sortOrder: 'desc', startDate, endDate });
  if (cursor) params.set('cursor', cursor);
  const payload = await request(`/conversations/messages/export?${params}`);
  return { rows: rowsFrom(payload, 'messages'), next: payload.nextCursor || null };
}

const slimOpp = o => ({ id: o.id, contactId: o.contactId || o.contact?.id || '', contact: o.contact ? { id: o.contact.id, name: o.contact.name, phone: o.contact.phone, tags: o.contact.tags } : undefined,
  name: o.name, assignedTo: o.assignedTo, pipelineId: o.pipelineId, pipelineStageId: o.pipelineStageId, status: o.status, monetaryValue: o.monetaryValue,
  createdAt: o.createdAt, dateAdded: o.dateAdded, lastStageChangeAt: o.lastStageChangeAt, lastStatusChangeAt: o.lastStatusChangeAt, updatedAt: o.updatedAt, lostReasonName: o.lostReasonName, lostReasonId: o.lostReasonId });
const slimSms = m => ({ id: m.id || m.messageId || m.altId, contactId: m.contactId || '', conversationId: m.conversationId || '', direction: m.direction, status: m.status,
  body: String(m.body || '').slice(0, 400), source: m.source || '', error: m.error || '', userId: m.userId || '', from: m.from || '', to: m.to || '', dateAdded: m.dateAdded || m.createdAt, updatedAt: m.updatedAt });
const slimTwilio = c => ({ id: c.sid, sid: c.sid, direction: c.direction, to: c.to, from: c.from, status: c.status, duration: c.duration, start_time: c.start_time, date_created: c.date_created, date_updated: c.date_updated, answered_by: c.answered_by });

// ---------------- dashboard-owned settings (read only) ----------------
export async function dashboardSettings(env, fetchImpl = fetch) {
  const base = String(env.DATA_DASHBOARD_URL || '').replace(/\/+$/, '');
  if (!base || !env.DATA_DASHBOARD_KEY) return { tagVisibility: null, batchSettings: null, warning: 'DATA_DASHBOARD_URL / DATA_DASHBOARD_KEY not set: every tag counts as a list tag and default list thresholds are used.' };
  const get = async name => {
    const res = await fetchImpl(`${base}/.netlify/functions/dashboard-data?settings=${name}`, { headers: { authorization: `Bearer ${env.DATA_DASHBOARD_KEY}`, accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
    return res.json();
  };
  try {
    const [tagVisibility, batchSettings] = await Promise.all([get('tag-visibility'), get('batch-settings')]);
    return { tagVisibility, batchSettings, warning: '' };
  } catch (error) {
    return { tagVisibility: null, batchSettings: null, warning: `Dashboard settings unavailable (${error.message}); every tag counts as a list tag.` };
  }
}

// ---------------- the run ----------------
// One call does as many phases as fit in budgetMs and saves its place. Returns { more } when it stopped early.
export async function runDashSync({ store = dashStore(), env = process.env, fetchImpl = fetch, now = Date.now(), budgetMs = 12 * 60000, force = '' } = {}) {
  if (!syncConfigured(env)) return { skipped: 'GHL not configured or DATA_MODE=sample' };
  const started = Date.now();
  const outOfTime = (reserve = 60000) => Date.now() - started > budgetMs - reserve;
  const request = (path, options = {}) => ghl(path, { ...options, fetchImpl, token: env.GHL_ACCESS_TOKEN });
  const days = envInt(env, 'DASH_SYNC_DAYS', 120);
  const windowStart = new Date(now - days * DAY).toISOString();
  let state = (await store.get('dash/state', { type: 'json' })) || {};
  if (!state.run || state.run.done || force) {
    const contactsSet = await store.get('dash/set/contacts', { type: 'json' });
    const lastFull = Date.parse(contactsSet?.fullAt || '') || 0;
    const hour = pacificHour(now);
    const full = force === 'full' || !contactsSet || (now - lastFull > 20 * 3600000 && hour >= 1 && hour < 5) || now - lastFull > 3 * DAY;
    state = { run: { id: now.toString(36), full, phase: 0, startedAt: new Date(now).toISOString(), cursor: null, staged: 0, warnings: [], ref: null } };
  }
  const run = state.run;
  const save = () => store.setJSON('dash/state', state);
  const warn = text => { if (text && !run.warnings.includes(text)) run.warnings.push(text); };
  let agents = [];
  try { agents = agentAssignments(env.AGENT_ASSIGNMENTS); } catch (error) { warn(`${error.message} The dashboard's built-in phone roster is used for caller IDs.`); }

  while (run.phase < PHASES.length) {
    const phase = PHASES[run.phase];
    if (phase !== 'contacts' && outOfTime()) { await save(); return { more: true, phase, runId: run.id }; }
    try {
      if (phase === 'reference') {
        const { users, warning } = await withEnv({ GHL_LOCATION_ID: env.GHL_LOCATION_ID }, () => locationUsers(store, { request }));
        warn(warning);
        const pipelines = rowsFrom(await request(`/opportunities/pipelines?locationId=${encodeURIComponent(env.GHL_LOCATION_ID)}`, { version: '2021-07-28' }), 'pipelines');
        let qualification = null;
        try { qualification = resolveQualificationFields(await fetchCustomFieldDefinitions({ ghlImpl: request, locationId: env.GHL_LOCATION_ID }), env.QUALIFICATION_FIELDS); qualification.warnings.forEach(warn); }
        catch (error) { warn(`Contact custom fields unavailable (${error.message}); qualification fields are skipped.`); }
        const settings = await dashboardSettings(env, fetchImpl);
        warn(settings.warning);
        run.ref = { users: mergeUsers(agents, users), pipelines, qualification, settings: { tagVisibility: settings.tagVisibility, batchSettings: settings.batchSettings } };
      } else if (phase === 'contacts') {
        const done = await contactsPhase({ store, request, env, run, now, outOfTime });
        if (!done) { await save(); return { more: true, phase, runId: run.id }; }
      } else if (phase === 'opportunities') {
        const rows = [];
        let cursor = {};
        for (let page = 0; page < envInt(env, 'DASH_MAX_OPP_PAGES', 300); page++) {
          const r = await opportunityPage(request, env, cursor);
          rows.push(...r.rows.map(slimOpp));
          if (!r.next) break;
          cursor = r.next;
        }
        await saveSet(store, 'opportunities', rows);
      } else if (phase === 'sms') {
        const { manifest, rows: old } = await loadSet(store, 'sms');
        const from = run.full || !manifest?.newest ? windowStart : new Date(Math.max(Date.parse(windowStart), Date.parse(manifest.newest) - 2 * DAY)).toISOString();
        const fresh = [];
        let cursor = null;
        for (let page = 0; page < envInt(env, 'DASH_MAX_SMS_PAGES', 200); page++) {
          const r = await smsPage(request, env, from, new Date(now + DAY).toISOString(), cursor);
          fresh.push(...r.rows.map(slimSms));
          if (!r.next) break;
          cursor = r.next;
        }
        const rows = mergeById(old, fresh, m => Date.parse(m.dateAdded) >= Date.parse(windowStart));
        const newest = rows.reduce((a, m) => (m.dateAdded > a ? m.dateAdded : a), manifest?.newest || '');
        await saveSet(store, 'sms', rows, { newest, from: windowStart });
      } else if (phase === 'calls') {
        await callsPhase({ store, env, fetchImpl, run, now, windowStart, agents, warn });
      } else if (phase === 'tasks') {
        const manifest = await store.get('dash/set/tasks', { type: 'json' });
        if (run.full || !manifest || now - Date.parse(manifest.at) > 2 * 3600000) {
          const users = run.ref?.users || [];
          const tasks = await withEnv({ GHL_LOCATION_ID: env.GHL_LOCATION_ID }, () => fetchTasks({ request: (path, o) => request(path, o), deadline: Date.now() + 240000, agents, users }));
          await saveSet(store, 'tasks', tasks);
        }
      } else if (phase === 'appointments') {
        const { manifest, rows: old } = await loadSet(store, 'appointments');
        const from = run.full || !manifest ? windowStart : new Date(now - 31 * DAY).toISOString();
        const result = await fetchAppointments(from, new Date(now + 45 * DAY).toISOString(), { ghlImpl: request, locationId: env.GHL_LOCATION_ID, deadline: Date.now() + 180000 });
        if (!result.complete) warn(`Appointments covered from ${result.coveredFrom.slice(0, 10)} only (time limit).`);
        const rows = mergeById(old, result.appointments, a => !a.start || Date.parse(a.start) >= Date.parse(windowStart));
        await saveSet(store, 'appointments', rows, { calendars: result.calendars });
      } else if (phase === 'finalize') {
        await finalize({ store, run, now, windowStart });
      }
    } catch (error) {
      // A failed source keeps its last saved copy. The run moves on so one source cannot block the rest.
      warn(`${phase}: ${error.message}`);
      if (phase === 'contacts') { run.cursor = null; run.staged = 0; }
    }
    run.phase++;
    await save();
  }
  run.done = true;
  run.finishedAt = new Date().toISOString();
  await save();
  const published = await publishToSite({ store, env, fetchImpl, state });
  if (published.error) warn(published.error);
  return { done: true, runId: run.id, full: run.full, warnings: run.warnings, ms: Date.now() - started, published: published.ok || false };
}

// VM only (RUN_SCHEDULES_ON=vm): the sync runs here, but Brain and Marketing on Netlify read Netlify Blobs.
// After each finished run, POST the small derived snapshot to the site's /api/dash-publish with DASH_SYNC_SECRET.
// Set LCP_SITE_URL (https://your-site.netlify.app) and the same DASH_SYNC_SECRET in the VM .env. On Netlify this does nothing.
export async function publishToSite({ store, env = process.env, fetchImpl = fetch, state }) {
  if (env.NETLIFY || !env.LCP_SITE_URL) return { skipped: true };
  if (String(env.DASH_SYNC_SECRET || '').length < 16) return { error: 'LCP_SITE_URL is set but DASH_SYNC_SECRET is missing on the VM: the Netlify site will not get these numbers.' };
  let url;
  try { url = new URL('/api/dash-publish', env.LCP_SITE_URL); if (url.protocol !== 'https:') throw new Error(); } catch { return { error: 'LCP_SITE_URL must be the https address of the LCP site.' }; }
  const derived = await store.get('dash/derived', { type: 'json' });
  if (!derived) return { error: 'Nothing to publish: no derived snapshot.' };
  try {
    const res = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'content-type': 'application/json', 'x-sync-secret': env.DASH_SYNC_SECRET }, body: JSON.stringify({ derived, state }) });
    if (!res.ok) return { error: `Publishing to the Netlify site failed (HTTP ${res.status}). Check LCP_SITE_URL and that DASH_SYNC_SECRET matches Netlify.` };
    return { ok: true };
  } catch (error) {
    return { error: `Publishing to the Netlify site failed (${error.message}).` };
  }
}

// Full pass: every contact, staged in chunks so a long pass can continue in the next invocation.
// Incremental: newest contacts until one is older than the newest already saved (minus 2 hours).
async function contactsPhase({ store, request, env, run, now, outOfTime }) {
  const qualification = run.ref?.qualification || null;
  const firstSeen = (await store.get('lead-intel/first-seen', { type: 'json' })) || {};
  let seenDirty = false;
  const stamp = new Date(now).toISOString();
  const compact = raw => {
    if (raw?.id && !firstSeen[raw.id]) { firstSeen[raw.id] = { t: normalizeTags(raw.tags), at: stamp }; seenDirty = true; }
    return compactContact(raw, qualification, firstSeen[raw.id]);
  };
  const flushSeen = async () => { if (seenDirty) await store.setJSON('lead-intel/first-seen', firstSeen); seenDirty = false; };
  if (!run.full) {
    const { manifest, rows: old } = await loadSet(store, 'contacts');
    const newest = Date.parse(manifest?.newest || '') || 0;
    const fresh = [];
    let cursor = null;
    for (let page = 0; page < 30; page++) {
      const r = await contactPage(request, env, cursor);
      fresh.push(...r.rows.map(compact));
      const oldest = Math.min(...r.rows.map(c => Date.parse(c.dateAdded || '') || Infinity));
      if (!r.next || oldest < newest - 2 * 3600000) break;
      cursor = r.next;
    }
    await flushSeen();
    const rows = mergeById(old, fresh);
    await saveSet(store, 'contacts', rows, { newest: maxDate(rows), fullAt: manifest?.fullAt || null });
    return true;
  }
  let buffer = [];
  const stage = async () => {
    if (!buffer.length) return;
    await store.setJSON(`dash/stage/contacts/${run.staged}`, buffer);
    run.staged++; buffer = [];
  };
  for (let page = 0; page < envInt(env, 'DASH_MAX_CONTACT_PAGES', 2000); page++) {
    if (outOfTime(90000)) { await stage(); await flushSeen(); return false; }
    const r = await contactPage(request, env, run.cursor);
    buffer.push(...r.rows.map(compact));
    if (buffer.length >= CHUNK) await stage();
    run.cursor = r.next;
    if (!r.next) break;
  }
  await stage();
  await flushSeen();
  const rows = [];
  for (let i = 0; i < run.staged; i++) rows.push(...((await store.get(`dash/stage/contacts/${i}`, { type: 'json' })) || []));
  for (let i = 0; i < run.staged; i++) await store.delete?.(`dash/stage/contacts/${i}`);
  await saveSet(store, 'contacts', mergeById([], rows), { newest: maxDate(rows), fullAt: new Date(now).toISOString() });
  run.cursor = null; run.staged = 0;
  return true;
}
const maxDate = rows => rows.reduce((a, c) => (c.da && c.da > a ? c.da : a), '');

async function callsPhase({ store, env, fetchImpl, run, now, windowStart, agents, warn }) {
  if (!/^AC[0-9a-fA-F]{32}$/.test(env.TWILIO_ACCOUNT_SID || '') || !env.TWILIO_AUTH_TOKEN) { warn('Twilio not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN): no Twilio dials.'); return; }
  const { manifest, rows: old } = await loadSet(store, 'twilio');
  const from = run.full || !manifest?.newest ? windowStart : new Date(Math.max(Date.parse(windowStart), Date.parse(manifest.newest) - 2 * DAY)).toISOString();
  const end = new Date(now).toISOString();
  const fresh = [];
  let cursor = null;
  await withEnv({ TWILIO_ACCOUNT_SID: env.TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN: env.TWILIO_AUTH_TOKEN }, async () => {
    for (let page = 0; page < envInt(env, 'DASH_MAX_TWILIO_PAGES', 200); page++) {
      const r = await fetchTwilioPage(from, cursor, end, { fetchImpl });
      fresh.push(...r.rows.map(slimTwilio));
      if (!r.next) break;
      cursor = r.next;
    }
  });
  const rows = mergeById(old, fresh, c => Date.parse(c.start_time || c.date_created) >= Date.parse(windowStart));
  const newest = rows.reduce((a, c) => { const t = new Date(c.start_time || c.date_created).toISOString(); return t > a ? t : a; }, manifest?.newest || '');
  await saveSet(store, 'twilio', rows, { newest });
  // Contact match by phone, rep by caller ID, then the dialer's signed-in owner per call SID.
  const { rows: contacts } = await loadSet(store, 'contacts');
  const matched = crossReferenceCalls(rows, contacts.map(c => ({ id: c.id, phone: c.p })), agents, windowStart, new Date(now + 60000).toISOString());
  const attributed = await withEnv({ DIALER_URL: env.DIALER_URL, DIALER_EXPORT_KEY: env.DIALER_EXPORT_KEY }, () => attributeDialerCalls(matched, agents, { fetchImpl, store, now }));
  warn(attributed.warning);
  await saveSet(store, 'calls', attributed.calls);
}

async function finalize({ store, run, now, windowStart }) {
  const [contacts, opps, sms, calls, tasks, appointments] = await Promise.all(['contacts', 'opportunities', 'sms', 'calls', 'tasks', 'appointments'].map(n => loadSet(store, n).then(s => s.rows)));
  const ref = run.ref || {};
  // normalize() is the dashboard's; contacts go in already compact, so it gets none and the contact fields are joined here.
  const base = normalize({ contacts: [], opportunities: opps, pipelines: ref.pipelines || [], users: ref.users || [], calls, sms: [], warnings: run.warnings, startDate: windowStart, appointments });
  const byId = new Map(contacts.map(c => [c.id, c]));
  for (const call of base.calls) { const c = byId.get(call.contactId); if (c) call.ln = c.n; }
  for (const o of base.opportunities) { const c = byId.get(o.contactId); if (c) { o.ln = c.n; o.tags = Array.isArray(c.t) ? c.t : String(c.t || '').split(',').map(s => s.trim()).filter(Boolean); o.phone = o.phone || c.p; } }
  const { normalizeSms } = await import('./dash/_sms.mjs');
  const smsRows = sms.map(m => { const c = byId.get(m.contactId); return normalizeSms(m, c ? { id: c.id, name: c.n, tags: c.t, dnd: c.dnd } : {}); });
  const data = { contacts, calls: base.calls, sms: smsRows, opportunities: base.opportunities, tasks, appointments: base.appointments,
    meta: { ...base.meta, mode: 'live', warnings: run.warnings, refreshedAt: new Date(now).toISOString(), windowStart, runId: run.id, full: run.full } };
  const derived = derive(data, ref.settings || {}, now);
  derived.meta = { mode: 'live', refreshedAt: data.meta.refreshedAt, windowStart, full: run.full, warnings: run.warnings, settingsFromDashboard: Boolean(ref.settings?.tagVisibility) };
  await store.setJSON('dash/derived', derived);
}
