import { reportingAgentId } from './_agent-aliases.mjs';

const callSid = call => {
  const sid = call.sid || call.id;
  return /^CA[0-9a-f]{32}$/i.test(sid || '') ? 'CA' + sid.slice(2).toLowerCase() : '';
};
async function loadOwnership(calls, agents, { fetchImpl = fetch, store, now = Date.now() } = {}) {
  if (!process.env.DIALER_URL || !process.env.DIALER_EXPORT_KEY) return { calls, warning: 'Signed-in call attribution is not connected; caller-ID mappings are in use.' };
  const ownership = new Map();
  const missing = new Set();
  const groups = new Map();
  for (const call of calls) {
    const sid = callSid(call);
    if (!sid) continue;
    const day = String(call.dateAdded || call.co || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    if (!groups.has(day)) groups.set(day, { owners: {}, checked: {}, sids: new Set() });
    groups.get(day).sids.add(sid);
  }
  const sidDays = new Map();
  for (const [day, group] of groups) {
    const cached = store ? await store.get(`dialer-ownership-days/${day}`, { type: 'json' }) : null;
    Object.assign(group.owners, cached?.owners || {});
    Object.assign(group.checked, cached?.checked || {});
    const live = now - Date.parse(day + 'T00:00:00Z') < 3 * 86400000;
    const retryAfter = live ? 90000 : 7 * 86400000;
    for (const sid of group.sids) {
      sidDays.set(sid, day);
      if (group.owners[sid]) ownership.set(sid, group.owners[sid]);
      else if (!group.checked[sid] || now - group.checked[sid] > retryAfter) missing.add(sid);
    }
  }
  let warning = '';
  const started = Date.now();
  const pending = [...missing].filter(sid => !ownership.has(sid));
  for (let i = 0; i < pending.length; i += 500) {
    if (Date.now() - started > 45000) { warning = 'Some call ownership is still loading; caller-ID mappings remain in use for those calls.'; break; }
    const sids = pending.slice(i, i + 500);
    try {
      const response = await fetchImpl(`${process.env.DIALER_URL.replace(/\/+$/, '')}/api/dashboard/call-ownership`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-dashboard-key': process.env.DIALER_EXPORT_KEY },
        body: JSON.stringify({ sids }), signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Dialer call ownership export returned HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.calls)) throw new Error('Dialer call ownership response is invalid');
      const requested = new Set(sids);
      for (const row of payload.calls) {
        const sid = callSid(row);
        if (requested.has(sid) && row.userId) ownership.set(sid, row);
      }
      for (const sid of sids) {
        const group = groups.get(sidDays.get(sid));
        group.checked[sid] = now;
        if (ownership.has(sid)) group.owners[sid] = ownership.get(sid);
        group.dirty = true;
      }
    } catch (error) { warning = `${error.message}; caller-ID mappings remain in use where signed-in ownership is unavailable.`; break; }
  }
  if (store) for (const [day, group] of groups) if (group.dirty) {
    try {
      await store.setJSON(`dialer-ownership-days/${day}`, { owners: group.owners, checked: group.checked });
    } catch {
      warning ||= 'Call ownership was loaded but could not be cached.';
    }
  }
  return { warning, calls: calls.map(call => {
    const owner = ownership.get(callSid(call));
    if (!owner) return call;
    return { ...call, userId: reportingAgentId(owner.userId), sourceUserId: owner.userId, sessionAgentName: owner.agent || '',
      attributionSource: 'dialer-session' };
  }) };
}

export async function attributeDialerCalls(calls, agents, options = {}) {
  try { return await loadOwnership(calls, agents, options); }
  catch (error) { return { calls, warning: `Signed-in call attribution is unavailable (${error.message}); caller-ID mappings remain in use.` }; }
}

// Flex-number calls (shared numbers) that still have no signed-in dialer owner. These show
// as Unknown caller, so the dashboard says how many and why instead of hiding them.
export function flexWithoutSession(calls) {
  return calls.filter(call => call.flexNumber && call.attributionSource !== 'dialer-session').length;
}
export function flexWarning(count, attributionWarning = '') {
  const cause = !process.env.DIALER_URL || !process.env.DIALER_EXPORT_KEY
    ? 'Set DIALER_URL and DIALER_EXPORT_KEY on the dashboard (DASHBOARD_EXPORT_KEY on the dialer) to connect signed-in attribution.'
    : attributionWarning ? 'The dialer ownership export did not answer for all calls; they are retried on the next refresh.'
    : 'The dialer has no signed-in owner saved for these calls (placed before signed-in attribution, or not placed by the dialer).';
  return `${count} flex-number calls have no signed-in rep and show as Unknown caller. ${cause}`;
}
