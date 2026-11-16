import { setTimeout as delay } from 'node:timers/promises';
import Metrics from '../../../public/lcp-metrics.js';
import Sample from '../../../public/sample-data.js';
import { mode } from './sources.mjs';

const origin = 'https://api.twilio.com';
const timezone = 'America/Los_Angeles';
const cache = new Map();
const phone = /^\+[1-9]\d{7,14}$/;
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString().slice(0, 10) === value;
const problem = (message, status) => Object.assign(new Error(message), { status });
const emptyCounts = () => ({ calls: 0, conversations: 0, sms: 0, smsDelivered: 0 });

export function activityIsSample() {
  return process.env.DATA_MODE === 'sample' || (!process.env.TWILIO_ACCOUNT_SID && mode() === 'sample');
}

export function twilioCredentials(env) {
  const account = env.TWILIO_ACCOUNT_SID;
  if (!/^AC[a-f0-9]{32}$/i.test(account || '')) throw problem('Set TWILIO_ACCOUNT_SID on LCP MCP.', 503);
  const apiKey = env.TWILIO_API_KEY;
  const apiSecret = env.TWILIO_API_SECRET;
  if ((apiKey || apiSecret) && !(/^SK[a-f0-9]{32}$/i.test(apiKey || '') && apiSecret)) {
    throw problem('Set both TWILIO_API_KEY and TWILIO_API_SECRET on LCP MCP.', 503);
  }
  const secret = apiSecret || env.TWILIO_AUTH_TOKEN;
  if (!secret) throw problem('Set TWILIO_AUTH_TOKEN or the Twilio API key pair on LCP MCP.', 503);
  return { account, authorization: 'Basic ' + Buffer.from(`${apiKey || account}:${secret}`).toString('base64') };
}

function repAssignments(raw) {
  if (!raw) return new Map();
  let rows;
  try { rows = JSON.parse(raw); } catch { throw problem('AGENT_ASSIGNMENTS must be a JSON array.', 503); }
  if (!Array.isArray(rows)) throw problem('AGENT_ASSIGNMENTS must be a JSON array.', 503);
  const numbers = new Map();
  for (const row of rows) {
    const name = String(row?.name || '').trim();
    const number = row?.twilioPhoneNumber;
    if (!name || !phone.test(number || '')) continue;
    if (!numbers.has(number)) numbers.set(number, name);
    else if (numbers.get(number)?.toLowerCase() !== name.toLowerCase()) numbers.set(number, '');
  }
  return numbers;
}

const definitions = {
  calls: 'Outbound Twilio call records to phone numbers with a recorded start time, counted once per Call SID. Client and SIP destinations are excluded.',
  conversations: 'Outbound calls with Twilio duration greater than 60 seconds. This is a duration proxy.',
  sms: 'Outbound Twilio SMS with a recorded send time. Failed or queued messages without a send time, MMS and other channels are excluded.',
  smsDelivered: 'SMS with a delivered or read status.',
  rep: 'Rep filters match dedicated Twilio From numbers in AGENT_ASSIGNMENTS. Shared and unmapped numbers appear in all-rep totals only.',
};

async function fetchPage(url, authorization, deadline, fetchImpl) {
  for (let attempt = 0; ; attempt++) {
    const signal = AbortSignal.any([deadline, AbortSignal.timeout(10000)]);
    const response = await fetchImpl(url, { headers: { authorization, accept: 'application/json' }, signal, redirect: 'error' });
    if (response.ok || attempt >= 2 || (response.status !== 429 && response.status < 500)) return response;
    await response.body?.cancel();
    const retryAfter = Number(response.headers.get('retry-after'));
    await delay(retryAfter > 0 ? Math.min(3000, retryAfter * 1000) : 350 * 2 ** attempt, undefined, { signal: deadline });
  }
}

function windowsFor(range) {
  const windows = [];
  for (let from = range.from; from <= range.to; from = Metrics.shiftDay(from, 14)) {
    const end = Metrics.shiftDay(from, 13);
    windows.push({ from, to: end < range.to ? end : range.to });
  }
  return windows;
}

// Widen the provider bounds to UTC dates, then apply exact Pacific dates to each record.
async function readChannel(channel, range, auth, assigned, deadline, fetchImpl) {
  const isCall = channel === 'calls';
  const path = `/2010-04-01/Accounts/${auth.account}/${isCall ? 'Calls' : 'Messages'}.json`;
  const field = isCall ? 'StartTime' : 'DateSent';
  const params = new URLSearchParams({ PageSize: '1000', [field + '>']: range.from, [field + '<']: Metrics.shiftDay(range.to, 2) });
  const seen = new Set(), cursors = new Set(), days = new Map();
  let next = new URL(`${path}?${params}`, origin), pages = 0, warning = '';
  try {
    while (next && pages < 60) {
      if (next.origin !== origin || next.pathname !== path || cursors.has(next.href)) {
        throw new Error('Twilio returned an invalid pagination cursor.');
      }
      cursors.add(next.href);
      const response = await fetchPage(next, auth.authorization, deadline, fetchImpl);
      if (!response.ok) throw new Error(`Twilio ${isCall ? 'Calls' : 'Messages'} returned HTTP ${response.status}.`);
      const payload = await response.json();
      if (!Array.isArray(payload[channel])) throw new Error('Twilio returned an invalid page.');
      pages++;
      for (const row of payload[channel]) {
        const at = Date.parse(isCall ? row.start_time : row.date_sent);
        if (!row.sid || seen.has(row.sid) || !Number.isFinite(at) || !String(row.direction).startsWith('outbound') || !phone.test(row.to || '')) continue;
        if (!isCall && (!row.sid.startsWith('SM') || Number(row.num_media || 0) !== 0)) continue;
        const day = Metrics.dayKey(at);
        if (day < range.from || day > range.to) continue;
        seen.add(row.sid);
        const rep = assigned.get(row.from) || '';
        if (!days.has(day)) days.set(day, new Map());
        const reps = days.get(day);
        if (!reps.has(rep)) reps.set(rep, emptyCounts());
        const counts = reps.get(rep);
        if (isCall) {
          counts.calls++;
          if (Number(row.duration) > 60) counts.conversations++;
        } else {
          counts.sms++;
          if (['delivered', 'read'].includes(row.status)) counts.smsDelivered++;
        }
      }
      next = payload.next_page_uri ? new URL(payload.next_page_uri, origin) : null;
    }
    if (next) warning = 'Twilio page limit reached. Pick a shorter date range.';
  } catch (error) {
    warning = (deadline.aborted || error.name === 'TimeoutError' || error.name === 'AbortError') ? 'Twilio read timed out.' :
      (/^Twilio .+ returned HTTP \d+\.$/.test(error.message) ? error.message : 'Twilio data could not be read.');
  }
  return { days, coverage: { available: pages > 0, partial: Boolean(warning), warning: warning || null } };
}

async function readActivity(range, auth, assigned, fetchImpl) {
  const windows = windowsFor(range);
  const deadline = AbortSignal.timeout(44000);
  const results = new Array(windows.length);
  let index = 0;
  async function worker() {
    while (index < windows.length && !deadline.aborted) {
      const slot = index++;
      const window = windows[slot];
      results[slot] = await Promise.all([
        readChannel('calls', window, auth, assigned, deadline, fetchImpl),
        readChannel('messages', window, auth, assigned, deadline, fetchImpl),
      ]);
      // Auth errors cannot be fixed by asking for another slice.
      if (results[slot].every(part => /HTTP (401|403)\./.test(part.coverage.warning || ''))) break;
    }
  }
  await Promise.all(Array.from({length: Math.min(3, windows.length)}, worker));
  function combine(channel) {
    const days = new Map(), warnings = new Set(), missing = [];
    let available = false;
    for (const [i, window] of windows.entries()) {
      const part = results[i]?.[channel];
      if (part?.coverage.available) available = true;
      if (!part || part.coverage.partial) {
        missing.push(window);
        if (part?.coverage.warning) warnings.add(part.coverage.warning);
        continue;
      }
      for (const [day, reps] of part.days) days.set(day, reps);
    }
    if (missing.length && !warnings.size) warnings.add('Twilio read did not finish.');
    return { days, coverage: { available, partial: missing.length > 0, missing, warning: [...warnings].join(' ') || null } };
  }
  return { calls: combine(0), sms: combine(1), fetchedAt: new Date().toISOString() };
}

function cachedActivity(range, auth, assigned, fetchImpl) {
  if (fetchImpl !== fetch) return readActivity(range, auth, assigned, fetchImpl);
  const key = `${auth.account}|${range.from}|${range.to}`;
  const hit = cache.get(key);
  if (hit?.until > Date.now()) return hit.result;
  const entry = { until: Infinity };
  entry.result = readActivity(range, auth, assigned, fetchImpl).then(result => {
    const partial = result.calls.coverage.partial || result.sms.coverage.partial;
    if (partial && cache.get(key) === entry) cache.delete(key);
    entry.until = Date.now() + (range.to < Metrics.dayKey(Date.now()) ? 1800000 : 120000);
    return result;
  }, error => {
    if (cache.get(key) === entry) cache.delete(key);
    throw error;
  });
  cache.set(key, entry);
  if (cache.size > 24) cache.delete(cache.keys().next().value);
  return entry.result;
}

export async function loadActivity({ from, to, preset, rep = '' } = {}, fetchImpl = fetch) {
  if (!from && !to) ({ from, to } = Metrics.presetRange(preset || '30d'));
  if (!validDay(from) || !validDay(to) || from > to || Date.parse(to) - Date.parse(from) > 399 * 86400000) {
    throw problem('Pick a valid range of at most 400 days.', 400);
  }
  rep = String(rep || '').trim().slice(0, 80);
  if (activityIsSample()) {
    const r = Metrics.compute(Sample.generate(), { from, to, rep });
    return { sample: true, range: r.range, rep, totals: { calls: r.kpis.dials, sms: r.kpis.smsSent } };
  }
  const range = { from, to, timezone };
  const auth = twilioCredentials(process.env);
  const assigned = repAssignments(process.env.AGENT_ASSIGNMENTS);
  const { calls, sms, fetchedAt } = await cachedActivity(range, auth, assigned, fetchImpl);
  if (!calls.coverage.available && !sms.coverage.available) {
    throw problem([calls.coverage.warning, sms.coverage.warning].filter(Boolean).join(' '), 502);
  }
  const repKey = rep.toLowerCase();
  const reps = [...new Set([...assigned.values()].filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const repAvailable = !rep || reps.some(name => name.toLowerCase() === repKey);
  const totals = emptyCounts(), byDay = new Map();
  for (const { days } of [calls, sms]) {
    for (const [day, reps] of days) {
      for (const [name, counts] of reps) {
        if (repKey && repKey !== name.toLowerCase()) continue;
        if (!byDay.has(day)) byDay.set(day, emptyCounts());
        for (const key of Object.keys(totals)) {
          byDay.get(day)[key] += counts[key];
          totals[key] += counts[key];
        }
      }
    }
  }
  const daily = [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, counts]) => ({ day, ...counts }));
  for (const row of [totals, ...daily]) {
    if (!repAvailable || calls.coverage.partial || !calls.coverage.available) row.calls = row.conversations = null;
    if (!repAvailable || sms.coverage.partial || !sms.coverage.available) row.sms = row.smsDelivered = null;
  }
  return { source: 'Twilio', range, rep, reps, repAvailable, fetchedAt, totals, daily,
    coverage: { calls: calls.coverage, sms: sms.coverage }, definitions };
}
