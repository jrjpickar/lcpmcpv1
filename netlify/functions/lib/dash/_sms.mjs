const OPT_OUT = /\b(stop|stopall|unsubscribe|cancel|end|quit|remove me|take me off|do not (?:text|contact|message)|don'?t (?:text|contact|message)|never contact)\b/i;
const STRONG_NEGATIVE = /\b(not interested|wrong (?:person|number)|already sold|property (?:is )?sold|do not want|don'?t want|leave me alone|not for sale|no thanks|no thank you|hard pass|please don'?t|not anymore)\b/i;
const POSITIVE = /\b(yes|yeah|yep|sure|interested|tell me more|send (?:me )?(?:info|information|details)|call me|give me a call|sounds good|let'?s (?:talk|chat|do it)|what(?:'s| is) (?:the|your) offer|how much|make (?:me )?an offer|open to (?:an offer|talking)|when can (?:you|we)|available to talk|no problem)\b/i;
const BARE_NEGATIVE = /^\s*(?:no|nope|nah|pass)(?:\s*[.!?])?\s*$/i;

const tagKey = tag => String(tag).toLowerCase().replace(/[^a-z0-9]+/g, '');
const POSITIVE_TAGS = new Set(['positive', 'interested', 'hotlead', 'warmlead', 'qualified', 'motivatedseller', 'appointmentbooked', 'appointmentset']);
const NEGATIVE_TAGS = new Set(['negative', 'notinterested', 'wrongnumber', 'wrongperson', 'deadlead', 'badlead', 'alreadysold', 'notforsale', 'donotcontact']);

export function classifyResponseDetail(body, status = '', error = '', tags = []) {
  const text = String(body || '').trim();
  const system = `${status} ${error}`;
  if (/opt.?out/i.test(system) || OPT_OUT.test(text)) return { category: 'opt_out', source: /opt.?out/i.test(system) ? 'status' : 'body', confidence: 'high' };
  if (STRONG_NEGATIVE.test(text)) return { category: 'negative', source: 'body', confidence: 'high' };
  if (POSITIVE.test(text)) return { category: 'positive', source: 'body', confidence: 'high' };
  if (BARE_NEGATIVE.test(text)) return { category: 'negative', source: 'body', confidence: 'high' };
  const keys = normalizeTags(tags).map(tagKey);
  if (keys.some(key => ['optout', 'optedout', 'unsubscribe', 'unsubscribed'].includes(key))) return { category: 'opt_out', source: 'tag', confidence: 'medium' };
  if (keys.some(key => NEGATIVE_TAGS.has(key))) return { category: 'negative', source: 'tag', confidence: 'medium' };
  if (keys.some(key => POSITIVE_TAGS.has(key))) return { category: 'positive', source: 'tag', confidence: 'medium' };
  return { category: 'neutral', source: text ? 'body' : 'default', confidence: text ? 'low' : 'unknown' };
}

export function classifyResponse(body, status = '', error = '', tags = []) {
  return classifyResponseDetail(body, status, error, tags).category;
}

export function normalizeTags(tags) {
  if (Array.isArray(tags)) return tags.map(String).map((tag) => tag.trim()).filter(Boolean);
  return String(tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
}

export function hasOptOutTag(tags) {
  return normalizeTags(tags).some((tag) => ['optout', 'optedout', 'unsubscribe', 'unsubscribed'].includes(tag.toLowerCase().replace(/[\s_-]+/g, '')));
}

export function negativeTagReason(tags) {
  const normalized = normalizeTags(tags).map((tag) => tag.toLowerCase().replace(/[\s_-]+/g, ''));
  if (normalized.includes('notinterested')) return 'not_interested';
  if (normalized.includes('wrongnumber')) return 'wrong_number';
  return '';
}

export function normalizeSms(message = {}, contact = {}) {
  const direction = String(message.direction || '').toLowerCase();
  const status = String(message.status || (direction === 'inbound' ? 'received' : 'pending')).toLowerCase();
  const body = String(message.body || '').trim();
  const tags = normalizeTags(contact.tags || message.tags);
  const taggedOptOut = hasOptOutTag(tags);
  const taggedNegativeReason = negativeTagReason(tags);
  const classification = classifyResponseDetail(body, status, message.error, tags);
  return {
    id: message.id || message.messageId || message.altId || '',
    contactId: message.contactId || contact.id || '',
    conversationId: message.conversationId || '',
    ln: contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || message.contactName || 'Unknown',
    direction,
    status,
    category: direction === 'inbound' ? classification.category : '',
    categorySource: direction === 'inbound' ? classification.source : '',
    categoryConfidence: direction === 'inbound' ? classification.confidence : '',
    body,
    from: message.from || '',
    to: message.to || '',
    source: message.source || '',
    error: message.error || '',
    userId: message.userId || '',
    tags,
    taggedOptOut,
    taggedNegativeReason,
    dnd: Boolean(contact.dnd),
    smsDnd: Boolean(contact.dnd || contact.dndSettings?.SMS?.status === 'active'),
    createdAt: message.dateAdded || message.createdAt || null,
    updatedAt: message.updatedAt || message.dateAdded || message.createdAt || null,
  };
}
