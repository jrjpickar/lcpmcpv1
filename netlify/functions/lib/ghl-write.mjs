// lcp_create_opportunity: the only GHL write in this project. Same two-step flow as A2Z's Estimating Desk booking.
//   1. Preview (dryRun: true): validates, resolves pipeline/stage/user names, checks for an open opportunity on the same
//      contact and pipeline, and returns what would be created plus a SHA-256 hash of exactly that.
//   2. Confirm (dryRun: false): needs the same hash and a fresh UUID idempotency key. The preview is rebuilt live; if it
//      changed (or a duplicate appeared) nothing is written. A repeated key returns the first result and writes nothing.
// Only a person confirming in the LCP dashboard (Studio key) can write. Not listed on MCP; JARVIS can only prepare a preview.
// Token: GHL_WRITE_TOKEN (opportunities.write + opportunities.readonly + contacts.readonly). GHL_ACCESS_TOKEN stays read-only.
// Pipelines: ACQ and Retail only, unless GHL_WRITE_PIPELINES lists others (names or IDs, comma separated).
import { createHash } from 'node:crypto';

const API = 'https://services.leadconnectorhq.com';
const UUID = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export const writeEnabled = (env = process.env) => Boolean(env.GHL_WRITE_TOKEN?.trim() && env.GHL_LOCATION_ID?.trim()) || env.DATA_MODE === 'sample';

async function ghl(env, fetchImpl, path, { method = 'GET', body, version = '2021-07-28' } = {}) {
  const res = await fetchImpl(API + path, { method, redirect: 'error', signal: AbortSignal.timeout(9000), body: body ? JSON.stringify(body) : undefined,
    headers: { Accept: 'application/json', Authorization: 'Bearer ' + env.GHL_WRITE_TOKEN, Version: version, ...(body ? { 'Content-Type': 'application/json' } : {}) } });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { throw fail('GHL returned an invalid response.', 502); }
  if (!res.ok) throw fail(typeof data.message === 'string' ? 'GHL: ' + data.message.slice(0, 200) : 'GHL returned ' + res.status, res.status === 429 ? 429 : 502);
  return data;
}

export function checkArgs(args = {}) {
  const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  const out = { contactId: text(args.contactId, 64), pipeline: text(args.pipeline || 'ACQ Pipeline', 80), stage: text(args.stage, 80), name: text(args.name, 120),
    assignedTo: text(args.assignedTo, 80), monetaryValue: args.monetaryValue == null || args.monetaryValue === '' ? null : Number(args.monetaryValue) };
  if (!/^[A-Za-z0-9]{10,64}$/.test(out.contactId)) throw fail('contactId must be a GHL contact ID.');
  if (out.monetaryValue != null && (!Number.isFinite(out.monetaryValue) || out.monetaryValue < 0 || out.monetaryValue > 1e8)) throw fail('monetaryValue must be 0 to 100,000,000.');
  return out;
}

const allowedPipeline = (p, env) => {
  const list = String(env.GHL_WRITE_PIPELINES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const name = String(p.name || '').toLowerCase();
  return list.length ? list.includes(name) || list.includes(String(p.id).toLowerCase()) : /^(acq|retail)\b/.test(name);
};
export const previewHash = preview => createHash('sha256').update(JSON.stringify(preview)).digest('hex');

const SAMPLE_PIPELINES = [{ id: 'pACQ', name: 'ACQ Pipeline', stages: [{ id: 'sNew', name: 'New Lead' }, { id: 'sRun', name: 'Run Numbers' }] }, { id: 'pRET', name: 'Retail Pipeline', stages: [{ id: 'sRNew', name: 'New Lead' }] }];

export async function buildPreview(rawArgs, { env = process.env, fetchImpl = fetch } = {}) {
  const args = checkArgs(rawArgs);
  const sample = env.DATA_MODE === 'sample';
  const loc = encodeURIComponent(env.GHL_LOCATION_ID || 'sample');
  const pipelines = sample ? SAMPLE_PIPELINES : (await ghl(env, fetchImpl, `/opportunities/pipelines?locationId=${loc}`)).pipelines || [];
  const pipeline = pipelines.find(p => [p.id, p.name].some(v => String(v).toLowerCase() === args.pipeline.toLowerCase()));
  if (!pipeline) throw fail(`Pipeline "${args.pipeline}" not found.`);
  if (!allowedPipeline(pipeline, env)) throw fail(`Pipeline "${pipeline.name}" is not open for writes (GHL_WRITE_PIPELINES).`, 403);
  const stages = pipeline.stages || [];
  const stage = args.stage ? stages.find(s => [s.id, s.name].some(v => String(v).toLowerCase() === args.stage.toLowerCase())) : stages[0];
  if (!stage) throw fail(`Stage "${args.stage}" not found in ${pipeline.name}.`);
  const contact = sample ? { id: args.contactId, name: 'Sample Seller' } : (await ghl(env, fetchImpl, `/contacts/${encodeURIComponent(args.contactId)}`)).contact;
  if (!contact?.id) throw fail('Contact not found.', 404);
  const contactName = contact.contactName || contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || contact.id;
  let assigned = null;
  if (args.assignedTo) {
    const users = sample ? [{ id: 'u1', name: 'Jesse Pickar' }] : (await ghl(env, fetchImpl, `/users/?locationId=${loc}`)).users || [];
    const hit = users.find(u => [u.id, u.name, u.email, [u.firstName, u.lastName].filter(Boolean).join(' ')].some(v => v && String(v).toLowerCase() === args.assignedTo.toLowerCase()));
    if (!hit) throw fail(`User "${args.assignedTo}" not found.`);
    assigned = { id: hit.id, name: hit.name || [hit.firstName, hit.lastName].filter(Boolean).join(' ') };
  }
  const existing = sample ? [] : ((await ghl(env, fetchImpl, `/opportunities/search?location_id=${loc}&contact_id=${encodeURIComponent(contact.id)}&pipeline_id=${encodeURIComponent(pipeline.id)}&status=open`)).opportunities || []);
  return {
    contact: { id: contact.id, name: contactName },
    pipeline: { id: pipeline.id, name: pipeline.name }, stage: { id: stage.id, name: stage.name },
    name: args.name || contactName, assignedTo: assigned, monetaryValue: args.monetaryValue,
    duplicate: existing.length ? { id: existing[0].id, name: existing[0].name, stage: (stages.find(s => s.id === existing[0].pipelineStageId) || {}).name || '' } : null,
  };
}

// store: { get(key, {type:'json'}), setJSON(key, value, { onlyIfNew }) }
export async function createOpportunity({ dryRun, args, hash, idempotencyKey, actor = 'dashboard' }, { env = process.env, fetchImpl = fetch, store, now = Date.now() } = {}) {
  if (!writeEnabled(env)) throw fail('GHL writes are off. Set GHL_WRITE_TOKEN to enable lcp_create_opportunity.', 503);
  const preview = await buildPreview(args, { env, fetchImpl });
  const digest = previewHash(preview);
  if (dryRun) return { status: preview.duplicate ? 'duplicate' : 'ready', preview, hash: digest };
  if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) throw fail('Confirm needs the preview hash.');
  if (typeof idempotencyKey !== 'string' || !UUID.test(idempotencyKey)) throw fail('Confirm needs a UUID idempotency key.');
  const key = 'ghl-write/' + idempotencyKey.toLowerCase();
  const prior = await store.get(key, { type: 'json' });
  if (prior) return { ...prior, replay: true };
  if (hash !== digest) throw fail('The opportunity changed since the preview. Preview again.', 409);
  if (preview.duplicate) throw fail(`${preview.contact.name} already has an open ${preview.pipeline.name} opportunity (${preview.duplicate.name}).`, 409);
  const claimed = await store.setJSON(key, { status: 'pending', at: new Date(now).toISOString() }, { onlyIfNew: true });
  if (claimed && claimed.modified === false) return { ...(await store.get(key, { type: 'json' })), replay: true };
  let created;
  if (env.DATA_MODE === 'sample') created = { id: 'sample-opp-' + idempotencyKey.slice(0, 8) };
  else {
    const body = { locationId: env.GHL_LOCATION_ID, pipelineId: preview.pipeline.id, pipelineStageId: preview.stage.id, contactId: preview.contact.id, name: preview.name, status: 'open',
      ...(preview.assignedTo ? { assignedTo: preview.assignedTo.id } : {}), ...(preview.monetaryValue != null ? { monetaryValue: preview.monetaryValue } : {}) };
    try { created = (await ghl(env, fetchImpl, '/opportunities/', { method: 'POST', body })).opportunity || {}; }
    catch (error) { await store.setJSON(key, { status: 'failed', error: error.message, at: new Date(now).toISOString() }); throw error; }
  }
  const result = { status: 'created', opportunityId: created.id || null, preview, actor, at: new Date(now).toISOString() };
  await store.setJSON(key, result);
  const log = (await store.get('ghl-write/log', { type: 'json' })) || { entries: [] };
  log.entries.unshift({ at: result.at, actor, opportunityId: result.opportunityId, contact: preview.contact.name, pipeline: preview.pipeline.name, stage: preview.stage.name });
  log.entries.length = Math.min(log.entries.length, 50);
  await store.setJSON('ghl-write/log', log);
  return result;
}

// Supabase and VM stores expose getWithMetadata; Netlify Blobs exposes get(key, { type }). Same calls either way.
export const kv = store => ({
  get: async key => (typeof store.get === 'function' ? store.get(key, { type: 'json' }) : (await store.getWithMetadata(key))?.data ?? null),
  setJSON: (key, value, condition) => store.setJSON(key, value, condition),
});
