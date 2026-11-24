// Dashboard data, derived. Turns the synced dataset (same shapes as the v2 data dashboard snapshot)
// into small report blocks: KPIs per window, tasks, appointments and the marketing yield report.
// Rules come from the dashboard's own modules in ./dash (vendored copies, not edited), so the
// numbers follow the dashboard's definitions. Pure: no network, no store.
import LeadIntel from './dash/lead-intel.cjs';
import OppDensity from './dash/opportunity-density.cjs';
import TaskMetrics from './dash/task-metrics.cjs';
import TagVisibility from './dash/tag-visibility.cjs';

export const TZ = 'America/Los_Angeles';
export const WINDOWS = ['today', 'wtd', 'mtd', '7d', '30d', '90d'];
const DAY = 86400000;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// Sample floors. Below these a row is shown but never drives a recommendation.
export const FLOORS = { geoWorked: 25, tagWorked: 40, hourDials: 150, hourTexts: 150, ratioUp: 1.5, ratioDown: 0.5 };

const fmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
const cache = new Map();
export function local(ms) {
  const bucket = Math.floor(ms / 3600000);
  if (cache.has(bucket)) return cache.get(bucket);
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  const day = `${p.year}-${p.month}-${p.day}`;
  const out = { day, hour: Number(p.hour) % 24, weekday: new Date(day + 'T12:00:00Z').getUTCDay() };
  if (cache.size > 50000) cache.clear();
  cache.set(bucket, out);
  return out;
}
const toMs = v => { const n = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(n) ? n : null; };
const dayOf = v => { const ms = toMs(v); return ms == null ? null : local(ms).day; };
const shiftDay = (day, n) => { const d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const round = (n, p = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** p) / 10 ** p);
const ratio = (a, b) => (b > 0 ? a / b : null);
const median = list => { const a = list.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

export function windowRange(name, now = Date.now()) {
  const today = local(now).day;
  const weekStart = shiftDay(today, -((new Date(today + 'T12:00:00Z').getUTCDay() + 6) % 7));
  switch (name) {
    case 'today': return { from: today, to: today };
    case 'wtd': return { from: weekStart, to: today };
    case 'mtd': return { from: today.slice(0, 8) + '01', to: today };
    case '7d': return { from: shiftDay(today, -6), to: today };
    case '90d': return { from: shiftDay(today, -89), to: today };
    default: return { from: shiftDay(today, -29), to: today };
  }
}
const inRange = r => day => Boolean(day) && day >= r.from && day <= r.to;

// Dashboard snapshot rows -> the row shapes LeadIntel / OppDensity read in the dashboard browser.
export function leadInputs({ contacts = [], calls = [], sms = [], opportunities = [], userNames = {} }) {
  const callRows = calls.map(c => {
    const at = toMs(c.co);
    if (at == null) return null;
    const l = local(at);
    return { id: c.id, contactId: c.contactId || '', co: c.co, created: c.co, duration: Number(c.du) || 0, du: Number(c.du) || 0, rep: c.rep || '', cs: c.cs, dateKey: l.day, hour: l.hour, weekday: l.weekday, at };
  }).filter(Boolean);
  const smsRows = sms.map(m => {
    const at = toMs(m.createdAt);
    if (at == null) return null;
    const l = local(at);
    const inbound = m.direction === 'inbound';
    return { id: m.id, contactId: m.contactId || '', createdAt: m.createdAt, direction: m.direction, isInbound: inbound, body: m.body || '', status: m.status, error: m.error,
      source: m.source || '', userId: m.userId || '', rep: inbound ? '' : (userNames[m.userId] || ''), category: m.category || '', dateKey: l.day, hour: l.hour, weekday: l.weekday, at };
  }).filter(Boolean);
  const oppRows = opportunities.map(o => {
    const at = toMs(o.created);
    return { id: o.id, contactId: o.contactId || '', oppName: o.on, leadName: o.ln, rep: o.rep || 'Unassigned', pipeline: o.pipe || 'Unknown', status: o.status || 'open', stage: o.stage || '',
      value: Number(o.val) || 0, tags: o.tags || [], created: o.created, dateObj: at == null ? null : new Date(at), dateKey: at == null ? null : local(at).day, stageAt: o.stageAt || '', lostReason: o.lost || '' };
  });
  return { contacts, calls: callRows, sms: smsRows, opps: oppRows };
}

export function buildModel(data, settings = {}, now = Date.now()) {
  const userNames = data.meta?.userNames || {};
  const inputs = leadInputs({ ...data, userNames });
  const isBatchTag = t => TagVisibility.isShown(settings.tagVisibility || null, t);
  const model = LeadIntel.buildLeads({ contacts: inputs.contacts, calls: inputs.calls, sms: inputs.sms, opps: inputs.opps, appointments: data.appointments || [],
    userNames, isBatchTag, now, dateKeyOf: ms => local(ms).day });
  return { inputs, model, isBatchTag };
}

// ---------------- KPIs ----------------
function repRow(map, rep) {
  if (!map.has(rep)) map.set(rep, { rep, dials: 0, answered: 0, talkSeconds: 0, over60: 0, contacts: 0, uniqueDialed: new Set(), textsSent: 0, textsAutomated: 0, oppsCreated: 0 });
  return map.get(rep);
}
export function kpis({ inputs, model }, data, range, now = Date.now()) {
  const inR = inRange(range);
  const reps = new Map();
  const totals = repRow(new Map(), 'All');
  const automated = /workflow|bulk|campaign|drip|automation|trigger|ai_bot|autoresponder/i;
  for (const c of inputs.calls) {
    if (!inR(c.dateKey)) continue;
    for (const r of [totals, repRow(reps, c.rep || 'Unknown caller')]) {
      r.dials++; if (c.cs === 'Answered') r.answered++; r.talkSeconds += c.du;
      if (c.du > 60) r.over60++; if (c.du > LeadIntel.CONFIG.contactCallSeconds) r.contacts++;
      if (c.contactId) r.uniqueDialed.add(c.contactId);
    }
  }
  let inbound = 0; const replyMix = { positive: 0, neutral: 0, negative: 0, opt_out: 0 };
  for (const m of inputs.sms) {
    if (!inR(m.dateKey)) continue;
    if (m.isInbound) { inbound++; if (replyMix[m.category] != null) replyMix[m.category]++; continue; }
    const auto = automated.test(m.source);
    for (const r of [totals, repRow(reps, m.rep || (auto ? 'Automation' : 'Unknown'))]) { if (auto) r.textsAutomated++; else r.textsSent++; }
  }
  const byPipeline = {};
  for (const o of inputs.opps) {
    if (!inR(o.dateKey)) continue;
    byPipeline[o.pipeline] = (byPipeline[o.pipeline] || 0) + 1;
    totals.oppsCreated++; repRow(reps, o.rep).oppsCreated++;
  }
  const inPeriodMs = ms => inR(local(ms).day);
  const tasks = data.tasks || [];
  const taskAll = TaskMetrics.summarize(tasks, { inPeriod: inPeriodMs, now });
  const taskReps = [...new Set(tasks.map(t => t.rep))].map(rep => ({ rep, ...slimTasks(TaskMetrics.summarize(tasks, { rep, inPeriod: inPeriodMs, now })) }));
  const appts = (data.appointments || []).filter(a => inR(dayOf(a.start)));
  const funnel = LeadIntel.funnel(model.leads, inR);
  const finish = r => ({ rep: r.rep, dials: r.dials, answered: r.answered, answerRate: round(ratio(r.answered, r.dials), 4), talkMinutes: round(r.talkSeconds / 60, 1),
    avgTalkSeconds: round(ratio(r.talkSeconds, r.answered), 0), conversations60: r.over60, contacts: r.contacts, uniqueContactsDialed: r.uniqueDialed.size,
    textsSent: r.textsSent, textsAutomated: r.textsAutomated, oppsCreated: r.oppsCreated });
  return {
    range, totals: { ...finish(totals), textsReceived: inbound, replyMix, opportunitiesByPipeline: byPipeline },
    funnel: { worked: funnel.worked, contacted: funnel.contacted, qualified: funnel.qualified, estimatedQualified: funnel.estimatedQualified, ghosted: funnel.ghosted, notReady: funnel.notReady, offers: funnel.offers, contracts: funnel.contracts },
    reps: [...reps.values()].map(finish).filter(r => r.dials || r.textsSent || r.oppsCreated).sort((a, b) => b.dials - a.dials || b.textsSent - a.textsSent),
    tasks: { ...slimTasks(taskAll), byRep: taskReps.filter(r => r.completed || r.overdue || r.set).sort((a, b) => b.completed - a.completed) },
    appointments: { booked: appts.length, showed: appts.filter(a => a.status === 'showed').length, noShow: appts.filter(a => /no.?show/.test(a.status)).length, cancelled: appts.filter(a => /cancel/.test(a.status)).length },
  };
}
function slimTasks(s) {
  return { set: s.set, edited: s.edited, completed: s.completed, completedEstimated: s.estimated, undatedCompleted: s.undated, overdue: s.overdue,
    oldestOverdue: s.oldest ? { title: s.oldest.title, rep: s.oldest.rep, dueDate: s.oldest.dueDate, contactId: s.oldest.contactId, daysOverdue: Math.floor(s.oldestMs / DAY) } : null };
}

// ---------------- Marketing yield ----------------
// One row per segment value. worked = sellers with an outbound rep touch in the window; contacted / qualified use the
// dashboard rules (LeadIntel.contactedIn, qualifiedDay = first ACQ/Retail opportunity, Hot counts as qualified).
function segmentRows(model, contactsById, keysOf, inR, floor) {
  const rows = new Map();
  const row = k => { if (!rows.has(k)) rows.set(k, { key: k, worked: 0, contacted: 0, qualified: 0, offers: 0, contracts: 0 }); return rows.get(k); };
  for (const L of model.leads.values()) {
    if (!L.touches.some(t => t.dir === 'out' && !t.automated && inR(t.dateKey))) continue;
    const keys = keysOf(contactsById.get(L.id) || L.contact || {}, L);
    if (!keys.length) continue;
    const contacted = LeadIntel.contactedIn(L, inR);
    const qualified = L.qualifiedWeight > 0 && (L.qualifiedDay ? inR(L.qualifiedDay) : L.hot);
    for (const k of new Set(keys)) {
      const r = row(k);
      r.worked++; if (contacted) r.contacted++; if (qualified) r.qualified++;
      if (L.offerDay && inR(L.offerDay)) r.offers++;
      if (L.contractDay && inR(L.contractDay)) r.contracts++;
    }
  }
  const list = [...rows.values()].map(r => ({ ...r, contactRate: round(ratio(r.contacted, r.worked), 4), qualPer100Worked: round(ratio(r.qualified, r.worked) * 100, 2), lowSample: r.worked < floor }));
  const base = median(list.filter(r => !r.lowSample).map(r => r.qualPer100Worked));
  for (const r of list) r.vsMedian = base ? round(r.qualPer100Worked / base, 2) : null;
  list.sort((a, b) => (a.lowSample - b.lowSample) || (b.qualPer100Worked ?? -1) - (a.qualPer100Worked ?? -1) || b.worked - a.worked);
  return { baselineQualPer100: round(base, 2), rows: list };
}

function timing(inputs, model, inR) {
  const qualifiedDay = new Map();
  for (const L of model.leads.values()) if (L.qualifiedWeight > 0 && L.qualifiedDay) qualifiedDay.set(L.id, L.qualifiedDay);
  const hours = Array.from({ length: 24 }, (_, h) => ({ hour: h, dials: 0, connects: 0, contacts: 0, leadToQualified: 0, texts: 0, replied: 0 }));
  const weekdays = WEEKDAYS.map(d => ({ day: d, dials: 0, contacts: 0, leadToQualified: 0, texts: 0, replied: 0 }));
  const contactSec = LeadIntel.CONFIG.contactCallSeconds;
  for (const c of inputs.calls) {
    if (!inR(c.dateKey)) continue;
    const h = hours[c.hour], w = weekdays[c.weekday];
    h.dials++; w.dials++;
    if (c.cs === 'Answered' || c.du > 0) h.connects++;
    if (c.du > contactSec) {
      h.contacts++; w.contacts++;
      // A contact that became a qualified seller within 14 days of this call.
      const q = qualifiedDay.get(c.contactId);
      if (q && q >= c.dateKey && q <= shiftDay(c.dateKey, 14)) { h.leadToQualified++; w.leadToQualified++; }
    }
  }
  // Replies within 24 hours of a rep (not automated) text, by the hour the text went out.
  const inboundBy = new Map();
  for (const m of inputs.sms) if (m.isInbound && m.contactId) { if (!inboundBy.has(m.contactId)) inboundBy.set(m.contactId, []); inboundBy.get(m.contactId).push(m.at); }
  for (const list of inboundBy.values()) list.sort((a, b) => a - b);
  const auto = /workflow|bulk|campaign|drip|automation|trigger|ai_bot|autoresponder/i;
  for (const m of inputs.sms) {
    if (m.isInbound || !inR(m.dateKey)) continue;
    const kind = auto.test(m.source) ? 'auto' : 'rep';
    const h = hours[m.hour], w = weekdays[m.weekday];
    if (kind !== 'rep') continue;
    h.texts++; w.texts++;
    const replies = inboundBy.get(m.contactId) || [];
    if (replies.some(t => t > m.at && t - m.at <= DAY)) { h.replied++; w.replied++; }
  }
  const fin = r => ({ ...r, contactRate: round(ratio(r.contacts, r.dials), 4), qualifiedPer1000Dials: round(ratio(r.leadToQualified, r.dials) * 1000, 2), replyRate: round(ratio(r.replied, r.texts), 4) });
  return { hours: hours.map(fin), weekdays: weekdays.map(fin) };
}

function opportunityTiming(inputs, inR) {
  const hours = new Array(24).fill(0), weekdays = new Array(7).fill(0);
  for (const o of inputs.opps) {
    if (!['ACQ Pipeline', 'Retail Pipeline'].includes(o.pipeline) || !o.dateObj || !inR(o.dateKey)) continue;
    const l = local(o.dateObj.valueOf());
    hours[l.hour]++; weekdays[l.weekday]++;
  }
  return { hours, weekdays: WEEKDAYS.map((d, i) => ({ day: d, count: weekdays[i] })) };
}

const hourLabel = h => `${((h + 11) % 12) + 1}${h < 12 ? 'am' : 'pm'}`;
const confidence = (n, floor) => (n >= floor * 4 ? 'high' : n >= floor * 2 ? 'medium' : 'low');

export function recommendations(m) {
  const recs = [];
  for (const r of m.lists.rows) {
    if (r.unattributed || !['Increase', 'Retire', 'Investigate'].includes(r.status) || r.lowSample) continue;
    // "Investigate" only when there is a concrete problem (bad contact rate or a thin list), not when the baseline is still forming.
    if (r.status === 'Investigate' && !(r.reasons || []).some(x => /Contact rate|of the list worked/.test(x))) continue;
    const action = r.status === 'Increase' ? `Buy or pull more of list "${r.batch}"` : r.status === 'Retire' ? `Stop buying list "${r.batch}"` : `Check list "${r.batch}" before buying more`;
    recs.push({ area: 'list', status: r.status, action, evidence: (r.reasons || []).join('; '), metric: `${round(r.density, 1)} qualified per 1,000 worked`, worked: r.worked, confidence: confidence(r.worked, 500) });
  }
  const seg = (area, block, label, floor) => {
    for (const r of block.rows) {
      if (r.lowSample || r.vsMedian == null) continue;
      if (r.vsMedian >= FLOORS.ratioUp) recs.push({ area, status: 'Increase', action: `Target more ${label} ${r.key}`, evidence: `${r.qualPer100Worked} qualified per 100 worked, ${r.vsMedian}x the median ${label} (${block.baselineQualPer100})`, metric: `${r.qualified} qualified of ${r.worked} worked`, worked: r.worked, confidence: confidence(r.worked, floor) });
      else if (r.vsMedian <= FLOORS.ratioDown && r.worked >= floor * 2) recs.push({ area, status: 'Reduce', action: `Spend less on ${label} ${r.key}`, evidence: `${r.qualPer100Worked} qualified per 100 worked, ${r.vsMedian}x the median ${label} (${block.baselineQualPer100})`, metric: `${r.qualified} qualified of ${r.worked} worked`, worked: r.worked, confidence: confidence(r.worked, floor) });
    }
  };
  seg('zip', m.zips, 'ZIP', FLOORS.geoWorked);
  seg('city', m.cities, 'city', FLOORS.geoWorked);
  seg('tag', m.tags, 'tag', FLOORS.tagWorked);
  seg('source', m.sources, 'contact source', FLOORS.tagWorked);
  const hrs = m.timing.hours.filter(h => h.dials >= FLOORS.hourDials && h.contactRate != null);
  if (hrs.length >= 4) {
    const sorted = [...hrs].sort((a, b) => b.contactRate - a.contactRate);
    const best = sorted.slice(0, 3), worst = sorted.slice(-3);
    const base = median(hrs.map(h => h.contactRate));
    if (best[0].contactRate >= base * 1.2) recs.push({ area: 'call timing', status: 'Shift', action: `Put more dial blocks at ${best.map(h => hourLabel(h.hour)).join(', ')}`,
      evidence: `Contact rate ${best.map(h => `${hourLabel(h.hour)} ${round(h.contactRate * 100, 1)}%`).join(', ')} vs median ${round(base * 100, 1)}%; weakest ${worst.map(h => `${hourLabel(h.hour)} ${round(h.contactRate * 100, 1)}%`).join(', ')}`,
      metric: 'calls over 65s / dials', worked: best.reduce((s, h) => s + h.dials, 0), confidence: confidence(Math.min(...best.map(h => h.dials)), FLOORS.hourDials) });
  }
  const txt = m.timing.hours.filter(h => h.texts >= FLOORS.hourTexts && h.replyRate != null);
  if (txt.length >= 4) {
    const sorted = [...txt].sort((a, b) => b.replyRate - a.replyRate);
    const base = median(txt.map(h => h.replyRate));
    if (sorted[0].replyRate >= base * 1.2) recs.push({ area: 'text timing', status: 'Shift', action: `Send rep texts at ${sorted.slice(0, 3).map(h => hourLabel(h.hour)).join(', ')}`,
      evidence: `24h reply rate ${sorted.slice(0, 3).map(h => `${hourLabel(h.hour)} ${round(h.replyRate * 100, 1)}%`).join(', ')} vs median ${round(base * 100, 1)}%`, metric: 'replies within 24h / rep texts', worked: sorted.slice(0, 3).reduce((s, h) => s + h.texts, 0), confidence: confidence(Math.min(...sorted.slice(0, 3).map(h => h.texts)), FLOORS.hourTexts) });
  }
  const order = { high: 0, medium: 1, low: 2 };
  return recs.sort((a, b) => order[a.confidence] - order[b.confidence] || b.worked - a.worked).slice(0, 25);
}

export function marketing(built, data, settings = {}, range, now = Date.now()) {
  const { inputs, model, isBatchTag } = built;
  const inR = inRange(range);
  const contactsById = new Map((data.contacts || []).map(c => [c.id, c]));
  const index = OppDensity.buildIndex({ contacts: data.contacts || [], leads: model.leads, opps: inputs.opps, isBatchTag, statusTag: LeadIntel.STATUS_TAG, excludedTagReason: LeadIntel.excludedTagReason });
  const board = OppDensity.leaderboard(index, { window: { type: 'cohort', days: null }, settings: settings.batchSettings || {}, now });
  const zip = c => String(c.ad?.z || '').replace(/\D/g, '').slice(0, 5);
  const tagsOf = c => (Array.isArray(c.t) ? c.t : String(c.t || '').split(',')).map(t => String(t).trim()).filter(t => t && !LeadIntel.STATUS_TAG.test(t) && !LeadIntel.excludedTagReason([t]));
  const out = {
    range,
    lists: { baseline: round(board.baseline, 2), thresholds: board.thresholds, totals: board.totals,
      rows: board.rows.slice(0, 60).map(r => ({ batch: r.batch, unattributed: r.unattributed, ageDays: r.ageDays, imported: r.imported, worked: r.worked, coverage: round(r.coverage, 4), connected: r.connected,
        meaningful: r.meaningful, contactRate: round(r.contactRate, 4), qualified: r.qualified, density: round(r.density, 2), offers: r.offers, contracts: r.contracts, assists: r.assists, lowSample: r.lowSample,
        immature: r.immature, status: r.status || (r.unattributed ? 'Unattributed' : ''), reasons: r.reasons || [] })) },
    sources: LeadIntel.rankSources(model.leads, inR, { contacts: data.contacts || [] }).slice(0, 40),
    zips: segmentRows(model, contactsById, c => (zip(c) ? [zip(c)] : []), inR, FLOORS.geoWorked),
    cities: segmentRows(model, contactsById, c => (c.ad?.c ? [String(c.ad.c).trim().replace(/\s+/g, ' ').replace(/\b\w/g, x => x.toUpperCase())] : []), inR, FLOORS.geoWorked),
    tags: segmentRows(model, contactsById, tagsOf, inR, FLOORS.tagWorked),
    contactSources: segmentRows(model, contactsById, c => (c.src ? [c.src] : []), inR, FLOORS.tagWorked),
    timing: timing(inputs, model, inR),
    opportunityTiming: opportunityTiming(inputs, inR),
  };
  for (const k of ['zips', 'cities', 'tags', 'contactSources']) out[k].rows = out[k].rows.slice(0, 80);
  out.recommendations = recommendations({ lists: out.lists, zips: out.zips, cities: out.cities, tags: out.tags, sources: out.contactSources, timing: out.timing });
  return out;
}

// Everything the report path needs, small enough to read on each request.
export function derive(data, settings = {}, now = Date.now()) {
  const built = buildModel(data, settings, now);
  const windows = {};
  for (const w of WINDOWS) windows[w] = kpis(built, data, windowRange(w, now), now);
  return {
    builtAt: new Date(now).toISOString(),
    windows,
    marketing: { '30d': marketing(built, data, settings, windowRange('30d', now), now), '90d': marketing(built, data, settings, windowRange('90d', now), now) },
    stats: { contacts: (data.contacts || []).length, calls: (data.calls || []).length, sms: (data.sms || []).length, opportunities: (data.opportunities || []).length,
      tasks: (data.tasks || []).length, appointments: (data.appointments || []).length, leads: built.model.leads.size, excluded: built.model.stats.excluded },
  };
}
