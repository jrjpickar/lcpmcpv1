import { REPORTING_PHONES, isFlexCall } from './_reporting-roster.mjs';
import { reportingAgentId } from './_agent-aliases.mjs';
// Read-only Twilio ingestion. Credentials never leave the server.
export function agentAssignments(raw = process.env.AGENT_ASSIGNMENTS) {
  let rows;
  try { rows = JSON.parse(raw || '[]'); } catch { throw new Error('AGENT_ASSIGNMENTS must be valid JSON.'); }
  if (!Array.isArray(rows) || !rows.length) throw new Error('Copy AGENT_ASSIGNMENTS from the dialer to map Twilio calls to reps.');
  for (const row of rows) {
    if (!row.ghlUserId || !row.name || !/^\+[1-9]\d{7,14}$/.test(row.twilioPhoneNumber || '')) throw new Error('Each agent needs ghlUserId, name, and an E.164 twilioPhoneNumber.');
  }
  return rows;
}
export function phoneKey(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length === 10 ? `+1${digits}` : digits.length >= 11 ? `+${digits}` : '';
}
// at: the call's time. Flex numbers are shared, so after FLEX_SINCE they map to nobody
// (the dialer's signed-in ownership export attributes those calls).
export function callerIdAssignment(number, agents, at) {
  if (isFlexCall(number, at)) return { userId: '', sourceUserId: '', flexNumber: true };
  const known = REPORTING_PHONES[number];
  const reps = number ? agents.filter(a => phoneKey(a.twilioPhoneNumber) === number) : [];
  const repIds = [...new Set(reps.map(a => reportingAgentId(a.ghlUserId)))];
  return { userId: known?.id || (repIds.length === 1 ? repIds[0] : ''), sourceUserId: reps.length === 1 ? reps[0].ghlUserId : '' };
}
export async function fetchTwilioPage(start, cursor, end, { fetchImpl = fetch, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  const account = process.env.TWILIO_ACCOUNT_SID;
  const secret = process.env.TWILIO_AUTH_TOKEN;
  if (!/^AC[0-9a-fA-F]{32}$/.test(account || '') || !secret) throw new Error('Configure TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN for the dialer account.');
  const base = `/2010-04-01/Accounts/${account}/Calls.json`;
  // Twilio filters by UTC date; exact timezone-aware boundaries are applied below.
  const params = new URLSearchParams({ PageSize: '1000', 'StartTime>': start.slice(0, 10), 'StartTime<': new Date(Date.parse(end) + 86400000).toISOString().slice(0, 10) });
  const path = cursor || `${base}?${params}`;
  if (!path.startsWith(`${base}?`)) throw new Error('Invalid Twilio pagination path.');
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetchImpl(`https://api.twilio.com${path}`, { signal: AbortSignal.timeout(30000), headers: { Authorization: `Basic ${Buffer.from(`${account}:${secret}`).toString('base64')}` } });
    if ((response.status === 429 || response.status >= 500) && attempt < 3) { await response.text(); await sleep(1000 * 2 ** attempt); continue; }
    if (!response.ok) { const error = new Error(`Twilio call import failed (${response.status}). Check account access.`); error.status = response.status; throw error; }
    const payload = await response.json();
    if (!Array.isArray(payload.calls)) throw new Error('Twilio response missing calls; snapshot was not published.');
    // Keep all page records for pagination progress; filter the reporting window at normalization.
    return { rows: payload.calls.map(c => ({ ...c, id: c.sid })), next: payload.next_page_uri || null };
  }
}
export function crossReferenceCalls(calls, contacts, agents, start, end) {
  const byPhone = new Map();
  for (const c of contacts) { const key = phoneKey(c.phone); if (key) byPhone.set(key, [...(byPhone.get(key) || []), c]); }
  return calls.filter(c => {
    const time = Date.parse(c.start_time || c.date_created);
    return String(c.direction).startsWith('outbound') && /^\+[1-9]\d{7,14}$/.test(c.to || '') && time >= Date.parse(start) && time < Date.parse(end);
  }).map(c => {
    const callerNumber = phoneKey(c.from);
    const matches = byPhone.get(phoneKey(c.to)) || [];
    return { id: c.sid, direction: 'outbound', ...callerIdAssignment(callerNumber, agents, c.start_time || c.date_created),
      callerNumber, contactId: matches.length === 1 ? matches[0].id : '', leadPhone: c.to,
      matchConfidence: matches.length === 1 ? 'matched' : matches.length > 1 ? 'ambiguous' : 'unmatched',
      status: c.status, duration: Number(c.duration || 0), dateAdded: new Date(c.start_time || c.date_created).toISOString(),
      updatedAt: c.date_updated, source: 'twilio', answeredBy: c.answered_by || null };
  });
}
