/* Deterministic SAMPLE data in the normalized shape (dialer + GHL + Ledger).
 * Used by the sandbox and by DATA_MODE=sample. Never mixed with live data. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LcpSample = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var REPS = [
    ['Jesse Pickar', 1.0, 0.17], ['Arturo Vazquez', 1.25, 0.15], ['Bryce Roman-Tooley', 1.1, 0.19], ['Carlos Marroquin', 0.9, 0.14],
    ['Gavin Hambright', 1.2, 0.21], ['Tino Vasquez', 0.75, 0.13], ['Zeth Vasquez', 0.85, 0.16], ['Seth Roman', 0.6, 0.18]
  ];
  var CITIES = [['Long Beach', ['90805', '90806', '90813']], ['Compton', ['90220', '90221']], ['Anaheim', ['92801', '92804']], ['Santa Ana', ['92701', '92703']],
    ['Riverside', ['92503', '92504']], ['Inglewood', ['90301', '90303']], ['Downey', ['90240', '90241']], ['Pomona', ['91766', '91767']]];
  var CITY_W = [0.22, 0.14, 0.12, 0.12, 0.13, 0.1, 0.09, 0.08];
  var NO_CONNECT = ['no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'no-answer-voicemail', 'incorrect-number', 'dnc'];
  var CONNECT = ['not-interested', 'not-interested', 'follow-up-cold', 'follow-up-warm', 'follow-up-hot', 'spanish', 'not-qualified-on-market'];
  var LISTS = [['Absentee Owners', 0.3], ['Tax Delinquent', 0.2], ['Probate', 0.15], ['Pre-Foreclosure', 0.15], ['Vacant', 0.1], ['Expired Listings', 0.1]];
  var BODIES = {
    positive: ['Yes I own it, what is your offer?', 'Sure, call me after 5', 'How much would you pay?', 'I might be open to an offer', 'Yes, tell me more', 'Call me tomorrow morning'],
    neutral: ['Who is this?', 'Which property?', 'Maybe next year', 'What company is this?', 'I have a few properties', 'Depends on the price'],
    negative: ['Not interested', 'Wrong number', 'Already sold it', 'No thanks', 'Not for sale'],
    optout: ['STOP', 'Stop texting me', 'Remove me from your list', 'Unsubscribe']
  };
  var STAGES = ['New Lead', 'New Lead', 'Run Numbers', 'Eval Done', 'Offer Sent', 'Verbal Acceptance', 'Inspection Period', 'Pending', 'Closed', 'Offer Declined- Warm', 'Not Ready'];

  function rng(seed) { var s = seed >>> 0; return function () { s = (s + 0x6D2B79F5) >>> 0; var t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  function pickW(r, weights) { var x = r(), acc = 0; for (var i = 0; i < weights.length; i++) { acc += weights[i]; if (x <= acc) return i; } return weights.length - 1; }

  // Pacific business hours as UTC ms (PST offset 8h, PDT 7h approximated by month).
  function pacific(dayStartUtc, hour, minute) { var m = new Date(dayStartUtc).getUTCMonth(); var off = m >= 2 && m <= 10 ? 7 : 8; return dayStartUtc + ((hour + off) * 60 + minute) * 60000; }

  function generate(opts) {
    opts = opts || {};
    var r = rng(opts.seed || 20261115);
    var days = opts.days || 120;
    var now = opts.now || Date.now();
    var today = new Date(now); today.setUTCHours(0, 0, 0, 0);
    var contacts = [], calls = [], sms = [], opportunities = [], deals = [];
    var N = opts.contacts || 14000;
    for (var i = 0; i < N; i++) {
      var ci = pickW(r, CITY_W), city = CITIES[ci];
      contacts.push({ id: 'c' + i, name: 'Sample Seller ' + (i + 1), city: city[0], zip: city[1][Math.floor(r() * city[1].length)], heat: 0.3 + r() * (ci === 0 || ci === 4 ? 1.2 : 0.9), list: LISTS[pickW(r, LISTS.map(function (l) { return l[1]; }))][0] });
    }
    var touchLog = {};
    function log(cid, t, rep, ch, good) { (touchLog[cid] || (touchLog[cid] = [])).push({ t: t, rep: rep, ch: ch, good: good }); }
    var callN = 0, smsN = 0, inboundCalls = [];
    // Two caller IDs per rep (sample numbers). Rep 2's main line is spam-flagged today.
    var NUMBERS = REPS.map(function (_, i) { return ['+1555' + (100 + i) + (1000 + i * 7), '+1555' + (200 + i) + (2000 + i * 7)]; });
    var todayKey = new Date(now - 8 * 3600000).toISOString().slice(0, 10);
    function addCall(c, t, repIdx, forceConnect) {
      var rep = REPS[repIdx], num = NUMBERS[repIdx][r() < 0.7 ? 0 : 1];
      var spam = repIdx === 1 && num === NUMBERS[1][0] && new Date(t - 8 * 3600000).toISOString().slice(0, 10) === todayKey;
      var connected = forceConnect != null ? forceConnect : r() < rep[2] * (0.7 + c.heat * 0.4) * (spam ? 0.3 : 1);
      var disp = connected ? CONNECT[Math.floor(r() * CONNECT.length)] : NO_CONNECT[Math.floor(r() * NO_CONNECT.length)];
      if (!connected && c.list === 'Expired Listings' && now - t < 16 * 86400000 && r() < 0.35) disp = 'incorrect-number';
      var du = connected ? Math.round(20 + r() * r() * 600) : (r() < 0.3 ? Math.round(15 + r() * 25) : 0);
      calls.push({ id: 'call' + (callN++), at: new Date(t).toISOString(), rep: rep[0], contactId: c.id, disposition: disp, connected: connected, duration: du, callerId: num, list: c.list });
      log(c.id, t, rep[0], 'dial', connected && /warm|hot/.test(disp));
      return disp;
    }
    function respondMs(t) { var h = Number(new Date(t - 8 * 3600000).toISOString().slice(11, 13)); var m = Math.exp(Math.log(6) + (r() - 0.5) * 2.6); if (h < 9 || h >= 21) m += ((h >= 21 ? 33 - h : 9 - h) * 60); return Math.round(m * 60000); }
    for (var d = days - 1; d >= 0; d--) {
      var dayUtc = today.getTime() - d * 86400000;
      var dow = new Date(dayUtc).getUTCDay();
      var dayFactor = dow === 0 ? 0.25 : dow === 6 ? 0.3 : 1;
      REPS.forEach(function (rep) {
        if (r() < 0.06) return; // day off
        var n = Math.round((60 + r() * 90) * rep[1] * dayFactor);
        for (var k = 0; k < n; k++) {
          var c = contacts[Math.floor(Math.pow(r(), 1.15) * N)];
          var t = pacific(dayUtc, 9 + Math.floor(r() * 9), Math.floor(r() * 60));
          if (t > now) continue;
          var repIdx = REPS.indexOf(rep), disp = addCall(c, t, repIdx);
          // follow-up worked later by the same rep (hot usually within 24h, warm within 72h)
          if (disp === 'follow-up-hot' || disp === 'follow-up-warm') {
            var hot = disp === 'follow-up-hot', p2 = hot ? 0.72 : 0.6;
            if (r() < p2) { var later = t + (hot ? (r() < 0.75 ? 2 + r() * 20 : 26 + r() * 30) : (r() < 0.7 ? 10 + r() * 55 : 75 + r() * 60)) * 3600000; if (later < now) addCall(c, later, repIdx); }
          }
        }
      });
      // SMS: workflow blasts plus rep follow-ups
      var texts = Math.round((180 + r() * 160) * dayFactor);
      for (var s = 0; s < texts; s++) {
        var cc = contacts[Math.min(N - 1, Math.floor((1 - Math.pow(r(), 1.6)) * N))];
        var ts = pacific(dayUtc, 8 + Math.floor(r() * 11), Math.floor(r() * 60));
        if (ts > now) continue;
        var srep = r() < 0.55 ? REPS[Math.floor(r() * REPS.length)][0] : 'Workflow';
        sms.push({ id: 'sms' + (smsN++), at: new Date(ts).toISOString(), rep: srep, contactId: cc.id, direction: 'outbound' });
        var replies = r() < 0.07 * (0.6 + cc.heat * 0.5);
        log(cc.id, ts, srep, 'sms', replies && r() < 0.45);
        if (replies && ts + 3600000 < now) {
          var cat = ['positive', 'neutral', 'negative', 'optout'][pickW(r, [0.22, 0.38, 0.28, 0.12])], tr = ts + Math.round(r() * 5 * 3600000), list2 = BODIES[cat];
          sms.push({ id: 'sms' + (smsN++), at: new Date(tr).toISOString(), rep: '', contactId: cc.id, direction: 'inbound', body: list2[Math.floor(r() * list2.length)] });
          if ((cat === 'positive' || cat === 'neutral') && r() < 0.9) { var tResp = tr + respondMs(tr); if (tResp < now) sms.push({ id: 'sms' + (smsN++), at: new Date(tResp).toISOString(), rep: REPS[Math.floor(r() * REPS.length)][0], contactId: cc.id, direction: 'outbound' }); }
        }
      }
      // inbound seller calls, usually called back
      for (var ic = 0; ic < Math.round(10 * dayFactor); ic++) {
        var c3 = contacts[Math.floor(r() * N)], ti = pacific(dayUtc, 8 + Math.floor(r() * 12), Math.floor(r() * 60));
        if (ti > now) continue;
        inboundCalls.push({ id: 'in' + ic + '-' + d, at: new Date(ti).toISOString(), contactId: c3.id });
        if (r() < 0.85) { var tb = ti + respondMs(ti) * 1.5; if (tb < now) addCall(c3, tb, Math.floor(r() * REPS.length), true); }
      }
    }
    // Opportunities: created shortly after a good touch, more likely with more touches.
    var oppN = 0;
    contacts.forEach(function (c) {
      var list = touchLog[c.id]; if (!list) return;
      list.sort(function (a, b) { return a.t - b.t; });
      for (var i = 0; i < list.length; i++) {
        var tch = list[i]; if (!tch.good) continue;
        var p = Math.min(0.6, 0.18 + i * 0.06) * (0.6 + c.heat * 0.5);
        if (r() > p) continue;
        var created = tch.t + Math.round((5 + r() * 90) * 60000);
        if (created > now) break;
        var pr = r(), pipeline = pr < 0.86 ? 'ACQ Pipeline' : pr < 0.95 ? 'Retail Pipeline' : 'Dispo Pipeline';
        var stage = STAGES[Math.floor(r() * STAGES.length)];
        if (/Inspection|Pending|Closed/.test(stage) && r() > 0.12) stage = ['New Lead', 'Run Numbers', 'Not Ready', 'Offer Declined- Warm'][Math.floor(r() * 4)];
        var ageDays = (now - created) / 86400000;
        if (ageDays < 10 && /Pending|Closed|Inspection/.test(stage)) stage = 'Run Numbers';
        var value = Math.round((14000 + r() * 46000) / 500) * 500;
        var status0 = /Declined/.test(stage) ? 'lost' : stage === 'Closed' ? 'won' : 'open';
        if (status0 === 'open' && ageDays > 35 && !/Inspection|Pending/.test(stage) && r() < 0.8) status0 = 'lost';
        var stageAt = new Date(created + r() * Math.min(ageDays, 30) * 86400000).toISOString();
        var id = 'opp' + (oppN++);
        var oppRep = tch.rep === 'Workflow' ? REPS[Math.floor(r() * REPS.length)][0] : tch.rep;
        opportunities.push({ id: id, contactId: c.id, name: (100 + Math.floor(r() * 9800)) + ' Sample Ave, ' + c.city, createdAt: new Date(created).toISOString(), rep: oppRep,
          pipeline: pipeline, stage: stage, status: status0, value: value, stageAt: stageAt });
        if (/Inspection|Pending|Closed/.test(stage)) {
          var fee = Math.round((7000 + r() * 18000) / 250) * 250;
          var paid = stage === 'Closed';
          if (!paid && ageDays > 50) { stage = 'Offer Declined- Warm'; opportunities[opportunities.length - 1].stage = stage; opportunities[opportunities.length - 1].status = 'lost'; }
          var contractAt = new Date(created + (3 + r() * 6) * 86400000).toISOString().slice(0, 10);
          var paidAt = paid ? new Date(Math.min(now, created + (18 + r() * 25) * 86400000)).toISOString().slice(0, 10) : null;
          var emd = Math.round((1000 + r() * 4000) / 500) * 500;
          deals.push({ opportunityId: id, propertyAddress: null, assignmentFee: fee, contractPrice: Math.round((180000 + r() * 420000) / 1000) * 1000, feeReceived: paid ? fee : null, feeReceivedDate: paidAt,
            contractDate: contractAt, expectedCloseDate: paid ? null : new Date(created + (25 + r() * 30) * 86400000).toISOString().slice(0, 10),
            emdAmount: emd, emdStatus: paid || ageDays > 50 ? 'refunded' : 'held', closingCosts: paid ? Math.round(300 + r() * 1500) : null });
        }
        break;
      }
    });
    // three hot replies nobody has answered yet
    [8, 27, 52].forEach(function (m, i) { var c4 = contacts[N - 1 - i]; sms.push({ id: 'hot' + i, at: new Date(now - m * 60000).toISOString(), rep: '', contactId: c4.id, direction: 'inbound', body: BODIES.positive[i] }); });
    sms.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
    contacts.forEach(function (c) { delete c.heat; });
    // Ledger bills (paid spend), allocated by payment date.
    var spend = [], BILLS = [['Lead Lists & Data', 3500, 30], ['Skip Tracing', 2200, 14], ['SMS & Dialer', 5500, 30], ['Marketing & Ads', 3000, 7], ['Direct Mail', 8000, 30],
      ['CRM & Software', 1200, 30], ['Title & Escrow', 900, 10], ['Inspections & Appraisals', 600, 12], ['Legal & Entity', 700, 30], ['Insurance', 420, 30], ['Office/Admin', 600, 14], ['Travel & Vehicle', 400, 7]];
    BILLS.forEach(function (b) { for (var d = days - 1; d >= 0; d -= b[2]) { var t = today.getTime() - (d - Math.floor(r() * Math.min(5, b[2]))) * 86400000; if (t > now) continue; spend.push({ date: new Date(t).toISOString().slice(0, 10), category: b[0], amount: Math.round(b[1] * (b[2] / 30) * (0.75 + r() * 0.5)) }); } });
    var ap = { owed: Math.round(6000 + r() * 9000), count: 4 + Math.floor(r() * 6) };
    return { calls: calls, inboundCalls: inboundCalls, sms: sms, contacts: contacts, opportunities: opportunities, deals: deals, spend: spend, ap: ap,
      meta: { mode: 'sample', label: 'SAMPLE DATA', generatedAt: new Date(now).toISOString(), days: days } };
  }
  // Sample GHL workflow stats in the data dashboard /api/workflow-feed summary shape.
  function workflows(days, now) {
    days = days || 30; now = now || Date.now();
    var r = rng(7 + days), f = days / 30;
    var list = [['Seller Follow-Up', 412], ['New Lead Text Drip', 268], ['Missed Call Text Back', 155], ['Hot Lead Alert', 88], ['Appointment Reminder', 64], ['Offer Sent Nurture', 51], ['Long Term Nurture', 140]];
    var wf = list.map(function (w, i) { var e = Math.round(w[1] * f * (0.85 + r() * 0.3)), fin = Math.round(e * (0.6 + r() * 0.35)), sk = Math.round(e * r() * 0.12), fl = Math.round(e * r() * 0.02);
      return { id: 'wf' + i, name: w[0], status: i === 6 ? 'draft' : 'published', entered: e, finished: fin, skipped: sk, failed: fl, completionRate: e ? fin / e : null }; });
    var tot = function (k) { return wf.reduce(function (s, w) { return s + w[k]; }, 0); };
    var weeks = Math.max(1, Math.ceil(days / 7));
    return { configured: true, sample: true, days: days, feed: { updatedAt: new Date(now - 4 * 60000).toISOString(), stale: false, lastError: null },
      overview: { totalWorkflows: wf.length, publishedWorkflows: 6, draftWorkflows: 1, enrollments: tot('entered'), finished: tot('finished'), skipped: tot('skipped'), failed: tot('failed'),
        completionRate: tot('finished') / tot('entered'), triggerEvaluated: Math.round(tot('entered') * 1.16), triggerMatched: tot('entered'), triggerMatchRate: 1 / 1.16 },
      weekly: Array.from({ length: weeks }, function (_, i) { return { week: new Date(now - (weeks - 1 - i) * 7 * 86400000).toISOString().slice(0, 10), enrollments: Math.round(tot('entered') / weeks * (0.75 + r() * 0.5)) }; }),
      workflows: wf.sort(function (a, b) { return b.entered - a.entered; }),
      reasons: [{ event: 'skipped', workflow: 'New Lead Text Drip', step: 'Send SMS', reason: 'Contact has DND enabled', count: Math.round(37 * f) },
        { event: 'skipped', workflow: 'Seller Follow-Up', step: 'If/Else', reason: 'Condition not met', count: Math.round(22 * f) },
        { event: 'skipped', workflow: 'Long Term Nurture', step: 'Wait', reason: 'Contact replied', count: Math.round(14 * f) },
        { event: 'failed', workflow: 'Seller Follow-Up', step: 'Send SMS', reason: 'Invalid phone number', count: Math.max(1, Math.round(3 * f)) }] };
  }
  // Sandbox-only operations data for the 3D Brain: Twilio balance and data source health.
  function ops(now) {
    now = now || Date.now();
    var ago = function (m) { return new Date(now - m * 60000).toISOString(); };
    return { sample: true,
      twilio: { balance: 412.37, burnPerDay: 38.6, low: 100, capacity: 600, currency: 'USD' },
      health: { sources: [
        { name: 'Dialer', status: 'ok', detail: 'Synced 2 min ago', at: ago(2) },
        { name: 'GHL', status: 'ok', detail: 'Synced 4 min ago', at: ago(4) },
        { name: 'Ledger', status: 'ok', detail: 'Synced 6 min ago', at: ago(6) },
        { name: 'Workflow feed', status: 'ok', detail: 'Live, 4 min ago', at: ago(4) },
        { name: 'Groq', status: 'warn', detail: 'Key not set', at: null }
      ] } };
  }
  return { ops: ops, workflows: workflows, generate: generate, REPS: REPS.map(function (x) { return x[0]; }) };
});
