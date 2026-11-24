// Opportunity Density by Batch: which import lists produce the most qualified
// seller opportunities per 1,000 unique properties worked.
//
// Pure functions shared by the browser (window.OppDensity) and node tests.
// Reads the dashboard's already-loaded data; never writes to GHL or Twilio.
//
// Attribution rules (deliberately conservative):
//  - Property identity: normalized APN/AIN scoped to county (or state, or ZIP);
//    else normalized street line + ZIP5; else the GHL contact itself
//    ("contact-level", flagged). No fuzzy or name-based joins.
//  - Primary batch: the earliest-imported batch tag among the property's
//    contacts' ORIGINAL tags (first-seen tags, so later re-tagging can't steal
//    credit). Every other batch tag on the property is an assist.
//  - No batch tag at all -> "Unattributed", counted and shown, never guessed.
//  - Opportunities join to properties only through an exact GHL contactId.
//  - Everything is counted once per property, however many phones, contacts,
//    attempts or channels touched it.
(function (root) {
  const DAY = 86400000;
  const UNATTRIBUTED = 'Unattributed';

  const DEFAULT_THRESHOLDS = {
    minWorked: 500,          // below this a batch is "low sample": ranked last, never Increase/Retire
    maturityDays: 30,        // a batch younger than this is never Retire
    increaseRatio: 1.25,     // density >= 1.25 x baseline median -> Increase candidate
    retireRatio: 0.5,        // density <= 0.5 x baseline median -> Retire candidate
    minCoverageForRetire: 0.6, // must have worked most of the list before Retire
    contactRateFloor: 0.5,   // contact rate < 0.5 x median -> Investigate (bad phones?)
    minBaselineBatches: 3,   // mature, sufficient batches needed to set a baseline
  };

  const SUFFIX = {
    STREET: 'ST', AVENUE: 'AVE', AV: 'AVE', BOULEVARD: 'BLVD', DRIVE: 'DR', ROAD: 'RD', LANE: 'LN', COURT: 'CT', PLACE: 'PL',
    TERRACE: 'TER', CIRCLE: 'CIR', PARKWAY: 'PKWY', HIGHWAY: 'HWY', WAY: 'WAY', TRAIL: 'TRL', SQUARE: 'SQ',
    NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
    APARTMENT: 'APT', SUITE: 'STE', UNIT: 'UNIT', NUMBER: 'UNIT', NO: 'UNIT',
  };

  const stageKey = s => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  const OFFER_KIND = { verbalacceptance: 'verbal', offersent: 'sent', offerdeclinedhot: 'declined', offerdeclinedwarm: 'declined', offerdeclinedcold: 'declined' };
  const CONTRACT = new Set(['inescrow', 'inspectionperiod', 'pending', 'closed']);
  const QUAL_PIPELINES = ['ACQ Pipeline', 'Retail Pipeline'];
  const isAcq = name => /^\s*acq/i.test(String(name || ''));
  const toMs = v => { if (v == null || v === '') return null; if (v instanceof Date) return v.valueOf(); const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };
  const parseTags = t => Array.isArray(t) ? t.map(String).map(x => x.trim()).filter(Boolean) : String(t || '').split(',').map(x => x.trim()).filter(Boolean);
  const median = list => { const a = list.filter(Number.isFinite).sort((x, y) => x - y); if (!a.length) return null; const m = Math.floor(a.length / 2); return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };

  function normZip(z) { const d = String(z || '').replace(/\D/g, ''); return d.length >= 5 ? d.slice(0, 5) : ''; }
  function normAddressLine(line) {
    const tokens = String(line || '').toUpperCase().replace(/#/g, ' UNIT ').replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean).map(t => SUFFIX[t] || t);
    return tokens.join(' ');
  }
  // Exact identity only. Returns { key, identity } or null when unknown.
  function propertyIdentity(contact = {}) {
    const q = contact.q || {};
    const ad = contact.ad || {};
    const zip = normZip(ad.z);
    const apn = String(q.apn || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const scope = String(q.county || '').toUpperCase().replace(/[^A-Z]/g, '') || String(ad.s || '').toUpperCase().replace(/[^A-Z]/g, '') || zip;
    if (apn.length >= 5 && scope) return { key: `apn:${scope}:${apn}`, identity: 'apn' };
    const line = normAddressLine(ad.l);
    if (zip && /\d/.test(line) && line.length >= 5) return { key: `addr:${zip}:${line}`, identity: 'address' };
    return null;
  }

  function offerKind(opp) {
    if (!opp || !isAcq(opp.pipeline)) return '';
    const k = stageKey(opp.stage);
    if (CONTRACT.has(k)) return 'contract';
    return OFFER_KIND[k] || '';
  }

  /* ---------------- Property + batch index (computed once per data load) ---------------- */
  function buildIndex(input) {
    const { contacts = [], leads = new Map(), opps = [], isBatchTag = () => true, statusTag = /^$/, excludedTagReason = () => '' } = input;
    const batchTag = t => isBatchTag(t) && !statusTag.test(t);
    // Batch start = earliest date any contact carrying the tag was added (same rule as the Leads page).
    const batchStart = new Map();
    for (const c of contacts) {
      const da = toMs(c.da);
      for (const t of parseTags(c.ot || c.t)) if (batchTag(t) && da != null) batchStart.set(t, Math.min(batchStart.get(t) ?? Infinity, da));
    }
    const startOf = t => batchStart.get(t) ?? Infinity;

    const props = new Map();
    const contactProp = new Map();
    const identityMix = { apn: 0, address: 0, contact: 0 };
    let excludedContacts = 0;
    for (const c of contacts) {
      if (!c || !c.id) continue;
      if (excludedTagReason(c.t)) { excludedContacts++; continue; }
      const id = propertyIdentity(c) || { key: `contact:${c.id}`, identity: 'contact' };
      let p = props.get(id.key);
      if (!p) {
        p = { key: id.key, identity: id.identity, contacts: [], batches: new Set(), laterBatches: new Set(), zip: '', city: '', propertyType: '', sources: new Set(), importedAt: null, primaryBatch: '', assists: [] };
        props.set(id.key, p);
        identityMix[id.identity]++;
      }
      p.contacts.push(c.id);
      contactProp.set(c.id, p);
      // Original (first-seen) tags decide primary credit; tags added later are marketing touches (assists).
      for (const t of parseTags(c.ot || c.t)) if (batchTag(t)) p.batches.add(t);
      for (const t of parseTags(c.t)) if (batchTag(t)) p.laterBatches.add(t);
      const ad = c.ad || {};
      p.zip = p.zip || normZip(ad.z);
      p.city = p.city || String(ad.c || '').trim();
      p.propertyType = p.propertyType || String(c.q?.propertyType || '').trim();
      if (c.src) p.sources.add(String(c.src));
      const da = toMs(c.da);
      if (da != null) p.importedAt = Math.min(p.importedAt ?? Infinity, da);
    }

    const batches = new Map();
    for (const p of props.values()) {
      const ordered = [...p.batches].sort((a, b) => startOf(a) - startOf(b) || a.localeCompare(b));
      p.primaryBatch = ordered[0] || UNATTRIBUTED;
      p.assists = [...new Set([...ordered.slice(1), ...[...p.laterBatches].sort((a, b) => startOf(a) - startOf(b) || a.localeCompare(b))])].filter(t => t !== p.primaryBatch);
      p.leads = p.contacts.map(id => leads.get(id)).filter(Boolean);
      if (!batches.has(p.primaryBatch)) batches.set(p.primaryBatch, { name: p.primaryBatch, start: p.primaryBatch === UNATTRIBUTED ? null : (Number.isFinite(startOf(p.primaryBatch)) ? startOf(p.primaryBatch) : null), props: [] });
      batches.get(p.primaryBatch).props.push(p);
    }

    // Qualifying opportunities that cannot be tied to a batched property.
    const unattributedOpps = [];
    for (const o of opps) {
      if (!QUAL_PIPELINES.includes(o.pipeline)) continue;
      const p = o.contactId ? contactProp.get(o.contactId) : null;
      if (!o.contactId) unattributedOpps.push({ id: o.id, reason: 'no GHL contact on the opportunity', name: o.leadName || o.oppName || '' });
      else if (!p) unattributedOpps.push({ id: o.id, reason: 'contact not in the synced contact list (or tagged Wrong number / DNC)', name: o.leadName || o.oppName || '', contactId: o.contactId });
      else if (p.primaryBatch === UNATTRIBUTED) unattributedOpps.push({ id: o.id, reason: 'contact has no batch tag', name: o.leadName || o.oppName || '', contactId: o.contactId });
    }
    return { props, batches, contactProp, identityMix, excludedContacts, unattributedOpps, batchStart };
  }

  /* ---------------- Per-property evaluation for one window ---------------- */
  // window: { type: 'activity', inPeriod(dateKey) } or { type: 'cohort', days: 7|14|30|null }
  function evaluate(p, window, opts) {
    const { channel = 'all', rep = '', now = Date.now(), contactSeconds = 90 } = opts;
    const start = p.importedAt;
    const inWin = window.type === 'activity'
      ? (t => window.inPeriod(t.dateKey))
      : (t => start != null && t.at >= start && (window.days == null || t.at < start + window.days * DAY));
    const inWinMs = window.type === 'activity'
      ? (ms, key) => key ? window.inPeriod(key) : false
      : (ms => ms != null && start != null && ms >= start && (window.days == null || ms < start + window.days * DAY));
    const kindOk = t => channel === 'all' || (channel === 'call' ? t.kind === 'call' : t.kind === 'text');
    const out = { worked: false, workedCall: false, workedText: false, connected: false, meaningful: false, longCall: false, qualified: false, qualifiedWeight: 0, undatedHot: false, offers: { any: false, verbal: false, sent: false, declined: false }, contract: false, crmRecorded: false, everWorked: false, everQualified: false };
    for (const L of p.leads) {
      let textedOut = false, lastTextRep = '';
      for (const t of L.touches) {
        if (t.dir === 'out') out.everWorked = true;
        if (t.kind === 'text' && t.dir === 'out') { textedOut = true; lastTextRep = t.rep || ''; }
        if (!inWin(t) || !kindOk(t)) continue;
        if (t.dir === 'out' && (!rep || t.rep === rep)) {
          out.worked = true;
          if (t.kind === 'call') out.workedCall = true; else out.workedText = true;
        }
        if (t.kind === 'call' && t.duration > 0) out.connected = true;
        // With a rep filter, only that rep's own contacts count as meaningful.
        if (t.kind === 'call' && t.duration > contactSeconds) { out.longCall = true; if (L.conv?.disposition !== 'wrong_number' && (!rep || t.rep === rep)) out.meaningful = true; }
        if (t.kind === 'text' && t.dir === 'in' && t.meaningful && textedOut && t.disposition !== 'wrong_number' && L.conv?.disposition !== 'wrong_number' && (!rep || lastTextRep === rep)) out.meaningful = true;
      }
      // Same rule as the Leads funnel: an ACQ/Retail opportunity (any status,
      // not in Not Ready) or Temperature = Hot. Not Qualified tags never count.
      const qualOpps = L.qualOpps || (L.allOpps || []).filter(o => QUAL_PIPELINES.includes(o.pipeline) && stageKey(o.stage) !== 'notready');
      const weight = L.qualifiedWeight ?? (qualOpps.length || L.hot ? 1 : 0);
      const credit = w => { if (w > out.qualifiedWeight) out.qualifiedWeight = w; };
      if (weight > 0) out.everQualified = true;
      if (qualOpps.length || L.temperature || Object.keys(L.qual?.have || {}).length) out.crmRecorded = true;
      if (window.type === 'activity') {
        // Current CRM state of properties worked in the window (same rule as the Leads funnel).
        credit(weight);
        for (const o of L.allOpps || []) {
          const k = offerKind(o);
          if (k === 'contract') { out.contract = true; out.offers.any = true; }
          else if (k) { out.offers.any = true; out.offers[k] = true; }
        }
      } else {
        // Cohort: only dated evidence inside the window counts.
        if (qualOpps.some(o => inWinMs(toMs(o.dateObj || o.created)))) credit(weight);
        else if (weight > 0 && L.hot) { if (window.days == null) credit(weight); else out.undatedHot = true; }
        for (const o of L.allOpps || []) {
          const k = offerKind(o);
          if (!k || !inWinMs(toMs(o.stageAt) ?? toMs(o.dateObj || o.created))) continue;
          if (k === 'contract') { out.contract = true; out.offers.any = true; }
          else { out.offers.any = true; out.offers[k] = true; }
        }
      }
    }
    out.qualified = out.qualifiedWeight > 0;
    // Numerators are always a subset of worked properties.
    if (!out.worked) { out.qualifiedWeight = 0; out.meaningful = false; out.qualified = false; out.offers = { any: false, verbal: false, sent: false, declined: false }; out.contract = false; out.connected = false; out.longCall = false; out.undatedHot = false; }
    return out;
  }

  function matchesFilters(p, f = {}, settings = {}) {
    if (f.zip && p.zip !== f.zip) return false;
    if (f.city && p.city.toLowerCase() !== f.city.toLowerCase()) return false;
    if (f.propertyType && p.propertyType !== f.propertyType) return false;
    if (f.source && !p.sources.has(f.source)) return false;
    if (f.marketingChannel && (settings.batches?.[p.primaryBatch]?.channel || '') !== f.marketingChannel) return false;
    return true;
  }

  /* ---------------- Leaderboard ---------------- */
  function leaderboard(index, opts = {}) {
    const { window = { type: 'cohort', days: null }, filters = {}, settings = {}, now = Date.now(), oppFeed = null } = opts;
    const thresholds = { ...DEFAULT_THRESHOLDS, ...(settings.thresholds || {}) };
    const rows = [];
    const assistQualified = new Map();
    const totals = { props: 0, worked: 0, longCalls: 0, crmRecordedLong: 0, undatedHot: 0 };
    const search = String(filters.search || '').trim().toLowerCase();
    for (const batch of index.batches.values()) {
      if (search && !batch.name.toLowerCase().includes(search)) continue;
      const r = {
        batch: batch.name, unattributed: batch.name === UNATTRIBUTED, start: batch.start, ageDays: batch.start == null ? null : Math.floor((now - batch.start) / DAY),
        imported: 0, worked: 0, workedCall: 0, workedText: 0, connected: 0, meaningful: 0, qualified: 0, offers: 0, verbal: 0, sent: 0, declined: 0, contracts: 0,
        undatedHot: 0, overlap: 0, identity: { apn: 0, address: 0, contact: 0 }, qualifiedProps: [],
      };
      for (const p of batch.props) {
        if (!matchesFilters(p, filters, settings)) continue;
        r.imported++;
        r.identity[p.identity]++;
        if (p.assists.length) r.overlap++;
        const e = evaluate(p, window, { channel: filters.channel, rep: filters.rep, now });
        if (!e.worked) continue;
        r.worked++;
        if (e.workedCall) r.workedCall++;
        if (e.workedText) r.workedText++;
        if (e.connected) r.connected++;
        if (e.meaningful) r.meaningful++;
        if (e.undatedHot) r.undatedHot++;
        if (e.longCall) { totals.longCalls++; if (e.crmRecorded) totals.crmRecordedLong++; }
        if (e.qualified) {
          r.qualified += e.qualifiedWeight;
          r.qualifiedProps.push(p);
          for (const assist of p.assists) assistQualified.set(assist, (assistQualified.get(assist) || 0) + e.qualifiedWeight);
        }
        if (e.offers.any) r.offers++;
        if (e.offers.verbal) r.verbal++;
        if (e.offers.sent) r.sent++;
        if (e.offers.declined) r.declined++;
        if (e.contract) r.contracts++;
      }
      if (!r.imported) continue;
      totals.props += r.imported; totals.worked += r.worked; totals.undatedHot += r.undatedHot;
      r.coverage = r.imported ? r.worked / r.imported : null;
      r.contactRate = r.worked ? r.meaningful / r.worked : null;
      r.density = r.worked ? (r.qualified / r.worked) * 1000 : null;
      r.offerDensity = r.worked ? (r.offers / r.worked) * 1000 : null;
      r.channel = settings.batches?.[batch.name]?.channel || '';
      r.lowSample = r.worked < thresholds.minWorked;
      r.immature = window.type === 'cohort' && window.days != null ? (r.ageDays == null || r.ageDays < window.days) : (r.ageDays != null && r.ageDays < thresholds.maturityDays);
      r.contactLevelShare = r.imported ? r.identity.contact / r.imported : 0;
      rows.push(r);
    }
    for (const r of rows) r.assists = assistQualified.get(r.batch) || 0;
    const ranked = rows.filter(r => !r.unattributed);
    const recs = recommend(ranked, thresholds, { oppFeed, windowDays: window.type === 'cohort' ? window.days : null });
    ranked.forEach((r, i) => Object.assign(r, recs[i]));
    rows.sort((a, b) => (a.unattributed - b.unattributed) || (a.lowSample - b.lowSample) || (b.density ?? -1) - (a.density ?? -1) || b.worked - a.worked);
    return { rows, thresholds, totals, baseline: recs.baseline };
  }

  /* ---------------- Recommendations (deterministic, measured data only) ---------------- */
  function recommend(rows, t, ctx = {}) {
    const mature = rows.filter(r => !r.lowSample && !r.immature && r.density != null);
    const baseline = mature.length >= t.minBaselineBatches ? median(mature.map(r => r.density)) : null;
    const baseContact = mature.length >= t.minBaselineBatches ? median(mature.map(r => r.contactRate)) : null;
    const out = rows.map(r => {
      const reasons = [];
      const flags = [];
      if (ctx.oppFeed?.stale || ctx.oppFeed?.missing) flags.push('Opportunity data is stale, so qualified counts may be understated');
      if (r.contactLevelShare > 0.5) flags.push('Over half the properties lack an APN or address; contacts were counted as properties');
      if (r.lowSample) return { status: 'Investigate', reasons: [`Low sample: ${r.worked} worked (needs ${t.minWorked})`, ...flags] };
      if (flags.length && ctx.oppFeed?.stale) return { status: 'Investigate', reasons: flags };
      if (baseline == null || baseline === 0) return { status: 'Investigate', reasons: [`No baseline yet: needs ${t.minBaselineBatches} mature batches with ${t.minWorked}+ worked`, ...flags] };
      const ratio = r.density / baseline;
      reasons.push(`${ratio.toFixed(2)}× baseline density (${baseline.toFixed(1)} per 1,000)`);
      if (baseContact && r.contactRate != null && r.contactRate < baseContact * t.contactRateFloor) {
        return { status: 'Investigate', ratio, reasons: [...reasons, `Contact rate ${(r.contactRate * 100).toFixed(1)}% vs ${(baseContact * 100).toFixed(1)}% median: check phone data / skip quality`, ...flags] };
      }
      if (ratio >= t.increaseRatio) return { status: 'Increase', ratio, reasons: [...reasons, ...flags] };
      if (ratio <= t.retireRatio) {
        if (r.immature) return { status: 'Investigate', ratio, reasons: [...reasons, `Too new to judge (${r.ageDays ?? '?'} days; matures at ${ctx.windowDays || t.maturityDays})`, ...flags] };
        if ((r.coverage ?? 0) < t.minCoverageForRetire) return { status: 'Investigate', ratio, reasons: [...reasons, `Only ${((r.coverage ?? 0) * 100).toFixed(0)}% of the list worked (Retire needs ${(t.minCoverageForRetire * 100).toFixed(0)}%)`, ...flags] };
        return { status: 'Retire', ratio, reasons: [...reasons, `Mature (${r.ageDays} days) with ${((r.coverage ?? 0) * 100).toFixed(0)}% coverage`, ...flags] };
      }
      if (ratio < 1 && r.immature) return { status: 'Investigate', ratio, reasons: [...reasons, 'Below baseline but still maturing', ...flags] };
      return { status: 'Maintain', ratio, reasons: [...reasons, ...flags] };
    });
    out.baseline = baseline;
    return out;
  }

  /* ---------------- Data completeness + reconciliation ---------------- */
  // Reasons a contact may be a missed Prop. Evidence only; nothing is written to GHL.
  const INTEREST = new Set(['open_to_selling', 'offer_requested', 'callback_requested']);
  function reconciliation(index, opts = {}) {
    const { window = { type: 'cohort', days: null }, dialerByContact = new Map(), limit = 300, now = Date.now() } = opts;
    const queue = [];
    let missingOpp = 0;
    for (const p of index.props.values()) {
      const e = evaluate(p, window, { now });
      if (!e.worked) continue;
      for (const L of p.leads) {
        const hasOpp = (L.allOpps || []).some(o => QUAL_PIPELINES.includes(o.pipeline));
        if (hasOpp) continue;
        const reasons = [];
        if (L.hot) reasons.push('Temperature is Hot but there is no ACQ/Retail opportunity');
        if (L.ownershipStatedOnly) reasons.push('Seller confirmed ownership by text; not recorded in GHL');
        if (INTEREST.has(L.conv?.disposition)) reasons.push(`Seller reply reads as "${String(L.conv.disposition).replace(/_/g, ' ')}"`);
        const dialer = dialerByContact.get(L.id);
        if (dialer && /^follow-up-(hot|warm)$/.test(dialer.d)) reasons.push(`Dialer disposition ${dialer.d === 'follow-up-hot' ? 'Follow Up Hot' : 'Follow Up Warm'} (${String(dialer.t).slice(0, 10)})`);
        const longCalls = L.touches.filter(t => t.kind === 'call' && t.duration > 90);
        if (longCalls.length && !L.temperature && !Object.keys(L.qual?.have || {}).length && !reasons.length) reasons.push(`Call over 90s with no CRM outcome recorded (not proof of qualification)`);
        if (!reasons.length) continue;
        missingOpp++;
        if (queue.length < limit) queue.push({ contactId: L.id, name: L.name, batch: p.primaryBatch, reasons, strong: reasons.length > 1 || L.hot || Boolean(dialer), lastTouch: L.touches[L.touches.length - 1]?.at || null, owner: L.owner || '' });
      }
    }
    queue.sort((a, b) => (b.strong - a.strong) || (b.reasons.length - a.reasons.length) || (b.lastTouch || 0) - (a.lastTouch || 0));
    return { queue, missingOpp };
  }

  // Share of long calls (Twilio, > 90s) whose call SID has a dialer disposition.
  function dispositionCoverage(calls = [], dialerBySid = new Map(), opts = {}) {
    const { inPeriod = () => true, since = null, contactSeconds = 90 } = opts;
    let long = 0, recorded = 0;
    for (const c of calls) {
      if (!(c.duration > contactSeconds) || !inPeriod(c.dateKey)) continue;
      if (since && (!c.dateKey || c.dateKey < since)) continue;
      long++;
      if (dialerBySid.has(c.id)) recorded++;
    }
    return { long, recorded, share: long ? recorded / long : null };
  }

  const api = { UNATTRIBUTED, DEFAULT_THRESHOLDS, normAddressLine, normZip, propertyIdentity, offerKind, buildIndex, evaluate, leaderboard, recommend, reconciliation, dispositionCoverage, median };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OppDensity = api;
})(typeof window !== 'undefined' ? window : globalThis);
