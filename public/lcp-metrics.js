/* LCP metrics engine. One file, used by the browser, the Netlify functions, the MCP
 * endpoint and the tests, so every surface reports the same numbers.
 *
 * Input (normalized, see netlify/functions/lib/sources.mjs):
 *   calls:         [{ id, at, rep, contactId, disposition, connected, duration }]
 *   sms:           [{ id, at, rep, contactId, direction: 'outbound'|'inbound' }]
 *   contacts:      [{ id, name, city, zip }]
 *   opportunities: [{ id, contactId, name, createdAt, rep, pipeline, stage, status, value }]
 *   deals:         [{ opportunityId, assignmentFee, feeReceived, feeReceivedDate, contractPrice }]  (Ledger, optional)
 *
 * Definitions:
 *   Dial        = one dialer line attempt with a saved disposition (auto or manual).
 *   Connected   = the dialer connected the agent to that line.
 *   Qualified   = a contact's FIRST opportunity in a qualifying pipeline (ACQ or Retail by default).
 *                 The qualification date is that opportunity's creation date.
 *   Touch       = a dial or an outbound SMS to the contact before qualification, inside the lookback.
 *   Credit      = the rep with the most recent touch of that channel (last touch). One credit per lead.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LcpMetrics = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TZ = 'America/Los_Angeles';
  var DAY = 86400000;
  var QUALIFYING = /acq|acquisition|retail/i;
  var TOUCH_BUCKETS = [[0, 0, '0'], [1, 1, '1'], [2, 3, '2-3'], [4, 6, '4-6'], [7, 10, '7-10'], [11, Infinity, '11+']];
  var WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  // Dialer dispositions (Triple Line) and the 5 outcome groups used for the daily chart.
  var DISPOSITIONS = {
    'no-answer-voicemail': ['No Answer/Voicemail', 'noanswer'], 'follow-up-cold': ['Follow Up Cold', 'followup'], 'follow-up-warm': ['Follow Up Warm', 'followup'],
    'follow-up-hot': ['Follow Up Hot', 'followup'], 'not-interested': ['Not Interested', 'notinterested'], 'incorrect-number': ['Incorrect Number', 'bad'],
    'dnc': ['DNC', 'bad'], 'spanish': ['Spanish', 'other'], 'not-qualified-on-market': ['Not qualified/on market', 'other']
  };
  var OUTCOMES = [['noanswer', 'No answer / VM'], ['notinterested', 'Not interested'], ['followup', 'Follow up'], ['bad', 'Bad number / DNC'], ['other', 'Other']];
  function outcomeOf(d) { return (DISPOSITIONS[d] || [d, 'other'])[1]; }
  // Ledger bill categories -> P&L section (same groups as the Ledger Reports tab).
  var DEAL_COST = { 'Title & Escrow': 1, 'Closing Costs': 1, 'EMD Forfeited': 1, 'Inspections & Appraisals': 1 };
  var LEAD_GEN = { 'Lead Lists & Data': 1, 'Skip Tracing': 1, 'SMS & Dialer': 1, 'Marketing & Ads': 1, 'Direct Mail': 1 };
  var BELOW = { 'Loan Payment': 1, 'Taxes': 1 };
  function sectionOf(cat) { return BELOW[cat] ? 'below' : DEAL_COST[cat] ? 'deal' : LEAD_GEN[cat] ? 'leadgen' : 'opex'; }

  var fmtCache = {}, partCache = {};
  function parts(at, tz) {
    var key = tz || TZ;
    var ms = typeof at === 'number' ? at : Date.parse(at);
    var hb = Math.floor(ms / 3600000), ck = key + hb;
    if (partCache[ck]) return partCache[ck];
    if (Object.keys(partCache).length > 50000) partCache = {};
    var f = fmtCache[key] || (fmtCache[key] = new Intl.DateTimeFormat('en-US', {
      timeZone: key, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23', weekday: 'short'
    }));
    var out = {};
    f.formatToParts(new Date(hb * 3600000)).forEach(function (p) { out[p.type] = p.value; });
    return (partCache[ck] = { day: out.year + '-' + out.month + '-' + out.day, hour: Number(out.hour) % 24, weekday: out.weekday });
  }
  function dayKey(at, tz) { return parts(at, tz).day; }
  function shiftDay(day, n) { var d = new Date(day + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  function daysInclusive(from, to) { return Math.round((Date.parse(to + 'T12:00:00Z') - Date.parse(from + 'T12:00:00Z')) / DAY) + 1; }
  function weekStart(day) { var dow = (new Date(day + 'T12:00:00Z').getUTCDay() + 6) % 7; return shiftDay(day, -dow); }
  function validDay(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) && !isNaN(Date.parse(s + 'T12:00:00Z')); }

  // Date presets in the reporting time zone. WTD starts Monday.
  function presetRange(name, now, tz) {
    var today = dayKey(now || Date.now(), tz);
    switch (name) {
      case 'today': return { from: today, to: today };
      case 'yesterday': { var y = shiftDay(today, -1); return { from: y, to: y }; }
      case '7d': return { from: shiftDay(today, -6), to: today };
      case 'wtd': return { from: weekStart(today), to: today };
      case 'mtd': return { from: today.slice(0, 8) + '01', to: today };
      case '90d': return { from: shiftDay(today, -89), to: today };
      case 'ytd': return { from: today.slice(0, 4) + '-01-01', to: today };
      default: return { from: shiftDay(today, -29), to: today };
    }
  }

  function periodFor(from, to) { var n = daysInclusive(from, to); return n <= 31 ? 'day' : n <= 120 ? 'week' : 'month'; }
  function bucketOf(day, period) { return period === 'month' ? day.slice(0, 7) : period === 'week' ? weekStart(day) : day; }
  function periodKeys(from, to, period) {
    var keys = [], seen = {};
    for (var d = from; d <= to; d = shiftDay(d, 1)) { var k = bucketOf(d, period); if (!seen[k]) { seen[k] = 1; keys.push(k); } }
    return keys;
  }

  function ratio(a, b) { return b > 0 ? a / b : null; }
  function round(n, p) { if (n == null || !isFinite(n)) return null; var m = Math.pow(10, p == null ? 2 : p); return Math.round(n * m) / m; }
  function median(list) { if (!list.length) return null; var s = list.slice().sort(function (a, b) { return a - b; }); var m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function sum(list, f) { var t = 0; for (var i = 0; i < list.length; i++) t += Number(f(list[i])) || 0; return t; }
  function touchBucket(n) { for (var i = 0; i < TOUCH_BUCKETS.length; i++) if (n >= TOUCH_BUCKETS[i][0] && n <= TOUCH_BUCKETS[i][1]) return TOUCH_BUCKETS[i][2]; return '11+'; }

  function compute(data, options) {
    options = options || {};
    var tz = options.timezone || TZ;
    var range = options.from && options.to && validDay(options.from) && validDay(options.to) && options.from <= options.to
      ? { from: options.from, to: options.to } : presetRange(options.preset || '30d', options.now, tz);
    var from = range.from, to = range.to;
    var rep = options.rep || '';
    var lookbackMs = (options.lookbackDays || 60) * DAY;
    var qualifying = options.qualifyingPipelines instanceof RegExp ? options.qualifyingPipelines : QUALIFYING;
    var period = options.period || periodFor(from, to);
    var inRange = function (at) { var d = dayKey(at, tz); return d >= from && d <= to; };
    var repOk = function (r) { return !rep || r === rep; };

    var calls = (data.calls || []).filter(function (c) { return c && c.at; });
    var sms = (data.sms || []).filter(function (m) { return m && m.at; });
    var contacts = {}; (data.contacts || []).forEach(function (c) { if (c && c.id) contacts[c.id] = c; });
    var opps = (data.opportunities || []).filter(function (o) { return o && o.createdAt; });
    var deals = {}; (data.deals || []).forEach(function (d) { if (d && d.opportunityId) deals[d.opportunityId] = d; });

    // Touch index per contact (all loaded history, needed for lookback).
    var touches = {};
    calls.forEach(function (c) { if (!c.contactId) return; (touches[c.contactId] || (touches[c.contactId] = [])).push({ at: Date.parse(c.at), ch: 'dial', rep: c.rep || 'Unknown' }); });
    sms.forEach(function (m) { if (!m.contactId || m.direction !== 'outbound') return; (touches[m.contactId] || (touches[m.contactId] = [])).push({ at: Date.parse(m.at), ch: 'sms', rep: m.rep || 'Unknown' }); });

    function touchInfo(contactId, createdAt) {
      var t1 = Date.parse(createdAt), t0 = t1 - lookbackMs, list = touches[contactId] || [];
      var info = { dials: 0, sms: 0, total: 0, lastDialRep: null, lastSmsRep: null, lastRep: null, lastDialAt: 0, lastSmsAt: 0 };
      for (var i = 0; i < list.length; i++) {
        var t = list[i]; if (t.at >= t1 || t.at < t0) continue;
        info.total++;
        if (t.ch === 'dial') { info.dials++; if (t.at >= info.lastDialAt) { info.lastDialAt = t.at; info.lastDialRep = t.rep; } }
        else { info.sms++; if (t.at >= info.lastSmsAt) { info.lastSmsAt = t.at; info.lastSmsRep = t.rep; } }
      }
      info.lastRep = info.lastDialAt >= info.lastSmsAt ? info.lastDialRep : info.lastSmsRep;
      return info;
    }

    // ---------- 1. Calls made by user ----------
    var callsIn = calls.filter(function (c) { return inRange(c.at) && repOk(c.rep || 'Unknown'); });
    var pkeys = periodKeys(from, to, period);
    var byRep = {};
    callsIn.forEach(function (c) {
      var r = c.rep || 'Unknown';
      var row = byRep[r] || (byRep[r] = { rep: r, dials: 0, connected: 0, over60: 0, talkSeconds: 0, hot: 0, warm: 0, cold: 0, contacts: {}, series: {} });
      row.dials++; if (c.connected) row.connected++;
      var du = Number(c.duration) || 0; if (du >= 60) row.over60++; if (c.connected) row.talkSeconds += du;
      if (c.disposition === 'follow-up-hot') row.hot++; if (c.disposition === 'follow-up-warm') row.warm++; if (c.disposition === 'follow-up-cold') row.cold++;
      if (c.contactId) row.contacts[c.contactId] = 1;
      var b = bucketOf(dayKey(c.at, tz), period); row.series[b] = (row.series[b] || 0) + 1;
    });
    var callRows = Object.keys(byRep).map(function (k) {
      var r = byRep[k];
      return { rep: r.rep, dials: r.dials, connected: r.connected, connectRate: round(ratio(r.connected, r.dials), 4), over60: r.over60,
        talkMinutes: round(r.talkSeconds / 60, 1), avgCallSeconds: round(ratio(r.talkSeconds, r.connected), 0), uniqueContacts: Object.keys(r.contacts).length, hot: r.hot, warm: r.warm, cold: r.cold,
        series: pkeys.map(function (p) { return r.series[p] || 0; }) };
    }).sort(function (a, b) { return b.dials - a.dials; });
    var callTotals = {
      dials: callsIn.length, connected: sum(callRows, function (r) { return r.connected; }),
      over60: sum(callRows, function (r) { return r.over60; }), talkMinutes: round(sum(callRows, function (r) { return r.talkMinutes; }), 1),
      uniqueContacts: Object.keys(callsIn.reduce(function (m, c) { if (c.contactId) m[c.contactId] = 1; return m; }, {})).length
    };
    callTotals.connectRate = round(ratio(callTotals.connected, callTotals.dials), 4);
    callTotals.avgCallSeconds = round(ratio(sum(callsIn, function (c) { return c.connected ? Number(c.duration) || 0 : 0; }), callTotals.connected), 0);
    var conv = callsIn.filter(function (c) { return (Number(c.duration) || 0) >= 60; });
    callTotals.avgConversationSeconds = round(ratio(sum(conv, function (c) { return Number(c.duration) || 0; }), conv.length), 0);
    callTotals.followUps = { hot: sum(callRows, function (r) { return r.hot; }), warm: sum(callRows, function (r) { return r.warm; }), cold: sum(callRows, function (r) { return r.cold; }) };
    // Disposition breakdown and daily activity by outcome (same view as the data dashboard Calls tab).
    var disp = {}, outcomeSeries = {}, connSeries = pkeys.map(function () { return 0; }), pidx = {};
    pkeys.forEach(function (k, i) { pidx[k] = i; });
    OUTCOMES.forEach(function (o) { outcomeSeries[o[0]] = pkeys.map(function () { return 0; }); });
    callsIn.forEach(function (c) {
      var id = c.disposition || 'unknown', d = disp[id] || (disp[id] = { id: id, label: (DISPOSITIONS[id] || [id || 'Unknown'])[0], outcome: outcomeOf(id), count: 0, talk: 0, talkN: 0 });
      d.count++; if (c.connected) { d.talk += Number(c.duration) || 0; d.talkN++; }
      var i = pidx[bucketOf(dayKey(c.at, tz), period)]; if (i != null) { outcomeSeries[outcomeOf(id)][i]++; if (c.connected) connSeries[i]++; }
    });
    callTotals.dispositions = Object.keys(disp).map(function (k) { var d = disp[k]; return { id: d.id, label: d.label, outcome: d.outcome, count: d.count, share: round(ratio(d.count, callsIn.length), 4), avgTalkSeconds: round(ratio(d.talk, d.talkN), 0) }; })
      .sort(function (a, b) { return b.count - a.count; });
    callTotals.outcomes = OUTCOMES.map(function (o) { return { key: o[0], label: o[1], series: outcomeSeries[o[0]], count: sum(outcomeSeries[o[0]], function (x) { return x; }) }; });
    callTotals.connectedSeries = connSeries;

    // ---------- Qualification (first qualifying opportunity per contact) ----------
    var qualifyingOpps = opps.filter(function (o) { return qualifying.test(o.pipeline || ''); })
      .sort(function (a, b) { return Date.parse(a.createdAt) - Date.parse(b.createdAt); });
    var firstByContact = {};
    qualifyingOpps.forEach(function (o) { if (o.contactId && !firstByContact[o.contactId]) firstByContact[o.contactId] = o; });
    var qualified = Object.keys(firstByContact).map(function (cid) { return firstByContact[cid]; })
      .filter(function (o) { return inRange(o.createdAt); })
      .map(function (o) { return { opp: o, t: touchInfo(o.contactId, o.createdAt) }; });

    // ---------- 2. Opportunities generated ----------
    var oppsIn = qualifyingOpps.filter(function (o) { return inRange(o.createdAt) && repOk(o.rep || 'Unassigned'); }).map(function (o) {
      var c = contacts[o.contactId] || {};
      var t = o.contactId ? touchInfo(o.contactId, o.createdAt) : { total: 0, dials: 0, sms: 0 };
      var p = parts(o.createdAt, tz);
      var d = deals[o.id] || null;
      return { id: o.id, name: o.name || c.name || 'Opportunity', contactId: o.contactId || '', rep: o.rep || 'Unassigned', pipeline: o.pipeline, stage: o.stage || '',
        status: o.status || 'open', value: Number(o.value) || 0, createdAt: o.createdAt, day: p.day, hour: p.hour, weekday: p.weekday,
        city: c.city || 'Unknown', zip: c.zip || 'Unknown', touches: t.total, dialTouches: t.dials, smsTouches: t.sms, bucket: touchBucket(t.total),
        assignmentFee: d ? d.assignmentFee : null, feeReceived: d ? d.feeReceived : null };
    });
    function groupBy(list, key, order) {
      var g = {};
      list.forEach(function (o) { var k = o[key]; var row = g[k] || (g[k] = { key: k, count: 0, value: 0, touches: [], fees: 0 }); row.count++; row.value += o.value; row.touches.push(o.touches); row.fees += Number(o.feeReceived) || 0; });
      var rows = (order || Object.keys(g)).map(function (k) { var r = g[k] || { key: k, count: 0, value: 0, touches: [], fees: 0 };
        return { key: k, count: r.count, value: round(r.value, 0), avgTouches: round(r.touches.length ? sum(r.touches, function (x) { return x; }) / r.touches.length : null, 1), feesReceived: round(r.fees, 0), share: round(ratio(r.count, list.length), 4) }; });
      return order ? rows : rows.sort(function (a, b) { return b.count - a.count || b.value - a.value; });
    }
    var periodCounts = {}; oppsIn.forEach(function (o) { var b = bucketOf(o.day, period); periodCounts[b] = (periodCounts[b] || 0) + 1; });
    var touchList = oppsIn.filter(function (o) { return o.contactId; }).map(function (o) { return o.touches; });
    var opportunities = {
      total: oppsIn.length, value: round(sum(oppsIn, function (o) { return o.value; }), 0),
      medianTouches: median(touchList), avgTouches: round(touchList.length ? sum(touchList, function (x) { return x; }) / touchList.length : null, 1),
      byCity: groupBy(oppsIn, 'city'), byZip: groupBy(oppsIn, 'zip'),
      byPeriod: groupBy(oppsIn.map(function (o) { return Object.assign({}, o, { pk: bucketOf(o.day, period) }); }), 'pk', pkeys),
      byWeekday: groupBy(oppsIn, 'weekday', WEEKDAYS),
      byHour: groupBy(oppsIn.map(function (o) { return Object.assign({}, o, { hk: String(o.hour) }); }), 'hk', Array.from({ length: 24 }, function (_, i) { return String(i); })),
      byTouches: groupBy(oppsIn, 'bucket', TOUCH_BUCKETS.map(function (b) { return b[2]; })),
      byRep: groupBy(oppsIn, 'rep'),
      byWeekdayHour: WEEKDAYS.map(function (w) { var row = new Array(24).fill(0); oppsIn.forEach(function (o) { if (o.weekday === w) row[o.hour]++; }); return { key: w, hours: row }; }),
      list: oppsIn.slice().sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); })
    };

    // ---------- 3. SMS to qualified / 4. Dials to qualified ----------
    var smsOut = sms.filter(function (m) { return m.direction === 'outbound' && inRange(m.at) && repOk(m.rep || 'Unknown'); });
    var firstOut = {}; smsOut.forEach(function (m) { var t = Date.parse(m.at); if (!firstOut[m.contactId] || t < firstOut[m.contactId]) firstOut[m.contactId] = t; });
    var replied = {}; sms.forEach(function (m) { if (m.direction === 'inbound' && inRange(m.at) && firstOut[m.contactId] && Date.parse(m.at) > firstOut[m.contactId]) replied[m.contactId] = 1; });
    var connectedContacts = {}; callsIn.forEach(function (c) { if (c.connected && c.contactId) connectedContacts[c.contactId] = 1; });

    function channel(kind) {
      var isSms = kind === 'sms';
      var credited = qualified.filter(function (q) { return (isSms ? q.t.sms : q.t.dials) > 0; })
        .map(function (q) { return { opp: q.opp, rep: (isSms ? q.t.lastSmsRep : q.t.lastDialRep) || 'Unknown', t: q.t }; })
        .filter(function (q) { return repOk(q.rep); });
      var acts = isSms ? smsOut : callsIn;
      var reps = {};
      acts.forEach(function (a) { var r = a.rep || 'Unknown'; var row = reps[r] || (reps[r] = { rep: r, touches: 0, contacts: {}, qualified: 0 }); row.touches++; if (a.contactId) row.contacts[a.contactId] = 1; });
      credited.forEach(function (q) { var row = reps[q.rep] || (reps[q.rep] = { rep: q.rep, touches: 0, contacts: {}, qualified: 0 }); row.qualified++; });
      var contactsTouched = Object.keys(acts.reduce(function (m, a) { if (a.contactId) m[a.contactId] = 1; return m; }, {})).length;
      var out = {
        touches: acts.length, contactsTouched: contactsTouched,
        engaged: isSms ? Object.keys(replied).length : Object.keys(connectedContacts).length,
        qualified: credited.length,
        perQualified: round(ratio(acts.length, credited.length), 1),
        contactRate: round(ratio(credited.length, contactsTouched), 4),
        engagedRate: round(ratio(isSms ? Object.keys(replied).length : Object.keys(connectedContacts).length, contactsTouched), 4),
        bothChannels: credited.filter(function (q) { return q.t.dials > 0 && q.t.sms > 0; }).length,
        byRep: Object.keys(reps).map(function (k) { var r = reps[k]; var n = Object.keys(r.contacts).length;
          return { rep: r.rep, touches: r.touches, contacts: n, qualified: r.qualified, perQualified: round(ratio(r.touches, r.qualified), 1), contactRate: round(ratio(r.qualified, n), 4) }; })
          .sort(function (a, b) { return b.qualified - a.qualified || b.touches - a.touches; })
      };
      if (isSms) { out.smsSent = out.touches; out.contactsTexted = contactsTouched; out.contactsReplied = out.engaged; out.smsPerQualified = out.perQualified; }
      else { out.dials = out.touches; out.contactsDialed = contactsTouched; out.contactsConnected = out.engaged; out.dialsPerQualified = out.perQualified; }
      return out;
    }
    var smsToQualified = channel('sms');
    var dialsToQualified = channel('dial');

    // ---------- Ledger ----------
    var fees = (data.deals || []).filter(function (d) { return d.feeReceivedDate && d.feeReceived && dayKey(d.feeReceivedDate + (d.feeReceivedDate.length === 10 ? 'T20:00:00Z' : ''), tz) >= from && dayKey(d.feeReceivedDate + (d.feeReceivedDate.length === 10 ? 'T20:00:00Z' : ''), tz) <= to; });
    var ledger = { connected: !!(data.deals && data.deals.length), feesReceived: round(sum(fees, function (d) { return d.feeReceived; }), 0), dealsPaid: fees.length };

    // Per-period trend (aligned with range.periods) for sparklines.
    var idx = {}; pkeys.forEach(function (k, i) { idx[k] = i; });
    var z = function () { return pkeys.map(function () { return 0; }); };
    var trend = { dials: z(), connected: z(), opportunities: z(), dialQualified: z(), sms: z(), smsQualified: z(), fees: z() };
    var bump = function (arr, at) { var i = idx[bucketOf(dayKey(at, tz), period)]; if (i != null) arr[i]++; };
    callsIn.forEach(function (c) { bump(trend.dials, c.at); if (c.connected) bump(trend.connected, c.at); });
    oppsIn.forEach(function (o) { bump(trend.opportunities, o.createdAt); });
    smsOut.forEach(function (m) { bump(trend.sms, m.at); });
    qualified.forEach(function (q) {
      if (q.t.dials > 0 && repOk(q.t.lastDialRep || 'Unknown')) bump(trend.dialQualified, q.opp.createdAt);
      if (q.t.sms > 0 && repOk(q.t.lastSmsRep || 'Unknown')) bump(trend.smsQualified, q.opp.createdAt);
    });
    fees.forEach(function (d) { var i = idx[bucketOf(d.feeReceivedDate.slice(0, 10), period)]; if (i != null) trend.fees[i] += Number(d.feeReceived) || 0; });

    var cfg = Object.assign({}, ALERT_DEFAULTS, options.alertConfig || {});
    var qualifiedContacts = {}; Object.keys(firstByContact).forEach(function (cid) { qualifiedContacts[cid] = Date.parse(firstByContact[cid].createdAt); });
    var nowMs = options.now || Date.now();
    var signals = options.lite ? liteSignals(data, { tz: tz, from: from, to: to, repOk: repOk }) : signalsSection(data, { tz: tz, from: from, to: to, now: nowMs, cfg: cfg, repOk: repOk, qualifiedContacts: qualifiedContacts, qualifying: qualifying, baseline: options.baseline });
    // Conversations per qualified lead: qualified (last dial credit) per 100 calls of 60s or more
    var credit = {}; dialsToQualified.byRep.forEach(function (r) { credit[r.rep] = r.qualified; });
    callRows.forEach(function (r) { r.qualified = credit[r.rep] || 0; r.qualPer100Conv = round(ratio((credit[r.rep] || 0) * 100, r.over60), 1); });
    callTotals.qualPer100Conv = round(ratio(dialsToQualified.qualified * 100, callTotals.over60), 1);
    var accounting = accountingSection(data, { from: from, to: to, tz: tz, period: period, pkeys: pkeys, bucketOf: bucketOf, qualified: qualified.length, opportunities: opportunities.total });

    var allReps = {};
    calls.forEach(function (c) { allReps[c.rep || 'Unknown'] = 1; });
    sms.forEach(function (m) { if (m.direction === 'outbound') allReps[m.rep || 'Unknown'] = 1; });
    opps.forEach(function (o) { if (o.rep) allReps[o.rep] = 1; });

    var result = {
      range: { from: from, to: to, days: daysInclusive(from, to), period: period, periods: pkeys, timezone: tz, rep: rep || null },
      reps: Object.keys(allReps).sort(),
      kpis: {
        dials: callTotals.dials, connectRate: callTotals.connectRate, talkMinutes: callTotals.talkMinutes,
        opportunities: opportunities.total, pipelineValue: opportunities.value,
        dialsPerQualified: dialsToQualified.dialsPerQualified, smsPerQualified: smsToQualified.smsPerQualified,
        smsSent: smsToQualified.smsSent, feesReceived: ledger.feesReceived,
        optOutRate: signals.replyQuality.optOutRate, speedToLeadMinutes: signals.speedToLead.medianMinutes, within5: signals.speedToLead.within5
      },
      trend: trend,
      callsByUser: { totals: callTotals, rows: callRows },
      opportunities: opportunities,
      smsToQualified: smsToQualified,
      dialsToQualified: dialsToQualified,
      ledger: ledger,
      accounting: accounting,
      signals: signals,
      definitions: {
        dial: 'One dialer line attempt with a saved disposition (auto or manual).',
        connected: 'The dialer connected the agent to that line.',
        qualified: 'A contact\'s first opportunity in an ACQ or Retail pipeline, dated by its creation.',
        touch: 'A dial or outbound SMS to the contact before qualification, inside the ' + (options.lookbackDays || 60) + '-day lookback.',
        credit: 'Last touch of that channel gets the credit. One credit per qualified lead.'
      }
    };
    if (options.compare) {
      var n = daysInclusive(from, to);
      var prev = compute(data, Object.assign({}, options, { from: shiftDay(from, -n), to: shiftDay(from, -1), compare: false, period: period, lite: true }));
      result.previous = { range: prev.range, kpis: prev.kpis };
    }
    var todayKey = dayKey(nowMs, tz);
    result.alerts = !options.lite && to === todayKey && !rep ? alertsFrom(signals, { cfg: cfg, today: todayKey, baselineOptOut: options.baselineOptOut != null ? options.baselineOptOut : (result.previous ? result.previous.kpis.optOutRate : null) }) : [];
    result.insights = insights(result);
    return result;
  }

  // ---------- SMS reply classifier (same rules as the data dashboard) ----------
  var OPT_OUT = /\b(stop|stopall|unsubscribe|cancel|end|quit|remove me|take me off|do not (?:text|contact|message)|don'?t (?:text|contact|message)|never contact)\b/i;
  var STRONG_NEG = /\b(not interested|wrong (?:person|number)|already sold|property (?:is )?sold|do not want|don'?t want|leave me alone|not for sale|no thanks|no thank you|hard pass|please don'?t|not anymore)\b/i;
  var POSITIVE = /\b(yes|yeah|yep|sure|interested|tell me more|send (?:me )?(?:info|information|details)|call me|give me a call|sounds good|let'?s (?:talk|chat|do it)|what(?:'s| is) (?:the|your) offer|how much|make (?:me )?an offer|open to (?:an offer|talking)|when can (?:you|we)|available to talk|no problem)\b/i;
  var BARE_NEG = /^\s*(?:no|nope|nah|pass)(?:\s*[.!?])?\s*$/i;
  function classify(body) {
    var t = String(body || '').trim();
    if (OPT_OUT.test(t)) return 'optout';
    if (STRONG_NEG.test(t)) return 'negative';
    if (POSITIVE.test(t)) return 'positive';
    if (BARE_NEG.test(t)) return 'negative';
    return 'neutral';
  }
  var AUTOMATED = /^(workflow|automation|campaign|bulk|unknown)?$/i;
  var DEAD_DISPOSITIONS = { 'dnc': 1, 'incorrect-number': 1, 'not-interested': 1, 'not-qualified-on-market': 1 };
  var CONTRACT = /inspection|pending|closed|escrow|under contract/i, VERBAL = /verbal/i;

  // Per-contact timeline of leads (seller reached out) and touches (we reached out).
  function timelines(data) {
    var map = {};
    var add = function (cid, e) { if (!cid) return; (map[cid] || (map[cid] = [])).push(e); };
    (data.calls || []).forEach(function (c) { add(c.contactId, { t: Date.parse(c.at), kind: 'dial', live: true, rep: c.rep || 'Unknown', d: c.disposition || '', list: c.list || '', connected: !!c.connected }); });
    (data.sms || []).forEach(function (m) {
      if (m.direction === 'inbound') add(m.contactId, { t: Date.parse(m.at), kind: 'reply', cat: m.category || classify(m.body), body: m.body || '' });
      else add(m.contactId, { t: Date.parse(m.at), kind: 'text', live: !AUTOMATED.test(m.rep || ''), rep: m.rep || 'Automation' });
    });
    (data.inboundCalls || []).forEach(function (c) { add(c.contactId, { t: Date.parse(c.at), kind: 'inbound-call' }); });
    Object.keys(map).forEach(function (k) { map[k].sort(function (a, b) { return a.t - b.t; }); });
    return map;
  }

  // Response episodes: a seller reply or inbound call opens one, the first live rep touch (rep text or dial) closes it.
  // Opt-out and negative replies need no response and never open an episode.
  function episodes(tl) {
    var out = [];
    Object.keys(tl).forEach(function (cid) {
      var open = null;
      tl[cid].forEach(function (e) {
        if (e.kind === 'reply' || e.kind === 'inbound-call') {
          var needs = e.kind === 'inbound-call' || e.cat === 'positive' || e.cat === 'neutral';
          if (!open && needs) open = { contactId: cid, t: e.t, hot: e.kind === 'inbound-call' || e.cat === 'positive', call: e.kind === 'inbound-call', body: e.body || '' };
          else if (open && (e.cat === 'positive' || e.kind === 'inbound-call')) { open.hot = true; if (e.body) open.body = e.body; }
          else if (open && (e.cat === 'optout' || e.cat === 'negative')) open = null;
        } else if (e.live && open) { open.closed = e.t; open.rep = e.rep; open.minutes = (e.t - open.t) / 60000; out.push(open); open = null; }
      });
      if (open) out.push(open);
    });
    return out;
  }

  function signalsSection(data, ctx) {
    var tz = ctx.tz, nowMs = ctx.now, cfg = ctx.cfg;
    var tl = timelines(data), eps = episodes(tl);
    var hourOf = function (t) { return parts(t, tz).hour; };
    var inR = function (t) { var d = dayKey(t, tz); return d >= ctx.from && d <= ctx.to; };
    var repOk = ctx.repOk;

    // 1. Speed to lead (episodes that started 9am to 9pm Pacific, inside the range)
    var bh = eps.filter(function (e) { var h = hourOf(e.t); return inR(e.t) && h >= 9 && h < 21; });
    var answered = bh.filter(function (e) { return e.closed && repOk(e.rep); });
    var mins = answered.map(function (e) { return e.minutes; });
    var byRepS = {};
    answered.forEach(function (e) { (byRepS[e.rep] || (byRepS[e.rep] = [])).push(e.minutes); });
    var speedToLead = {
      leads: bh.length, answered: answered.length, unanswered: bh.filter(function (e) { return !e.closed; }).length,
      medianMinutes: round(median(mins), 1), within5: round(ratio(mins.filter(function (m) { return m <= 5; }).length, mins.length), 4),
      byRep: Object.keys(byRepS).map(function (r) { var l = byRepS[r]; return { rep: r, answered: l.length, medianMinutes: round(median(l), 1), within5: round(ratio(l.filter(function (m) { return m <= 5; }).length, l.length), 4) }; })
        .sort(function (a, b) { return a.medianMinutes - b.medianMinutes; })
    };

    // 2. Hot replies waiting right now (positive text or inbound call, no live touch yet, last 48h)
    var waiting = eps.filter(function (e) { return !e.closed && e.hot && nowMs - e.t <= 48 * 3600000 && e.t <= nowMs; })
      .map(function (e) { return { contactId: e.contactId, at: new Date(e.t).toISOString(), waitMinutes: Math.round((nowMs - e.t) / 60000), call: !!e.call, snippet: String(e.body || '').slice(0, 90) }; })
      .sort(function (a, b) { return b.waitMinutes - a.waitMinutes; });
    var hotReplies = { waiting: waiting.length, oldestMinutes: waiting.length ? waiting[0].waitMinutes : null, overThreshold: waiting.filter(function (w) { return w.waitMinutes >= cfg.replyWaitMinutes; }).length, list: waiting.slice(0, 25) };

    // 3. Reply quality in range
    var rq = { positive: 0, negative: 0, optout: 0, neutral: 0 }, texted = {};
    (data.sms || []).forEach(function (m) {
      if (!inR(Date.parse(m.at))) return;
      if (m.direction === 'inbound') rq[m.category || classify(m.body)]++;
      else if (repOk(m.rep || 'Unknown')) texted[m.contactId] = 1;
    });
    var replies = rq.positive + rq.negative + rq.optout + rq.neutral, nTexted = Object.keys(texted).length;
    var replyQuality = { replies: replies, positive: rq.positive, negative: rq.negative, optOut: rq.optout, neutral: rq.neutral,
      positiveRate: round(ratio(rq.positive, replies), 4), negativeRate: round(ratio(rq.negative, replies), 4), optOutShare: round(ratio(rq.optout, replies), 4),
      optOutRate: round(ratio(rq.optout, nTexted), 4), contactsTexted: nTexted };

    // 4. Leads dropped early: 1 to 3 touches, idle 7+ days, inside the 60 days before the range end, never qualified, not dead
    var endMs = Date.parse(shiftDay(ctx.to, 1) + 'T08:00:00Z'), anchor = Math.min(endMs, nowMs);
    var dropped = [], byRepD = {}, byListD = {};
    Object.keys(tl).forEach(function (cid) {
      if (ctx.qualifiedContacts[cid]) return;
      var touches = 0, last = null, lastDial = null, dead = false, engaged = false;
      tl[cid].forEach(function (e) {
        if (e.t > anchor || e.t < anchor - 60 * DAY) return;
        if (e.kind === 'dial' || e.kind === 'text') { touches++; last = e; if (e.kind === 'dial') { lastDial = e; if (e.connected) engaged = true; } if (DEAD_DISPOSITIONS[e.d]) dead = true; }
        if (e.kind === 'reply') { if (e.cat === 'optout' || e.cat === 'negative') dead = true; else engaged = true; }
        if (e.kind === 'inbound-call') engaged = true;
      });
      // a lead = the seller engaged (connected call, reply or inbound call); a cold number with no answer is not a dropped lead
      if (dead || !engaged || touches < 1 || touches > 3 || anchor - last.t < 7 * DAY) return;
      var r = last.rep || 'Unknown'; if (!repOk(r)) return;
      var list = lastDial && lastDial.list ? lastDial.list : 'SMS only';
      dropped.push(cid); byRepD[r] = (byRepD[r] || 0) + 1; byListD[list] = (byListD[list] || 0) + 1;
    });
    var toRows = function (o) { return Object.keys(o).map(function (k) { return { key: k, count: o[k] }; }).sort(function (a, b) { return b.count - a.count; }); };
    var droppedEarly = { count: dropped.length, byRep: toRows(byRepD), byList: toRows(byListD) };

    // 5. Follow-up compliance: hot due in 24h, warm in 72h, worked = next live touch in time
    var fu = { hot: { due: 0, onTime: 0, overdue: 0, contacts: {} }, warm: { due: 0, onTime: 0, overdue: 0 } }, hotToOpp = 0, hotContacts = 0;
    Object.keys(tl).forEach(function (cid) {
      var ev = tl[cid];
      ev.forEach(function (e, i) {
        var kind = e.d === 'follow-up-hot' ? 'hot' : e.d === 'follow-up-warm' ? 'warm' : null;
        if (!kind || !repOk(e.rep)) return;
        var due = e.t + (kind === 'hot' ? cfg.hotSlaHours : cfg.warmSlaHours) * 3600000;
        var next = null;
        for (var j = i + 1; j < ev.length; j++) if (ev[j].live) { next = ev[j]; break; }
        if (inR(e.t) && due <= nowMs) { fu[kind].due++; if (next && next.t <= due) fu[kind].onTime++; }
        if (!next && due <= nowMs && nowMs - due <= 14 * DAY) fu[kind].overdue++;
        if (kind === 'hot' && inR(e.t) && !fu.hot.contacts[cid]) { fu.hot.contacts[cid] = 1; hotContacts++; var q = ctx.qualifiedContacts[cid]; if (q && q > e.t) hotToOpp++; }
      });
    });
    var followUps = {
      hot: { due: fu.hot.due, onTime: fu.hot.onTime, rate: round(ratio(fu.hot.onTime, fu.hot.due), 4), overdue: fu.hot.overdue, slaHours: cfg.hotSlaHours },
      warm: { due: fu.warm.due, onTime: fu.warm.onTime, rate: round(ratio(fu.warm.onTime, fu.warm.due), 4), overdue: fu.warm.overdue, slaHours: cfg.warmSlaHours },
      hotToOpp: { contacts: hotContacts, opportunities: hotToOpp, rate: round(ratio(hotToOpp, hotContacts), 4) }
    };

    // 7. Caller ID health: range end day vs the 7 days before it
    var day = ctx.to, base0 = shiftDay(day, -7), num = {};
    (data.calls || []).forEach(function (c) {
      if (!c.callerId) return;
      var d = dayKey(c.at, tz); if (d < base0 || d > day) return;
      var n = num[c.callerId] || (num[c.callerId] = { number: c.callerId, reps: {}, today: [0, 0], base: [0, 0] });
      var cell = d === day ? n.today : n.base; cell[0]++; if (c.connected) cell[1]++; n.reps[c.rep || 'Unknown'] = (n.reps[c.rep || 'Unknown'] || 0) + 1;
    });
    var callerIds = Object.keys(num).map(function (k) {
      var n = num[k], b = ctx.baseline && ctx.baseline.callerIds && ctx.baseline.callerIds[k];
      var baseD = b ? b.dials : n.base[0], baseC = b ? b.connected : n.base[1];
      var rate = ratio(n.today[1], n.today[0]), baseRate = ratio(baseC, baseD);
      var change = rate != null && baseRate ? (rate - baseRate) / baseRate : null;
      var topRep = Object.keys(n.reps).sort(function (a, b2) { return n.reps[b2] - n.reps[a]; })[0];
      return { number: k, rep: topRep, dials: n.today[0], connectRate: round(rate, 4), baselineDials: baseD, baselineRate: round(baseRate, 4), change: round(change, 4),
        flagged: n.today[0] >= cfg.callerIdMinDials && baseD >= cfg.callerIdMinBaseline && change != null && change <= -cfg.callerIdDrop };
    }).filter(function (x) { return repOk(x.rep); }).sort(function (a, b) { return (b.flagged - a.flagged) || (a.change == null) - (b.change == null) || a.change - b.change; });

    // 8. List decay (dialer queue): bad number share and connect rate by week, last 8 weeks to the range end
    var weeks = []; for (var w = 7; w >= 0; w--) weeks.push(weekStart(shiftDay(ctx.to, -7 * w)));
    var lists = {};
    (data.calls || []).forEach(function (c) {
      if (!c.list || !repOk(c.rep || 'Unknown')) return;
      var d = dayKey(c.at, tz); if (d > ctx.to || d < weeks[0]) return;
      var L = lists[c.list] || (lists[c.list] = { list: c.list, w: {}, inRange: [0, 0, 0, 0] });
      var wk = weekStart(d), cell = L.w[wk] || (L.w[wk] = [0, 0, 0, 0]);
      var bad = c.disposition === 'incorrect-number', dnc = c.disposition === 'dnc';
      cell[0]++; if (c.connected) cell[1]++; if (bad) cell[2]++; if (dnc) cell[3]++;
      if (d >= ctx.from) { L.inRange[0]++; if (c.connected) L.inRange[1]++; if (bad) L.inRange[2]++; if (dnc) L.inRange[3]++; }
    });
    var listRows = Object.keys(lists).map(function (k) {
      var L = lists[k], r = L.inRange;
      var weekly = weeks.map(function (wk) { var c = L.w[wk] || [0, 0, 0, 0]; return { week: wk, dials: c[0], badRate: round(ratio(c[2] + c[3], c[0]), 4), connectRate: round(ratio(c[1], c[0]), 4) }; });
      var recent = weekly.slice(-2), prior = weekly.slice(0, 6), agg = function (a) { var d = sum(a, function (x) { return x.dials; }), b = sum(a, function (x) { return (x.badRate || 0) * x.dials; }); return ratio(b, d); };
      var rb = agg(recent), pb = agg(prior);
      return { list: k, dials: r[0], connectRate: round(ratio(r[1], r[0]), 4), wrongRate: round(ratio(r[2], r[0]), 4), dncRate: round(ratio(r[3], r[0]), 4), weekly: weekly,
        badRecent: round(rb, 4), badPrior: round(pb, 4), decaying: rb != null && pb != null && rb - pb >= 0.05 && rb >= pb * 1.4 };
    }).filter(function (x) { return x.dials > 0; }).sort(function (a, b) { return (b.decaying - a.decaying) || b.dials - a.dials; });

    // 9. Stage aging: open ACQ/Retail opportunities, days since the last stage change
    var open = (data.opportunities || []).filter(function (o) { return ctx.qualifying.test(o.pipeline || '') && String(o.status || 'open') === 'open' && !/closed/i.test(o.stage || '') && repOk(o.rep || 'Unassigned'); })
      .map(function (o) { var t = Date.parse(o.stageAt || o.updatedAt || o.createdAt); return { id: o.id, name: o.name || 'Opportunity', stage: o.stage || 'Unknown', rep: o.rep || 'Unassigned', days: Math.max(0, Math.floor((nowMs - t) / DAY)) }; });
    var stages = {};
    open.forEach(function (o) { (stages[o.stage] || (stages[o.stage] = [])).push(o); });
    var recentOpps = (data.opportunities || []).filter(function (o) { return ctx.qualifying.test(o.pipeline || '') && nowMs - Date.parse(o.createdAt) <= 90 * DAY; });
    var contracts = recentOpps.filter(function (o) { return CONTRACT.test(o.stage || ''); }).length, verbal = recentOpps.filter(function (o) { return VERBAL.test(o.stage || ''); }).length;
    var stuck = open.filter(function (o) { return o.days >= cfg.stuckDays; }).sort(function (a, b) { return b.days - a.days; });
    var stageAging = { open: open.length, stuck: stuck.length, stuckDays: cfg.stuckDays, medianDays: median(open.map(function (o) { return o.days; })),
      byStage: Object.keys(stages).map(function (k) { var l = stages[k]; return { stage: k, open: l.length, medianDays: median(l.map(function (o) { return o.days; })), stuck: l.filter(function (o) { return o.days >= cfg.stuckDays; }).length }; }).sort(function (a, b) { return b.stuck - a.stuck || b.open - a.open; }),
      verbalToContract: round(ratio(contracts, contracts + verbal), 4), verbalToContractBase: contracts + verbal, stuckList: stuck.slice(0, 10) };

    return { speedToLead: speedToLead, hotReplies: hotReplies, replyQuality: replyQuality, droppedEarly: droppedEarly, followUps: followUps, callerIds: callerIds, lists: listRows, stageAging: stageAging };
  }

  // Previous-period comparison only needs reply quality; skip the heavier timelines.
  function liteSignals(data, ctx) {
    var rq = { positive: 0, negative: 0, optout: 0, neutral: 0 }, texted = {};
    (data.sms || []).forEach(function (m) { var d = dayKey(m.at, ctx.tz); if (d < ctx.from || d > ctx.to) return; if (m.direction === 'inbound') rq[m.category || classify(m.body)]++; else if (ctx.repOk(m.rep || 'Unknown')) texted[m.contactId] = 1; });
    var n = Object.keys(texted).length;
    return { replyQuality: { optOut: rq.optout, optOutRate: round(ratio(rq.optout, n), 4), contactsTexted: n }, speedToLead: {} };
  }

  function waitText(m) { return m >= 120 ? (Math.round(m / 6) / 10) + ' h' : m + ' min'; }

  var ALERT_DEFAULTS = { replyWaitMinutes: 15, hotSlaHours: 24, warmSlaHours: 72, callerIdDrop: 0.4, callerIdMinDials: 20, callerIdMinBaseline: 100, stuckDays: 14, optOutSpike: 2, optOutMin: 5, overdueMin: 3 };

  // Alerts from signals. Each has a stable key so the server can send it once.
  function alertsFrom(sig, ctx) {
    var cfg = ctx.cfg, out = [], day = ctx.today;
    var hot = sig.hotReplies.list.filter(function (w) { return w.waitMinutes >= cfg.replyWaitMinutes; });
    if (hot.length) out.push({ key: 'hot', itemKeys: hot.map(function (w) { return 'hot:' + w.contactId + '@' + w.at; }), type: 'hot_replies', severity: 'high',
      title: hot.length + ' hot ' + (hot.length === 1 ? 'reply' : 'replies') + ' waiting', detail: 'Oldest ' + waitText(hot[0].waitMinutes) + '. No rep text or dial yet.', items: hot.slice(0, 5).map(function (w) { return { contactId: w.contactId, waitMinutes: w.waitMinutes, snippet: w.snippet, call: w.call }; }), view: 'sales' });
    sig.callerIds.filter(function (c) { return c.flagged; }).forEach(function (c) {
      out.push({ key: 'cid:' + c.number + ':' + day, type: 'caller_id', severity: 'high', title: 'Caller ID ' + c.number + ' connect rate down ' + Math.round(-c.change * 100) + '%',
        detail: (c.rep || 'Unknown') + ' · ' + pct(c.connectRate) + ' today on ' + c.dials + ' dials vs ' + pct(c.baselineRate) + ' 7-day average. Possible spam label.', view: 'sales' });
    });
    var base = ctx.baselineOptOut;
    if (base != null && sig.replyQuality.optOut >= cfg.optOutMin && sig.replyQuality.optOutRate != null && sig.replyQuality.optOutRate >= base * cfg.optOutSpike)
      out.push({ key: 'optout:' + day, type: 'opt_out', severity: 'medium', title: 'Opt-out rate ' + pct(sig.replyQuality.optOutRate) + ' today', detail: Math.round(sig.replyQuality.optOutRate / base * 10) / 10 + 'x the 7-day rate (' + pct(base) + '). Check the list or message.', view: 'sales' });
    if (sig.followUps.hot.overdue >= cfg.overdueMin)
      out.push({ key: 'fu:' + day + ':' + Math.floor(sig.followUps.hot.overdue / 5), type: 'follow_ups', severity: 'medium', title: sig.followUps.hot.overdue + ' hot follow-ups overdue', detail: 'Hot follow-ups with no dial or rep text within ' + cfg.hotSlaHours + 'h.', view: 'sales' });
    sig.lists.filter(function (l) { return l.decaying; }).slice(0, 2).forEach(function (l) {
      out.push({ key: 'list:' + l.list + ':' + weekStart(day), type: 'list_decay', severity: 'low', title: 'List "' + l.list + '" is decaying', detail: 'Bad numbers ' + pct(l.badRecent) + ' last 2 weeks vs ' + pct(l.badPrior) + ' before.', view: 'sales' });
    });
    return out;
  }

  // Ledger P&L for the range (cash basis: fees on received date, bills on payment date). Rep filter does not apply.
  function accountingSection(data, ctx) {
    var deals = data.deals || [], spend = data.spend || [];
    var connected = !!(deals.length || spend.length);
    var inR = function (d) { return d && d.slice(0, 10) >= ctx.from && d.slice(0, 10) <= ctx.to; };
    var opps = {}; (data.opportunities || []).forEach(function (o) { opps[o.id] = o; });
    var paid = deals.filter(function (d) { return d.feeReceived && inR(d.feeReceivedDate); });
    var revenue = sum(paid, function (d) { return d.feeReceived; });
    var closingCosts = sum(paid, function (d) { return d.closingCosts; });
    var spendIn = spend.filter(function (x) { return inR(x.date); });
    var bySection = { leadgen: 0, deal: 0, opex: 0, below: 0 }, byCat = {};
    spendIn.forEach(function (x) { var sec = x.section || sectionOf(x.category); bySection[sec] += Number(x.amount) || 0; byCat[x.category] = (byCat[x.category] || 0) + (Number(x.amount) || 0); });
    var dealCosts = closingCosts + bySection.deal;
    var net = revenue - dealCosts - bySection.leadgen - bySection.opex;
    var pending = deals.filter(function (d) { return !d.feeReceived && d.assignmentFee && d.emdStatus !== 'refunded' && d.emdStatus !== 'forfeited' && (!opps[d.opportunityId] || !/declin|lost|dead/i.test((opps[d.opportunityId].stage || '') + ' ' + (opps[d.opportunityId].status || ''))); });
    var days = paid.filter(function (d) { return d.contractDate; }).map(function (d) { return Math.max(0, Math.round((Date.parse(d.feeReceivedDate.slice(0, 10)) - Date.parse(d.contractDate.slice(0, 10))) / DAY)); });
    // Money is lumpy, so the trend uses wider buckets than the call charts: day up to 14 days, week up to 120, then month.
    var nd = daysInclusive(ctx.from, ctx.to), aPeriod = nd <= 14 ? 'day' : nd <= 120 ? 'week' : 'month', aKeys = periodKeys(ctx.from, ctx.to, aPeriod);
    var idx = {}; aKeys.forEach(function (k, i) { idx[k] = i; });
    var tRev = aKeys.map(function () { return 0; }), tSpend = aKeys.map(function () { return 0; });
    paid.forEach(function (d) { var i = idx[bucketOf(d.feeReceivedDate.slice(0, 10), aPeriod)]; if (i != null) tRev[i] += d.feeReceived; });
    spendIn.forEach(function (x) { if ((x.section || sectionOf(x.category)) === 'below') return; var i = idx[bucketOf(x.date.slice(0, 10), aPeriod)]; if (i != null) tSpend[i] += Number(x.amount) || 0; });
    return {
      connected: connected,
      revenue: round(revenue, 0), dealsPaid: paid.length, avgFee: round(ratio(revenue, paid.length), 0),
      dealCosts: round(dealCosts, 0), leadGen: round(bySection.leadgen, 0), opex: round(bySection.opex, 0), belowTheLine: round(bySection.below, 0), net: round(net, 0),
      margin: round(ratio(net, revenue), 4),
      feesPending: round(sum(pending, function (d) { return d.assignmentFee; }), 0), dealsPending: pending.length,
      emdAtRisk: round(sum(deals.filter(function (d) { return d.emdStatus === 'held'; }), function (d) { return d.emdAmount; }), 0),
      avgDaysToClose: days.length ? round(sum(days, function (x) { return x; }) / days.length, 0) : null,
      leadGenPerQualified: round(ratio(bySection.leadgen, ctx.qualified), 0), leadGenPerOpportunity: round(ratio(bySection.leadgen, ctx.opportunities), 0), leadGenPerDeal: round(ratio(bySection.leadgen, paid.length), 0),
      apOwed: data.ap ? round(data.ap.owed, 0) : null, apBills: data.ap ? data.ap.count : null,
      period: aPeriod, periods: aKeys,
      trend: { revenue: tRev.map(function (v) { return round(v, 0); }), spend: tSpend.map(function (v) { return round(v, 0); }) },
      spendByCategory: Object.keys(byCat).map(function (k) { return { key: k, section: sectionOf(k), amount: round(byCat[k], 0) }; }).filter(function (x) { return x.section !== 'below'; }).sort(function (a, b) { return b.amount - a.amount; }),
      pendingDeals: pending.map(function (d) { var o = opps[d.opportunityId] || {}; return { opportunityId: d.opportunityId, name: d.propertyAddress || o.name || 'Deal', stage: o.stage || '', fee: d.assignmentFee, expectedCloseDate: d.expectedCloseDate || null, emdAmount: d.emdAmount || null, emdStatus: d.emdStatus || 'none' }; })
        .sort(function (a, b) { return String(a.expectedCloseDate || '9').localeCompare(String(b.expectedCloseDate || '9')); }),
      recentPaid: paid.slice().sort(function (a, b) { return b.feeReceivedDate.localeCompare(a.feeReceivedDate); }).slice(0, 8).map(function (d) { var o = opps[d.opportunityId] || {}; return { name: d.propertyAddress || o.name || 'Deal', fee: d.feeReceived, date: d.feeReceivedDate.slice(0, 10) }; })
    };
  }

  // Rule-based observations. Shown when Groq is not configured and passed to Groq as hints.
  function insights(r) {
    var out = [];
    var rows = r.callsByUser.rows.filter(function (x) { return x.dials >= 20; });
    if (r.callsByUser.rows[0]) out.push(r.callsByUser.rows[0].rep + ' made the most dials (' + r.callsByUser.rows[0].dials + ', ' + pct(r.callsByUser.rows[0].connectRate) + ' connected).');
    var best = rows.slice().sort(function (a, b) { return b.connectRate - a.connectRate; })[0];
    if (best && best !== r.callsByUser.rows[0]) out.push(best.rep + ' has the best connect rate at ' + pct(best.connectRate) + ' (min 20 dials).');
    if (r.opportunities.byCity[0] && r.opportunities.byCity[0].key !== 'Unknown') out.push(r.opportunities.byCity[0].key + ' leads opportunities: ' + r.opportunities.byCity[0].count + ' of ' + r.opportunities.total + '.');
    var tb = r.opportunities.byTouches.slice().sort(function (a, b) { return b.count - a.count; })[0];
    if (tb && tb.count) out.push('Most opportunities came after ' + tb.key + ' touches (' + pct(tb.share) + '). Median: ' + r.opportunities.medianTouches + '.');
    var d = r.dialsToQualified.dialsPerQualified, s = r.smsToQualified.smsPerQualified;
    if (d && s) out.push('It takes ' + d + ' dials or ' + s + ' texts per qualified lead.');
    else if (d) out.push('It takes ' + d + ' dials per qualified lead. No SMS-credited leads in range.');
    var wd = r.opportunities.byWeekday.slice().sort(function (a, b) { return b.count - a.count; })[0];
    if (wd && wd.count) out.push(wd.key + ' is the strongest day for new opportunities (' + wd.count + ').');
    return out;
  }
  function pct(v) { return v == null ? 'n/a' : (Math.round(v * 1000) / 10) + '%'; }

  return { classify: classify, alertsFrom: alertsFrom, signalsSection: signalsSection, ALERT_DEFAULTS: ALERT_DEFAULTS, OUTCOMES: OUTCOMES, sectionOf: sectionOf, compute: compute, presetRange: presetRange, dayKey: dayKey, shiftDay: shiftDay, periodFor: periodFor, touchBucket: touchBucket, insights: insights, pct: pct, TZ: TZ };
});
