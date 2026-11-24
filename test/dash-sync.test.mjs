import test from 'node:test';
import assert from 'node:assert/strict';
import { runDashSync, loadSet } from '../netlify/functions/lib/dash-sync.mjs';
import { derive } from '../netlify/functions/lib/dash-derived.mjs';
import { generateDashSample } from '../netlify/functions/lib/dash-sample.mjs';

const memoryStore = () => {
  const m = new Map();
  return {
    m,
    async get(key) { return m.has(key) ? structuredClone(m.get(key)) : null; },
    async setJSON(key, value, c = {}) { if (c.onlyIfNew && m.has(key)) return { modified: false }; m.set(key, structuredClone(value)); return { modified: true }; },
    async delete(key) { m.delete(key); },
  };
};

const NOW = Date.parse('2026-11-22T20:00:00Z'); // 12:00 PST
const iso = ms => new Date(ms).toISOString();
const SID = n => 'CA' + String(n).padStart(32, '0');

// Fake sources. Jesse's line +13236937212 and Frank's excluded line +13234176926 come from the dashboard roster.
function fakeSources({ contacts = 250 } = {}) {
  const log = [];
  const allContacts = Array.from({ length: contacts }, (_, i) => ({ id: 'ct' + String(i).padStart(8, '0'), firstName: 'Seller', lastName: String(i), phone: '+1213555' + String(i).padStart(4, '0'),
    tags: [i % 2 ? 'LA Tax Delinquent 2026-07' : 'Code Violation Q3', ...(i % 5 === 0 ? ['tired landlord'] : [])], dateAdded: iso(NOW - (i + 1) * 3600000 * 6), city: i % 3 ? 'Compton' : 'Lancaster',
    postalCode: i % 3 ? '90220' : '93535', address1: `${100 + i} Main St`, state: 'CA', source: 'PropStream', assignedTo: 'Dcc7H7rZQIwkLFNphrOc', customFields: [] }));
  const opps = [{ id: 'op1', contactId: allContacts[3].id, name: 'Seller 3', assignedTo: 'Dcc7H7rZQIwkLFNphrOc', pipelineId: 'fuUxmeFpmEOJev4OI37R', pipelineStageId: '2ebbfaf4-eceb-4e95-a56b-cc45d299bcca', status: 'open', createdAt: iso(NOW - 2 * 86400000) }];
  const twilio = [
    { sid: SID(1), direction: 'outbound-api', to: allContacts[3].phone, from: '+13236937212', status: 'completed', duration: '140', start_time: iso(NOW - 3 * 86400000), date_created: iso(NOW - 3 * 86400000) },
    { sid: SID(2), direction: 'outbound-api', to: allContacts[4].phone, from: '+13236937212', status: 'no-answer', duration: '0', start_time: iso(NOW - 3 * 86400000), date_created: iso(NOW - 3 * 86400000) },
    { sid: SID(3), direction: 'outbound-api', to: allContacts[5].phone, from: '+13234176926', status: 'completed', duration: '90', start_time: iso(NOW - 3 * 86400000), date_created: iso(NOW - 3 * 86400000) },
    { sid: SID(4), direction: 'inbound', to: '+13236937212', from: allContacts[6].phone, status: 'completed', duration: '30', start_time: iso(NOW - 3 * 86400000), date_created: iso(NOW - 3 * 86400000) },
  ];
  const sms = [{ id: 'm1', contactId: allContacts[3].id, direction: 'outbound', body: 'Are you the owner?', userId: 'Dcc7H7rZQIwkLFNphrOc', dateAdded: iso(NOW - 4 * 86400000), status: 'delivered' },
    { id: 'm2', contactId: allContacts[3].id, direction: 'inbound', body: 'Yes, what would you offer?', dateAdded: iso(NOW - 4 * 86400000 + 3600000), status: 'received' }];
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const method = init.method || 'GET';
    log.push({ host: url.host, path: url.pathname, method, auth: (init.headers?.Authorization || init.headers?.authorization || '').slice(0, 7) });
    if (url.host === 'services.leadconnectorhq.com') {
      const p = url.pathname;
      if (p === '/users/') return json({ users: [{ id: 'Dcc7H7rZQIwkLFNphrOc', name: 'Jesse Pickar' }] });
      if (p === '/opportunities/pipelines') return json({ pipelines: [{ id: 'fuUxmeFpmEOJev4OI37R', name: 'ACQ Pipeline', stages: [{ id: '2ebbfaf4-eceb-4e95-a56b-cc45d299bcca', name: 'New Lead' }] }] });
      if (p.endsWith('/customFields')) return json({ customFields: [{ id: 'cf1', name: 'Seller Temperature', model: 'contact' }] });
      if (p === '/contacts/search') {
        const body = JSON.parse(init.body);
        const start = body.searchAfter ? body.searchAfter[0] : 0;
        const rows = allContacts.slice(start, start + 100).map((c, i) => ({ ...c, searchAfter: [start + i + 1] }));
        return json({ contacts: rows, total: allContacts.length });
      }
      if (p === '/opportunities/search') return json({ opportunities: opps, meta: {} });
      if (p === '/conversations/messages/export') return json({ messages: sms, nextCursor: null });
      if (p.endsWith('/tasks/search')) { const body = JSON.parse(init.body); return json({ tasks: body.completed ? [] : [{ id: 'tk1', title: 'Call back', contactId: allContacts[3].id, assignedTo: 'Dcc7H7rZQIwkLFNphrOc', completed: false, dueDate: iso(NOW - 86400000), dateAdded: iso(NOW - 5 * 86400000) }] }); }
      if (p === '/calendars/') return json({ calendars: [{ id: 'cal1' }] });
      if (p === '/calendars/events') return json({ events: [{ id: 'ev1', contactId: allContacts[3].id, calendarId: 'cal1', appointmentStatus: 'showed', startTime: iso(NOW - 86400000), assignedUserId: 'Dcc7H7rZQIwkLFNphrOc' }] });
      return json({ message: 'not found ' + p }, 404);
    }
    if (url.host === 'api.twilio.com') return json({ calls: twilio, next_page_uri: null });
    if (url.host === 'dialer.example') return json({ calls: [] });
    if (url.host === 'dash.example') return json(url.searchParams.get('settings') === 'tag-visibility' ? { mode: 'include', tags: [], keywords: ['tax delinquent', 'code violation'], zipCodes: false } : { batches: {}, thresholds: { minWorked: 1 } });
    return json({}, 404);
  };
  return { fetchImpl, log, allContacts };
}

const ENV = { GHL_ACCESS_TOKEN: 'read-token', GHL_LOCATION_ID: 'loc1', TWILIO_ACCOUNT_SID: 'AC' + 'a'.repeat(32), TWILIO_AUTH_TOKEN: 'tw', DIALER_URL: 'https://dialer.example', DIALER_EXPORT_KEY: 'dk',
  DATA_DASHBOARD_URL: 'https://dash.example', DATA_DASHBOARD_KEY: 'k'.repeat(32), DASH_SYNC_DAYS: '60' };

test('dashboard sync reads every source read-only and publishes dashboard-rule metrics', async () => {
  const store = memoryStore();
  const { fetchImpl, log } = fakeSources();
  const result = await runDashSync({ store, env: ENV, fetchImpl, now: NOW });
  assert.equal(result.done, true, JSON.stringify(result));
  assert.equal(result.full, true, 'first run is a full pass');
  assert.deepEqual(result.warnings.filter(w => !w.includes('AGENT_ASSIGNMENTS')), [], 'no source failed');
  // Read only: GHL gets GETs plus the two search POSTs; Twilio and the dashboard only GETs; the dialer only its ownership export.
  for (const r of log) {
    if (r.host === 'services.leadconnectorhq.com' && r.method !== 'GET') assert.match(r.path, /^\/contacts\/search$|\/tasks\/search$/);
    if (['api.twilio.com', 'dash.example'].includes(r.host)) assert.equal(r.method, 'GET');
  }
  assert.ok(log.some(r => r.host === 'dash.example'), 'dashboard settings are read');
  const { rows: calls } = await loadSet(store, 'calls');
  assert.equal(calls.length, 3, 'inbound Twilio calls are skipped');
  const derived = await store.get('dash/derived');
  const t = derived.windows['30d'].totals;
  assert.equal(t.dials, 2, "Frank's excluded line is dropped, like the dashboard");
  assert.equal(t.answered, 1);
  assert.equal(derived.windows['30d'].reps[0].rep, 'Jesse Pickar');
  assert.equal(t.opportunitiesByPipeline['ACQ Pipeline'], 1);
  assert.equal(derived.windows['30d'].funnel.qualified, 1);
  assert.equal(derived.windows['30d'].tasks.overdue, 1);
  assert.equal(derived.windows['30d'].appointments.showed, 1);
  assert.equal(derived.meta.settingsFromDashboard, true);
  // Tag visibility from the dashboard: only the two list tags are batches, so "tired landlord" is not a list.
  assert.deepEqual(derived.marketing['90d'].lists.rows.map(r => r.batch).filter(b => b !== 'Unattributed').sort(), ['Code Violation Q3', 'LA Tax Delinquent 2026-07']);
  assert.ok(derived.marketing['90d'].zips.rows.some(r => r.key === '90220'));
  assert.ok((await store.get('lead-intel/first-seen'))[('ct' + '00000003')].t.includes('LA Tax Delinquent 2026-07'), 'original tags are kept');
});

test('later runs are incremental: new contacts only, 2-day SMS and Twilio windows', async () => {
  const store = memoryStore();
  const first = fakeSources();
  await runDashSync({ store, env: ENV, fetchImpl: first.fetchImpl, now: NOW });
  const second = fakeSources();
  const result = await runDashSync({ store, env: ENV, fetchImpl: second.fetchImpl, now: NOW + 30 * 60000 });
  assert.equal(result.full, false);
  const contactPages = second.log.filter(r => r.path === '/contacts/search').length;
  assert.equal(contactPages, 1, 'stops at the first page of already known contacts');
  assert.equal((await loadSet(store, 'contacts')).rows.length, 250);
});

test('a full pass that runs out of time continues where it stopped', async () => {
  const store = memoryStore();
  const { fetchImpl } = fakeSources({ contacts: 450 });
  let calls = 0;
  const slow = async (...a) => { calls++; if (String(a[0]).includes('/contacts/search')) await new Promise(r => setTimeout(r, 40)); return fetchImpl(...a); };
  const first = await runDashSync({ store, env: ENV, fetchImpl: slow, now: NOW, budgetMs: 90000 + 100 });
  assert.equal(first.more, true);
  assert.equal(first.phase, 'contacts');
  const second = await runDashSync({ store, env: ENV, fetchImpl, now: NOW + 60000 });
  assert.equal(second.done, true);
  assert.equal((await loadSet(store, 'contacts')).rows.length, 450);
  assert.ok(calls > 0);
});

test('sync is off in sample mode or without GHL', async () => {
  assert.deepEqual(await runDashSync({ store: memoryStore(), env: { DATA_MODE: 'sample', GHL_ACCESS_TOKEN: 'x', GHL_LOCATION_ID: 'y' } }), { skipped: 'GHL not configured or DATA_MODE=sample' });
});

test('marketing recommendations are evidence based and respect sample floors', () => {
  const now = Date.parse('2026-11-22T20:00:00Z');
  const d = derive(generateDashSample({ now }), {}, now);
  const m = d.marketing['90d'];
  assert.ok(m.recommendations.length > 3);
  for (const r of m.recommendations) {
    assert.ok(r.evidence && r.action && ['high', 'medium', 'low'].includes(r.confidence));
    assert.ok(r.worked > 0);
  }
  const zipRec = m.recommendations.find(r => r.area === 'zip' && r.status === 'Increase');
  const row = m.zips.rows.find(z => zipRec.action.endsWith(z.key));
  assert.ok(row.vsMedian >= 1.5 && !row.lowSample);
  assert.ok(m.recommendations.some(r => r.area === 'call timing'));
  assert.equal(m.timing.hours.length, 24);
  assert.ok(Object.keys(d.windows).includes('wtd'));
});

test('VM publishes each finished sync to the Netlify site; the site accepts only the shared secret', async () => {
  const { createPublishHandler } = await import('../netlify/functions/dash-publish.mjs');
  const site = memoryStore();
  const secret = 's'.repeat(32);
  const handler = createPublishHandler({ env: { DASH_SYNC_SECRET: secret }, store: () => site });
  const { fetchImpl } = fakeSources();
  const posts = [];
  const both = async (input, init = {}) => {
    const url = String(input);
    if (url.startsWith('https://lcp.example/')) { posts.push(url); return handler(new Request(url, init)); }
    return fetchImpl(input, init);
  };
  const vmStore = memoryStore();
  const result = await runDashSync({ store: vmStore, env: { ...ENV, LCP_SITE_URL: 'https://lcp.example', DASH_SYNC_SECRET: secret }, fetchImpl: both, now: NOW });
  assert.equal(result.published, true, JSON.stringify(result.warnings));
  assert.deepEqual(posts, ['https://lcp.example/api/dash-publish']);
  assert.equal((await site.get('dash/derived')).windows['30d'].totals.dials, 2);
  assert.equal((await site.get('dash/state')).run.publishedFrom, 'vm');
  const bad = await handler(new Request('https://lcp.example/api/dash-publish', { method: 'POST', headers: { 'x-sync-secret': 'wrong-secret-value-123' }, body: '{}' }));
  assert.equal(bad.status, 401);
  // On Netlify itself nothing is posted.
  const netlifyRun = await runDashSync({ store: memoryStore(), env: { ...ENV, NETLIFY: 'true', LCP_SITE_URL: 'https://lcp.example', DASH_SYNC_SECRET: secret }, fetchImpl: both, now: NOW });
  assert.equal(netlifyRun.published, false);
  assert.equal(posts.length, 1);
});
