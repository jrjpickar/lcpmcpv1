import { EXCLUDED_PHONES, excludedRep, REPORTING_PHONES, isFlexCall } from './_reporting-roster.mjs';
// Built-in reporting names, used when the deployed AGENT_ASSIGNMENTS variable
// is missing an agent (so calls never show a raw GHL user ID).
const ROSTER_NAMES = new Map(Object.values(REPORTING_PHONES).map(v => [v.id, v.name]));
import { reportingAgentId } from './_agent-aliases.mjs';
import { OPPORTUNITY_USERS, OPPORTUNITY_PIPELINES } from './_opportunity-config.mjs';
import { normalizeSms } from './_sms.mjs';
import { compactContact, normalizeAppointment } from './_lead-fields.mjs';
const nameOf = (record = {}) => record.name || [record.firstName, record.lastName].filter(Boolean).join(' ') || 'Unknown';
export function uniqueRecords(rows) {
  const result = new Map();
  for (const row of rows) {
    const id = row.id || row.messageId;
    if (!id) throw new Error('An API record has no stable ID; snapshot was not published.');
    const old = result.get(id);
    if (!old || (Date.parse(row.updatedAt || row.dateUpdated || row.dateAdded || row.createdAt || '') || 0) >= (Date.parse(old.updatedAt || old.dateUpdated || old.dateAdded || old.createdAt || '') || 0)) result.set(id, row);
  }
  return [...result.values()];
}
export function normalize({ contacts, opportunities, pipelines, users, calls, sms, warnings, startDate, appointments = [], qualification = null, firstSeen = {} }) {
  contacts = uniqueRecords(contacts); opportunities = uniqueRecords(opportunities);
  calls = uniqueRecords(calls); sms = uniqueRecords(sms);
  const contactById = new Map(contacts.map((c) => [c.id, c]));
  const userById = new Map(users.filter(u => reportingAgentId(u.id) === u.id).map(u => [u.id, nameOf(u)]));
  const opportunityUserById = new Map([...users, ...OPPORTUNITY_USERS].filter(u => reportingAgentId(u.id) === u.id).map(u => [u.id, nameOf(u)]));
  const pipelineById = new Map(OPPORTUNITY_PIPELINES.map(p => { const live = pipelines.find(x => x.id === p.id); return [p.id, { ...p, ...live, stages: live?.stages || live?.stagesArray || p.stages }]; }).concat(pipelines.filter(p => !OPPORTUNITY_PIPELINES.some(x => x.id === p.id)).map(p => [p.id, { ...p, stages: p.stages || p.stagesArray || [] }])));

  const normalizedContacts = contacts.map((c) => compactContact(c, qualification, firstSeen?.[c.id]));

  const normalizedCalls = calls
    .filter((m) => String(m.direction || '').toLowerCase() === 'outbound')
    .map((m) => {
      const contact = contactById.get(m.contactId) || {};
      const duration = Number(m.meta?.callDuration ?? m.callDuration ?? m.duration ?? 0) || 0;
      const rawStatus = String(m.meta?.callStatus || m.status || '').toLowerCase();
      const answered = ['completed', 'connected', 'answered'].includes(rawStatus);
      const sourceUserId = m.sourceUserId || m.userId || '';
      const repId = reportingAgentId(m.userId);
      const rep = userById.get(repId) || ROSTER_NAMES.get(repId) || m.sessionAgentName || repId || 'Unknown caller';
      const signedIn = m.attributionSource === 'dialer-session' || (m.attributionSource === 'ghl-user' && repId);
      const flex = isFlexCall(m.callerNumber, m.dateAdded || m.createdAt);
      if ((!signedIn && !flex && EXCLUDED_PHONES.has(m.callerNumber)) || excludedRep(rep)) return null;
      return { id: m.id || m.messageId, contactId: m.contactId || '', conversationId: m.conversationId || '', ln: contact.id ? nameOf(contact) : (m.leadPhone || nameOf(contact)), callerNumber: m.callerNumber || '', ...(flex ? { flexNumber: true } : {}), attributionSource: m.attributionSource || 'caller-id', source: m.source || 'ghl', matchConfidence: m.matchConfidence, leadPhone: m.leadPhone || '', cs: answered ? 'Answered' : (rawStatus === 'busy' ? 'Busy' : (['no-answer', 'no_answer', 'missed'].includes(rawStatus) ? 'No Answer' : rawStatus || 'Unknown')), d: 'Outgoing', repId, sourceUserId, rep, dialer: rep, du: duration, ft: 'Unknown', co: m.dateAdded || m.createdAt || '', updatedAt: m.updatedAt || m.dateAdded || m.createdAt || null };
    }).filter(Boolean);

  const normalizedSms = sms.map((m) => normalizeSms(m, contactById.get(m.contactId) || {}));

  const normalizedOpps = opportunities.map((o) => {
    const contact = { ...(o.contact || {}), ...(contactById.get(o.contactId || o.contact?.id) || {}) };
    const pipeline = pipelineById.get(o.pipelineId) || {};
    const stage = (pipeline.stages || []).find((s) => s.id === o.pipelineStageId) || {};
    const sourceUserId = o.assignedTo || contact.assignedTo || '';
    const repId = reportingAgentId(sourceUserId);
    return { id: o.id, contactId: o.contactId || contact.id || '', repId, sourceUserId, on: o.name || '(blank)', ln: nameOf(contact), rep: opportunityUserById.get(repId) || repId || 'Unassigned', pipe: pipeline.name || o.pipelineId || 'Unknown', status: String(o.status || 'open').toLowerCase(), phone: contact.phone || '', val: Number(o.monetaryValue || 0), stage: stage.name || o.pipelineStageId || '', tags: Array.isArray(contact.tags) ? contact.tags : [], created: o.createdAt || o.dateAdded || '', lost: o.lostReasonName || o.lostReasonId || '', stageAt: o.lastStageChangeAt || o.lastStatusChangeAt || o.updatedAt || o.createdAt || '', updatedAt: o.updatedAt || null };
  });

  const normalizedAppointments = uniqueRecords(appointments).map(a => (a.start !== undefined && a.status !== undefined ? a : normalizeAppointment(a)));
  return {
    calls: normalizedCalls, contacts: normalizedContacts, opportunities: normalizedOpps, sms: normalizedSms, appointments: normalizedAppointments,
    meta: { userNames: Object.fromEntries(opportunityUserById), qualificationFields: qualification ? { fields: qualification.fields, missing: qualification.missing } : null, opportunityPipelines: [...pipelineById.values()], timezone: process.env.DASHBOARD_TIMEZONE || 'America/Los_Angeles', callsSource: `GoHighLevel API · Call messages since ${startDate.slice(0, 10)}`, contactsSource: `GoHighLevel API · ${contacts.length.toLocaleString()} contacts`, oppsSource: `GoHighLevel API · ${opportunities.length.toLocaleString()} opportunities`, smsSource: `GoHighLevel API · inbound + outbound SMS since ${startDate.slice(0, 10)} with real-time webhook overlay`, refreshedAt: new Date().toISOString(), warnings },
  };
}
