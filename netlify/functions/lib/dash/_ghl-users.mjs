// GHL location users, so a new HighLevel user shows by name on the board
// without a code change or an AGENT_ASSIGNMENTS edit.
// Needs the users.readonly scope on GHL_ACCESS_TOKEN. Without it the board
// keeps working with the AGENT_ASSIGNMENTS names only.
import { ghl, rowsFrom } from './_ghl.mjs';
import { reportingAgentId } from './_agent-aliases.mjs';

const KEY = 'ghl-users';
const MAX_AGE_MS = 6 * 3600000;

const displayName = u => String(u.name || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.email || '').trim();

export async function fetchLocationUsers({ request = ghl, locationId = process.env.GHL_LOCATION_ID } = {}) {
  if (!locationId) throw new Error('Missing GHL_LOCATION_ID.');
  const payload = await request(`/users/?locationId=${encodeURIComponent(locationId)}`, { version: '2021-07-28' });
  return rowsFrom(payload, 'users').map(u => ({ id: u.id, name: displayName(u) })).filter(u => u.id && u.name);
}

// Cached for 6 hours. A failed lookup returns the last saved list (or none)
// with a warning; it never blocks a sync or a task refresh.
export async function locationUsers(store, { now = Date.now(), maxAgeMs = MAX_AGE_MS, request } = {}) {
  let saved = null;
  try { saved = await store.get(KEY, { type: 'json' }); } catch { saved = null; }
  if (saved?.users && now - (saved.fetchedAt || 0) < maxAgeMs) return { users: saved.users, warning: '' };
  try {
    const users = await fetchLocationUsers(request ? { request } : {});
    await store.setJSON(KEY, { users, fetchedAt: now });
    return { users, warning: '' };
  } catch (error) {
    return { users: saved?.users || [], warning: `GHL user names unavailable (${error.message}); new users show by ID until users.readonly is granted.` };
  }
}

// Roster (AGENT_ASSIGNMENTS) names win; GHL adds any user the roster lacks.
// Alt account IDs are skipped so they keep reporting under their primary.
export function mergeUsers(agents = [], users = []) {
  const out = new Map();
  for (const a of agents) if (a.ghlUserId && a.name && !out.has(a.ghlUserId)) out.set(a.ghlUserId, { id: a.ghlUserId, name: a.name });
  for (const u of users) {
    if (!u.id || out.has(u.id) || reportingAgentId(u.id) !== u.id) continue;
    out.set(u.id, { id: u.id, name: u.name });
  }
  return [...out.values()];
}
