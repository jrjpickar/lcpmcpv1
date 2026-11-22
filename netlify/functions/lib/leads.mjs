// Leads for Brain 3D: every GHL opportunity created in the selected Pacific date range, grouped by pipeline and by city.
// City comes from the contact's ZIP code tag (for example "90221", "zip 90221", "zip:90221"), not from opportunity value.
// ZIP to city: ZIP_CITY_MAP (JSON {"90221":"Compton"}) first, then a cached public ZIP lookup (api.zippopotam.us),
// then the contact's own city field, else "ZIP 90221". A light read on purpose: no SMS export, no lookback window,
// so it is not blocked by the heavier sales report timing out.
import Metrics from '../../../public/lcp-metrics.js';
import Sample from '../../../public/sample-data.js';
import { mode } from './sources.mjs';

const GHL_API = 'https://services.leadconnectorhq.com';
const env = (name, fallback = '') => process.env[name] || fallback;
const envInt = (name, fallback) => { const n = Number.parseInt(process.env[name] || '', 10); return Number.isFinite(n) && n > 0 ? n : fallback; };
const zipCities = new Map(); // ZIP -> city name or null (lookup failed), per function instance
let pipelineCache = null;
const cache = new Map();

function pacificMidnight(day) {
  const standard = Date.parse(day + 'T08:00:00Z');
  return new Date(Metrics.dayKey(standard - 3600000) === day ? standard - 3600000 : standard).toISOString();
}

// ZIP from tags. Tags that mention "zip" win; otherwise a tag that is only a 5 digit ZIP (optionally ZIP+4).
export function zipFromTags(tags = []) {
  const list = (Array.isArray(tags) ? tags : String(tags || '').split(',')).map(t => String(t || '').trim()).filter(Boolean);
  for (const tag of list) {
    const m = /zip(?:\s*code)?[\s:_#=-]*(\d{5})(?:-\d{4})?\b/i.exec(tag);
    if (m) return m[1];
  }
  for (const tag of list) {
    const m = /^(\d{5})(?:-\d{4})?$/.exec(tag);
    if (m) return m[1];
  }
  return null;
}

export function zipCityMap(raw = env('ZIP_CITY_MAP')) {
  try {
    const parsed = JSON.parse(raw || '{}');
    return Object.fromEntries(Object.entries(parsed).filter(([zip, city]) => /^\d{5}$/.test(zip) && typeof city === 'string' && city.trim()).map(([zip, city]) => [zip, city.trim()]));
  } catch { return {}; }
}

async function lookupZip(zip, fetchImpl, signal) {
  if (zipCities.has(zip)) return zipCities.get(zip);
  let city = null;
  try {
    const res = await fetchImpl('https://api.zippopotam.us/us/' + zip, { signal: AbortSignal.any([signal, AbortSignal.timeout(2500)]), headers: { accept: 'application/json' } });
    if (res.ok) {
      const place = (await res.json())?.places?.[0]?.['place name'];
      if (typeof place === 'string' && place.trim()) city = place.trim().replace(/\b\w/g, c => c.toUpperCase());
    } else await res.body?.cancel().catch(() => {});
  } catch { /* fall back below */ }
  zipCities.set(zip, city);
  if (zipCities.size > 3000) zipCities.delete(zipCities.keys().next().value);
  return city;
}

// Resolve city names for a set of ZIPs within the remaining budget. Unresolved ZIPs fall back to the contact city or "ZIP 12345".
export async function citiesForZips(zips, { fetchImpl = fetch, signal = AbortSignal.timeout(3000), map = zipCityMap() } = {}) {
  const out = {};
  const todo = [];
  for (const zip of zips) { if (map[zip]) out[zip] = map[zip]; else todo.push(zip); }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, todo.length) }, async () => {
    while (next < todo.length && !signal.aborted) { const zip = todo[next++]; out[zip] = await lookupZip(zip, fetchImpl, signal); }
  }));
  return out;
}

async function ghl(path, { fetchImpl, signal }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetchImpl(GHL_API + path, { signal, headers: { Accept: 'application/json', Authorization: 'Bearer ' + env('GHL_ACCESS_TOKEN'), Version: '2021-07-28' } });
    if (res.status === 429 || res.status >= 500) { await res.body?.cancel().catch(() => {}); await new Promise(r => setTimeout(r, 500 * (attempt + 1))); continue; }
    if (!res.ok) throw new Error('HTTP ' + res.status + ' on ' + path.split('?')[0]);
    return res.json();
  }
  throw new Error('rate limited on ' + path.split('?')[0]);
}

// Group opportunities (already filtered to the range) into pipelines and cities. Pure, used by live and sample paths.
export function summarize(opps, { zipOf, cityOfZip, contactCity = () => '' }) {
  const pipelines = new Map(), cities = new Map();
  let noZip = 0;
  for (const o of opps) {
    const pipe = o.pipeline || 'No pipeline';
    const p = pipelines.get(pipe) || { name: pipe, count: 0, stages: new Map() };
    p.count++; p.stages.set(o.stage || 'No stage', (p.stages.get(o.stage || 'No stage') || 0) + 1);
    pipelines.set(pipe, p);
    const zip = zipOf(o);
    if (!zip) noZip++;
    const city = zip ? (cityOfZip[zip] || contactCity(o) || 'ZIP ' + zip) : 'No ZIP tag';
    const c = cities.get(city) || { city, count: 0, zips: new Set(), byPipeline: {}, houses: [] };
    c.count++; if (zip) c.zips.add(zip);
    c.byPipeline[pipe] = (c.byPipeline[pipe] || 0) + 1;
    c.houses.push(pipe);
    cities.set(city, c);
  }
  const pipelineList = [...pipelines.values()].sort((a, b) => b.count - a.count)
    .map(p => ({ name: p.name, count: p.count, stages: [...p.stages].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) }));
  const cityList = [...cities.values()].sort((a, b) => (a.city === 'No ZIP tag') - (b.city === 'No ZIP tag') || b.count - a.count)
    .map(c => ({ city: c.city, count: c.count, zips: [...c.zips].sort(), byPipeline: c.byPipeline, houses: c.houses.slice(0, 40) }));
  return { total: opps.length, pipelines: pipelineList, cities: cityList, noZip };
}

export async function loadLeads({ from, to, rep = '', fetchImpl = fetch } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '') || from > to) throw Object.assign(new Error('Use from and to as YYYY-MM-DD.'), { status: 400 });
  const startMs = Date.parse(pacificMidnight(from)), endMs = Date.parse(pacificMidnight(Metrics.shiftDay(to, 1)));
  const range = { from, to, rep: rep || null };
  const inRange = o => { const t = Date.parse(o.createdAt); return t >= startMs && t < endMs && (!rep || o.rep === rep); };

  if (mode() === 'sample') {
    const data = Sample.generate();
    const contacts = Object.fromEntries((data.contacts || []).map(c => [c.id, c]));
    const opps = data.opportunities.filter(inRange);
    const zips = [...new Set(opps.map(o => contacts[o.contactId]?.zip).filter(Boolean))];
    const cityOfZip = Object.fromEntries(zips.map(zip => [zip, (data.contacts.find(c => c.zip === zip) || {}).city || null]));
    return { range, source: 'sample', loadedAt: new Date().toISOString(), warnings: [], ...summarize(opps, { zipOf: o => contacts[o.contactId]?.zip || null, cityOfZip }) };
  }
  if (!env('GHL_ACCESS_TOKEN') || !env('GHL_LOCATION_ID')) return { range, configured: false, warnings: ['Set GHL_ACCESS_TOKEN and GHL_LOCATION_ID.'] };

  const key = [from, to, rep].join('|');
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < envInt('CACHE_SECONDS', 300) * 1000) return hit.data;

  const started = Date.now(), budgetMs = Math.min(9000, envInt('LEADS_BUDGET_MS', 8000));
  // Opportunity pages get the budget minus 1.5 s, kept for ZIP to city lookups.
  const budget = AbortSignal.timeout(Math.max(1000, budgetMs - 1500));
  const warnings = [];
  const location = encodeURIComponent(env('GHL_LOCATION_ID'));
  if (!pipelineCache || Date.now() - pipelineCache.at > 600000) {
    try {
      const payload = await ghl('/opportunities/pipelines?locationId=' + location, { fetchImpl, signal: budget });
      pipelineCache = { at: Date.now(), map: Object.fromEntries((payload.pipelines || []).map(p => [p.id, { name: p.name, stages: Object.fromEntries((p.stages || []).map(s => [s.id, s.name])) }])) };
    } catch (error) { warnings.push('GHL pipelines: ' + error.message); pipelineCache ||= { at: 0, map: {} }; }
  }
  const pipes = pipelineCache.map;
  const users = {};
  try {
    const payload = await ghl('/users/?locationId=' + location, { fetchImpl, signal: budget });
    for (const u of payload.users || []) users[u.id] = u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || u.id;
  } catch { /* rep filter falls back to IDs */ }

  // Opportunities newest first; stop at the first page that reaches before the range.
  const opps = [];
  let cursor = null, complete = false;
  try {
    for (let page = 0; page < envInt('GHL_MAX_OPP_PAGES', 60); page++) {
      const params = new URLSearchParams({ location_id: env('GHL_LOCATION_ID'), status: 'all', limit: '100', order: 'added_desc' });
      if (cursor) { params.set('start_after', cursor.startAfter); params.set('start_after_id', cursor.startAfterId); }
      const payload = await ghl('/opportunities/search?' + params, { fetchImpl, signal: budget });
      const rows = payload.opportunities || [];
      let older = false;
      for (const o of rows) {
        const createdAt = o.createdAt || o.dateAdded;
        if (Date.parse(createdAt) < startMs) { older = true; continue; }
        opps.push({ id: o.id, createdAt, contactId: o.contactId || o.contact?.id || '', tags: o.contact?.tags || o.tags || [],
          pipeline: pipes[o.pipelineId]?.name || o.pipelineName || o.pipelineId || '', stage: pipes[o.pipelineId]?.stages?.[o.pipelineStageId] || o.pipelineStageName || '',
          rep: users[o.assignedTo] || o.assignedTo || 'Unassigned' });
      }
      if (older || rows.length < 100 || !payload.meta?.startAfterId) { complete = true; break; }
      cursor = { startAfter: String(payload.meta.startAfter), startAfterId: payload.meta.startAfterId };
    }
  } catch (error) { warnings.push('GHL opportunities: ' + (budget.aborted ? 'time limit reached, counts may be partial' : error.message)); }
  if (!complete && !warnings.length) warnings.push('GHL opportunities: page limit reached, counts may be partial');
  const scoped = opps.filter(inRange);

  // Contacts without a ZIP tag in the search payload: read their tags and postal code (bounded).
  const contactInfo = {};
  const missing = [...new Set(scoped.filter(o => !zipFromTags(o.tags) && o.contactId).map(o => o.contactId))].slice(0, envInt('LEADS_MAX_CONTACT_LOOKUPS', 150));
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, missing.length) }, async () => {
    while (next < missing.length && !budget.aborted) {
      const id = missing[next++];
      try {
        const c = await ghl('/contacts/' + encodeURIComponent(id), { fetchImpl, signal: budget }).then(p => p.contact || p);
        contactInfo[id] = { zip: zipFromTags(c.tags) || (/^\d{5}/.exec(String(c.postalCode || ''))?.[0] ?? null), city: c.city || '' };
      } catch { /* left without ZIP */ }
    }
  }));
  const zipOf = o => zipFromTags(o.tags) || contactInfo[o.contactId]?.zip || null;
  const zips = [...new Set(scoped.map(zipOf).filter(Boolean))];
  const remaining = Math.max(400, budgetMs - (Date.now() - started) - 200);
  const cityOfZip = await citiesForZips(zips, { fetchImpl, signal: AbortSignal.timeout(remaining) });
  const data = { range, source: 'GHL opportunities (created in range)', loadedAt: new Date().toISOString(), warnings, complete,
    ...summarize(scoped, { zipOf, cityOfZip, contactCity: o => contactInfo[o.contactId]?.city || '' }) };
  if (!warnings.length) { cache.set(key, { at: Date.now(), data }); if (cache.size > 20) cache.delete(cache.keys().next().value); }
  return data;
}
