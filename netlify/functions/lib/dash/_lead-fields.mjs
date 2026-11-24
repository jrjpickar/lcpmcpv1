// Seller-qualification fields, contact ownership, appointments and original
// source batch for the Leads page. Read-only against GHL.
import { ghl, rowsFrom } from './_ghl.mjs';
import { reportingAgentId } from './_agent-aliases.mjs';
import { normalizeTags } from './_sms.mjs';

// "Qualified" = verified ownership + condition, timeline, motivation and price
// expectations recorded. Each key maps to one GHL contact custom field.
export const QUALIFICATION_KEYS = ['ownership', 'condition', 'timeline', 'motivation', 'price'];
// Extra contact fields read for the Leads page, including dated qualification signals.
// apn / county / propertyType feed the Opportunity Density page's property
// identity (APN scoped to county) and filters. All optional.
export const EXTRA_FIELD_KEYS = ['temperature', 'apn', 'county', 'propertyType', 'qualifiedAt', 'qualifiedBy', 'rawOppsAddedAt', 'rawOppsAddedBy'];
const AUTO_DETECT = {
  ownership: /owner(ship)?\s*(verified|confirmed|status)|verified\s*owner|is\s*(the\s*)?owner|decision\s*maker/i,
  condition: /condition|repairs?|rehab/i,
  timeline: /timeline|time\s*frame|when.*(sell|move|close)|move\s*out/i,
  motivation: /motivation|reason.*sell|why.*sell|situation/i,
  price: /asking|price\s*expect|expected\s*price|seller.*price|desired\s*price|how\s*much|price/i,
  temperature: /temperature|lead\s*temp|seller\s*temp|^temp$|heat/i,
  apn: /(^|[^a-z])(apn|ain)([^a-z]|$)|parcel\s*(number|no|id|#)?|assessor'?s?\s*(parcel|id|number)/i,
  county: /(^|[^a-z])county([^a-z]|$)/i,
  propertyType: /property\s*type|prop\s*type|land\s*use|property\s*use/i,
};

// QUALIFICATION_FIELDS (optional env JSON) pins each key to a custom field by
// id, fieldKey ("contact.asking_price") or exact name. Unpinned keys are
// auto-detected by field name; anything still unresolved is reported as
// missing so the dashboard shows "Incomplete data" instead of zero qualified.
export function resolveQualificationFields(definitions = [], raw = process.env.QUALIFICATION_FIELDS) {
  let pinned = {};
  const warnings = [];
  if (raw) {
    try { pinned = JSON.parse(raw) || {}; } catch { warnings.push('QUALIFICATION_FIELDS is not valid JSON; auto-detecting fields by name.'); }
  }
  const contactFields = definitions.filter(f => f && f.id && (!f.model || f.model === 'contact'));
  const fields = {};
  const used = new Set();
  const keys = [...EXTRA_FIELD_KEYS, ...QUALIFICATION_KEYS];
  for (const key of keys) {
    const want = pinned[key];
    if (want) {
      const target = String(want).trim().toLowerCase();
      const hit = contactFields.find(f => [f.id, f.fieldKey, f.name].some(v => String(v || '').trim().toLowerCase() === target));
      if (hit) { fields[key] = { id: hit.id, name: hit.name || hit.fieldKey || hit.id, source: 'env' }; used.add(hit.id); continue; }
      warnings.push(`QUALIFICATION_FIELDS.${key} ("${want}") does not match a contact custom field.`);
    }
  }
  for (const key of keys) {
    if (fields[key]) continue;
    // Qualification events must use a specifically named or pinned field.
    const exact = { qualifiedAt: 'first qualified at', qualifiedBy: 'first qualified by', rawOppsAddedAt: 'raw opps added at', rawOppsAddedBy: 'raw opps added by' }[key];
    const hit = contactFields.find(f => !used.has(f.id) && (exact
      ? String(f.name || '').trim().toLowerCase().replace(/[-_]+/g, ' ') === exact
      : AUTO_DETECT[key].test(`${f.name || ''} ${f.fieldKey || ''}`)));
    if (hit) { fields[key] = { id: hit.id, name: hit.name || hit.fieldKey || hit.id, source: 'auto' }; used.add(hit.id); }
  }
  return { fields, missing: QUALIFICATION_KEYS.filter(k => !fields[k]), warnings };
}

function customFieldValues(contact = {}) {
  const out = new Map();
  const list = contact.customFields || contact.customField || [];
  if (Array.isArray(list)) {
    for (const f of list) {
      const id = f?.id || f?.fieldId;
      const value = f?.value ?? f?.fieldValue ?? f?.field_value;
      if (id) out.set(id, value);
    }
  } else if (list && typeof list === 'object') {
    for (const [id, value] of Object.entries(list)) out.set(id, value);
  }
  return out;
}

const filled = value => {
  if (value == null) return '';
  if (Array.isArray(value)) return value.map(filled).filter(Boolean).join(', ');
  if (typeof value === 'object') return '';
  return String(value).trim().slice(0, 200);
};

export function qualificationValues(contact, qualification) {
  const values = customFieldValues(contact);
  const q = {};
  for (const [key, field] of Object.entries(qualification?.fields || {})) {
    const value = filled(values.get(field.id));
    if (value) q[key] = value;
  }
  return q;
}

const nameOf = (c = {}) => c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Unknown';

// Compact contact row shared by the snapshot and the real-time webhook overlay.
export function compactContact(c = {}, qualification = null, firstSeen = null) {
  const tags = normalizeTags(c.tags);
  const row = {
    n: nameOf(c), p: c.phone || '', t: Array.isArray(c.tags) ? c.tags : (c.tags || ''), id: c.id,
    dnd: Boolean(c.dnd), smsDnd: Boolean(c.dnd || c.dndSettings?.SMS?.status === 'active'),
    updatedAt: c.dateUpdated || c.updatedAt || null,
  };
  if (c.assignedTo) row.o = reportingAgentId(c.assignedTo);
  if (c.dateAdded || c.createdAt) row.da = c.dateAdded || c.createdAt;
  if (c.source) row.src = String(c.source).slice(0, 120);
  // Property address: used only as an exact (normalized) property identity.
  const ad = { l: String(c.address1 || '').trim().slice(0, 120), c: String(c.city || '').trim().slice(0, 60), s: String(c.state || '').trim().slice(0, 30), z: String(c.postalCode || '').trim().slice(0, 12) };
  if (ad.l || ad.z) row.ad = ad;
  if (qualification) {
    const q = qualificationValues(c, qualification);
    if (Object.keys(q).length) row.q = q;
  }
  // Original source batch: tags as first seen by the dashboard. Only sent when
  // they differ from current tags (e.g. a batch tag was later removed).
  const seen = firstSeen?.t;
  if (Array.isArray(seen) && seen.join('\u0000') !== tags.join('\u0000')) row.ot = seen;
  return row;
}

export async function fetchCustomFieldDefinitions({ ghlImpl = ghl, locationId = process.env.GHL_LOCATION_ID } = {}) {
  const payload = await ghlImpl(`/locations/${encodeURIComponent(locationId)}/customFields?model=contact`, { version: '2021-07-28' });
  return rowsFrom(payload, 'customFields');
}

// GHL appointmentStatus "showed" is the only status counted as held.
export function normalizeAppointment(e = {}) {
  const repId = reportingAgentId(e.assignedUserId || e.userId || '');
  return {
    id: e.id, contactId: e.contactId || '', calendarId: e.calendarId || '',
    status: String(e.appointmentStatus || e.status || '').toLowerCase(),
    start: e.startTime ? new Date(e.startTime).toISOString() : null,
    repId, title: String(e.title || '').slice(0, 120),
    updatedAt: e.dateUpdated || e.updatedAt || null,
  };
}

// Newest month first, stopping at the deadline. Returns how far back coverage
// reached so the dashboard can flag appointment metrics outside it.
export async function fetchAppointments(startIso, endIso, { ghlImpl = ghl, locationId = process.env.GHL_LOCATION_ID, deadline = Date.now() + 60000 } = {}) {
  const calendars = rowsFrom(await ghlImpl(`/calendars/?locationId=${encodeURIComponent(locationId)}`, { version: '2021-04-15' }), 'calendars');
  const start = Date.parse(startIso), end = Date.parse(endIso);
  const events = new Map();
  let coveredFrom = end;
  const MONTH = 31 * 86400000;
  for (let to = end; to > start; to -= MONTH) {
    if (Date.now() > deadline) break;
    const from = Math.max(start, to - MONTH);
    for (const cal of calendars) {
      const params = new URLSearchParams({ locationId, calendarId: cal.id, startTime: String(from), endTime: String(to) });
      const payload = await ghlImpl(`/calendars/events?${params}`, { version: '2021-04-15' });
      for (const e of rowsFrom(payload, 'events')) if (e?.id) events.set(e.id, normalizeAppointment(e));
    }
    coveredFrom = from;
  }
  return { appointments: [...events.values()], coveredFrom: new Date(coveredFrom).toISOString(), complete: coveredFrom <= start, calendars: calendars.length };
}

// First-seen tags per contact, never overwritten. Preserves the original source
// batch when tags are later added or removed.
export async function updateFirstSeen(store, contacts, now = new Date().toISOString()) {
  const key = 'lead-intel/first-seen';
  const saved = (await store.get(key, { type: 'json' })) || {};
  let added = 0;
  for (const c of contacts) {
    if (!c?.id || saved[c.id]) continue;
    saved[c.id] = { t: normalizeTags(c.tags), at: now };
    added++;
  }
  if (added) await store.setJSON(key, saved);
  return saved;
}

// GHL does not record when Temperature was set. The dashboard stamps the first
// sync that sees a contact at Warm (wa) and never clears it, so a seller who
// later moves to Hot still counts as a warm lead once. Contacts already Warm
// on the very first run get wb (backlog, date unknown) and the board
// estimates their date. Mutates the compact contact rows in place.
export const isWarmTemperature = value => /^warm\b/i.test(String(value || '').trim());
export async function updateWarmSeen(store, rows, now = new Date().toISOString()) {
  const key = 'lead-intel/warm-seen';
  const saved = await store.get(key, { type: 'json' });
  const first = !saved;
  const seen = saved?.contacts || {};
  let added = 0;
  for (const row of rows) {
    if (!row?.id || seen[row.id] || !isWarmTemperature(row.q?.temperature)) continue;
    seen[row.id] = first ? { b: 1 } : { at: now };
    added++;
  }
  if (first || added) await store.setJSON(key, { initializedAt: saved?.initializedAt || now, contacts: seen });
  for (const row of rows) {
    const s = row?.id && seen[row.id];
    if (!s) continue;
    if (s.at) row.wa = s.at; else row.wb = 1;
  }
  return seen;
}
