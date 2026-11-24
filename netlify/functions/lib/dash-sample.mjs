// Sample dataset in the v2 data dashboard's snapshot shapes (compact contacts, normalized calls, SMS,
// opportunities, tasks, appointments). Deterministic. Used by DATA_MODE=sample, the sandbox and tests.
const REPS = ['Jesse Pickar', 'Arturo Vazquez', 'Bryce Roman-Tooley', 'Carlos Marroquin', 'Gavin Hambright', 'Tino Vasquez', 'Zeth Vasquez', 'Seth Roman'];
const USER_IDS = ['Dcc7H7rZQIwkLFNphrOc', '0o04fuZfD8lslmrIP4s5', 'tkcNLziNqC1TOgoj0FE1', 'UxhQAXoTQ3k8St26dRwH', 'XyNOQ1RnHJMN0M8RQkK8', 'uU07MWZRjOmCtPxncITU', 'npAoGH4GfhWRw593Tkq8', 'XgYcgxk7k1OOHLgd3yVS'];
// [zip, city, yield multiplier]
const ZIPS = [['90044', 'Los Angeles', 1.9], ['90003', 'Los Angeles', 1.2], ['90011', 'Los Angeles', 1.0], ['90059', 'Los Angeles', 1.4], ['90220', 'Compton', 1.7], ['90221', 'Compton', 1.1],
  ['90262', 'Lynwood', 0.9], ['90280', 'South Gate', 0.7], ['90247', 'Gardena', 1.0], ['90305', 'Inglewood', 1.3], ['91331', 'Pacoima', 0.8], ['91342', 'Sylmar', 0.6],
  ['91402', 'Panorama City', 0.9], ['91605', 'North Hollywood', 0.5], ['93535', 'Lancaster', 1.6], ['93550', 'Palmdale', 1.2], ['93551', 'Palmdale', 0.4]];
// [tag, import day offset, yield multiplier, size]
const LISTS = [['LA Tax Delinquent 2026-07', -140, 1.8, 900], ['Code Violation Q3', -110, 1.3, 700], ['Probate Aug', -95, 1.0, 500], ['Absentee Owners South LA', -80, 0.5, 900],
  ['Tax Delinquent x Code Violation', -60, 2.4, 350], ['Pre-Foreclosure Sep', -45, 1.1, 450], ['Vacant Lancaster Palmdale', -30, 0.9, 500], ['High Equity Seniors', -18, 0.7, 400]];
const EXTRA_TAGS = [['tired landlord', 1.6], ['inherited', 1.4], ['vacant', 1.2], ['out of state owner', 0.8], ['free and clear', 1.1]];
const SOURCES = ['PropStream', 'LA County Assessor', 'DealMachine', 'Direct Mail Response'];
const HOUR_W = [0, 0, 0, 0, 0, 0, 0, 0.2, 0.6, 0.9, 1.0, 1.0, 0.8, 0.9, 0.9, 1.0, 1.1, 1.2, 1.0, 0.7, 0.3, 0, 0, 0];
const HOUR_CONTACT = [0, 0, 0, 0, 0, 0, 0, 0.05, 0.07, 0.09, 0.08, 0.06, 0.05, 0.05, 0.06, 0.07, 0.10, 0.13, 0.12, 0.09, 0.06, 0, 0, 0];
const STAGES_ACQ = ['New Lead', 'Run Numbers', 'Eval Done', 'Offer Sent', 'Verbal Acceptance', 'In Escrow', 'Ghosted', 'Not Ready'];

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const DAY = 86400000;

export function generateDashSample({ now = Date.now(), seed = 7 } = {}) {
  const r = rng(seed);
  const pick = list => list[Math.floor(r() * list.length)];
  const contacts = [], calls = [], sms = [], opportunities = [], tasks = [], appointments = [];
  let n = 0;
  // Pacific hour h on day d (approx: PST = UTC-8 / PDT = UTC-7 is close enough for sample data).
  const at = (dayMs, hour) => new Date(Math.floor(dayMs / DAY) * DAY + (hour + 8) * 3600000 + Math.floor(r() * 3600000)).toISOString();
  const pickHour = () => { for (;;) { const h = 7 + Math.floor(r() * 14); if (r() < HOUR_W[h]) return h; } };
  for (const [tag, offset, listYield, size] of LISTS) {
    const imported = now + offset * DAY;
    for (let i = 0; i < size; i++) {
      const [zip, city, zipYield] = pick(ZIPS);
      const extra = r() < 0.45 ? pick(EXTRA_TAGS) : null;
      const id = 'c' + (++n).toString(36).padStart(5, '0');
      const tags = [tag, ...(extra ? [extra[0]] : [])];
      if (r() < 0.04) tags.push('Wrong Number');
      const rep = Math.floor(r() * REPS.length);
      contacts.push({ id, n: `Seller ${n}`, p: '+1323555' + String(n).padStart(4, '0'), t: tags, da: new Date(imported + r() * DAY).toISOString(), src: pick(SOURCES),
        ad: { l: `${100 + Math.floor(r() * 9800)} ${pick(['Main', 'Broadway', 'Vermont', 'Western', 'Avalon', 'Figueroa'])} ${pick(['St', 'Ave', 'Blvd'])}`, c: city, s: 'CA', z: zip }, o: USER_IDS[rep] });
      const yieldMult = listYield * zipYield * (extra ? extra[1] : 1);
      const worked = r() < 0.75;
      if (!worked) continue;
      const touches = 1 + Math.floor(r() * 6);
      let contacted = false, qualifiedAt = null;
      for (let k = 0; k < touches; k++) {
        const dayMs = Math.min(now - DAY / 2, imported + (2 + k * (3 + r() * 6)) * DAY);
        if (dayMs < imported) continue;
        const hour = pickHour();
        const when = at(dayMs, hour);
        if (Date.parse(when) > now) continue;
        if (r() < 0.65) {
          const pContact = HOUR_CONTACT[hour] * 2.2 * Math.min(1.6, Math.sqrt(yieldMult));
          const talk = r() < pContact ? 66 + Math.floor(r() * 600) : r() < 0.3 ? 5 + Math.floor(r() * 50) : 0;
          if (talk > 65) contacted = true;
          calls.push({ id: 'CA' + calls.length.toString(16).padStart(32, '0'), contactId: id, rep: REPS[rep], repId: USER_IDS[rep], cs: talk > 0 ? 'Answered' : 'No Answer', du: talk, co: when, callerNumber: '', attributionSource: 'caller-id', source: 'twilio', d: 'Outgoing' });
          if (talk > 65 && !qualifiedAt && r() < 0.11 * yieldMult) qualifiedAt = Date.parse(when) + 3600000;
        } else {
          sms.push({ id: 's' + sms.length, contactId: id, direction: 'outbound', status: 'delivered', body: 'Hi, is this the owner of the property? I may be able to make a cash offer.', source: r() < 0.3 ? 'workflow' : 'app', userId: USER_IDS[rep], createdAt: when, category: '' });
          if (r() < 0.08 * Math.sqrt(yieldMult) * (HOUR_CONTACT[hour] * 12)) {
            const pos = r() < 0.4 * Math.min(1.5, yieldMult);
            sms.push({ id: 's' + sms.length, contactId: id, direction: 'inbound', status: 'received', body: pos ? 'Yes I might be interested, how much?' : pick(['Not interested', 'Who is this?', 'stop']), source: '', userId: '', createdAt: new Date(Date.parse(when) + r() * 6 * 3600000).toISOString(), category: pos ? 'positive' : 'negative' });
            if (pos) { contacted = true; if (!qualifiedAt && r() < 0.35 * yieldMult) qualifiedAt = Date.parse(when) + 7200000; }
          }
        }
      }
      if (qualifiedAt && qualifiedAt < now) {
        const stage = r() < 0.55 ? pick(STAGES_ACQ.slice(0, 3)) : pick(STAGES_ACQ);
        const created = new Date(qualifiedAt).toISOString();
        opportunities.push({ id: 'o' + opportunities.length, contactId: id, rep: REPS[rep], repId: USER_IDS[rep], pipe: r() < 0.85 ? 'ACQ Pipeline' : 'Retail Pipeline', status: stage === 'Ghosted' ? 'lost' : 'open', stage,
          val: 0, created, stageAt: new Date(Math.min(now, qualifiedAt + r() * 10 * DAY)).toISOString(), on: `Seller ${n}`, ln: `Seller ${n}`, tags });
        if (r() < 0.5) {
          const start = new Date(qualifiedAt + (1 + r() * 4) * DAY).toISOString();
          appointments.push({ id: 'a' + appointments.length, contactId: id, calendarId: 'cal1', status: Date.parse(start) > now ? 'confirmed' : pick(['showed', 'showed', 'noshow', 'cancelled']), start, repId: USER_IDS[rep], title: 'Seller walkthrough', updatedAt: start });
        }
      }
      if (contacted && r() < 0.5) {
        const created = now - r() * 40 * DAY, due = created + (1 + r() * 6) * DAY, done = r() < 0.6 && due < now + DAY;
        tasks.push({ id: 't' + tasks.length, title: 'Follow up with ' + `Seller ${n}`, contactId: id, userId: USER_IDS[rep], sourceUserId: USER_IDS[rep], rep: REPS[rep], completed: done,
          completedAt: done ? new Date(Math.min(now, due + r() * DAY)).toISOString() : null, completionDateEstimated: false, dueDate: new Date(due).toISOString(), createdAt: new Date(created).toISOString(), updatedAt: new Date(created).toISOString() });
      }
    }
  }
  return { contacts, calls, sms, opportunities, tasks, appointments,
    meta: { mode: 'sample', userNames: Object.fromEntries(USER_IDS.map((id, i) => [id, REPS[i]])), refreshedAt: new Date(now).toISOString(), warnings: [] } };
}
