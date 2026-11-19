// Gmail (Google Workspace) source for the JARVIS Email agent. Scopes: gmail.readonly to read, gmail.compose to save drafts.
// The only write call in this file is drafts.create. There is no send code path (test/gmail-no-send.test.mjs enforces it).
// Env: GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN (from scripts/gmail-token.mjs, run once on your computer).
// Optional: JARVIS_GMAIL_QUERY (Gmail search, default "in:inbox newer_than:7d"). No Groq calls here.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const fail = (message, agentStatus) => Object.assign(new Error(message), { agentStatus });
let cached = null; // { key, token, expires }

export function gmailSettings(env = process.env) {
  const clientId = env.GMAIL_CLIENT_ID?.trim(), clientSecret = env.GMAIL_CLIENT_SECRET?.trim(), refreshToken = env.GMAIL_REFRESH_TOKEN?.trim();
  return { clientId, clientSecret, refreshToken, query: env.JARVIS_GMAIL_QUERY?.trim() || 'in:inbox newer_than:7d', configured: Boolean(clientId && clientSecret && refreshToken) };
}

async function accessToken(settings, fetchImpl) {
  const key = settings.clientId + ':' + settings.refreshToken.slice(-12);
  if (cached?.key === key && cached.expires > Date.now() + 60000) return cached.token;
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: settings.clientId, client_secret: settings.clientSecret, refresh_token: settings.refreshToken, grant_type: 'refresh_token' }),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.access_token !== 'string') {
    // invalid_grant: the refresh token was revoked or expired. Run scripts/gmail-token.mjs again.
    throw fail('Gmail sign-in failed' + (typeof data.error === 'string' ? ' (' + data.error.slice(0, 40) + ')' : '') + '. Create a new GMAIL_REFRESH_TOKEN.', 502);
  }
  cached = { key, token: data.access_token, expires: Date.now() + (Number(data.expires_in) || 3000) * 1000 };
  return cached.token;
}

const decode = data => Buffer.from(String(data || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
const header = (payload, name) => payload?.headers?.find(item => item.name?.toLowerCase() === name)?.value || '';
function bodyText(payload) {
  const parts = [];
  const walk = part => { if (!part) return; parts.push(part); (part.parts || []).forEach(walk); };
  walk(payload);
  const plain = parts.find(part => part.mimeType === 'text/plain' && part.body?.data);
  if (plain) return decode(plain.body.data);
  const html = parts.find(part => part.mimeType === 'text/html' && part.body?.data);
  if (html) return decode(html.body.data).replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
  return '';
}
function excerpt(text, bytes) {
  const value = Buffer.from(String(text).replace(/\s+/g, ' ').trim().slice(0, 4000), 'utf8');
  return value.length <= bytes ? value.toString() : value.subarray(0, bytes).toString().replace(/�$/, '');
}

// Snapshot in the same shape as the command-center source: stats plus up to `count` recent messages.
export async function fetchGmail({ env = process.env, fetchImpl = fetch, count = 10 } = {}) {
  const settings = gmailSettings(env);
  if (!settings.configured) throw fail('Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN so the Email agent can read Gmail.', 503);
  const token = await accessToken(settings, fetchImpl);
  const get = async path => {
    const response = await fetchImpl(API + path, { headers: { authorization: 'Bearer ' + token, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw fail('Gmail is unavailable (HTTP ' + response.status + ').', 502); }
    return response.json();
  };
  const [inbox, important, list] = await Promise.all([
    get('/labels/INBOX'),
    get('/messages?' + new URLSearchParams({ q: 'in:inbox is:unread is:important', maxResults: '1' })),
    get('/messages?' + new URLSearchParams({ q: settings.query, maxResults: String(Math.min(20, Math.max(1, count))) })),
  ]);
  const ids = (list.messages || []).map(item => item.id).filter(id => typeof id === 'string');
  const messages = (await Promise.all(ids.map(id => get('/messages/' + encodeURIComponent(id) + '?format=full').catch(() => null))))
    .filter(Boolean)
    .map(message => ({
      id: String(message.id || ''),
      threadId: String(message.threadId || ''),
      subject: excerpt(header(message.payload, 'subject') || '(no subject)', 200),
      from: excerpt(header(message.payload, 'from'), 120),
      receivedAt: Number(message.internalDate) ? new Date(Number(message.internalDate)).toISOString() : null,
      unread: (message.labelIds || []).includes('UNREAD'),
      text: excerpt(bodyText(message.payload) || message.snippet || '', 700),
    }));
  const now = new Date().toISOString();
  return {
    source: 'gmail', syncedAt: now, asOf: now, query: settings.query,
    stats: { unreadIncoming: Number(inbox.messagesUnread) || 0, unreadThreads: Number(inbox.threadsUnread) || 0, importantUnreadEstimate: Number(important.resultSizeEstimate) || 0 },
    messages, messagesAvailable: ids.length === messages.length,
  };
}

// ---- Drafts: drafts.create only. The operator reviews and sends from Gmail. ----
export const draftLimits = { recipients: 10, subject: 250, body: 20000 };
const emailPattern = /^[^\s@<>(),;:"\[\]\\]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const headerSafe = value => String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
const encodeHeader = value => (/^[\x20-\x7e]*$/.test(value) ? value : '=?UTF-8?B?' + Buffer.from(value, 'utf8').toString('base64') + '?=');

// Validates and normalizes a draft from the Email agent or the dashboard. Throws with agentStatus 400 on bad input.
export function checkDraft(input) {
  const list = value => (Array.isArray(value) ? value : String(value ?? '').split(',')).map(item => headerSafe(item)).filter(Boolean);
  const to = list(input?.to), cc = list(input?.cc);
  const subject = headerSafe(input?.subject), body = String(input?.body ?? '').replace(/\r\n?/g, '\n').trim();
  const replyToId = input?.replyToId == null || input.replyToId === '' ? null : String(input.replyToId);
  if (to.length + cc.length > draftLimits.recipients || [...to, ...cc].some(address => !emailPattern.test(address))) throw fail('Use up to 10 valid email addresses.', 400);
  if (!subject || subject.length > draftLimits.subject) throw fail('Add a subject of up to 250 characters.', 400);
  if (!body || body.length > draftLimits.body) throw fail('Add a body of up to 20,000 characters.', 400);
  if (replyToId !== null && !/^[A-Za-z0-9_-]{6,64}$/.test(replyToId)) throw fail('Invalid reply message.', 400);
  return { to, cc, subject, body, replyToId };
}

// RFC 2822 message, base64url encoded for the Gmail API. Body is UTF-8 plain text in base64.
export function rawMessage({ to, cc, subject, body, inReplyTo = '', references = '' }) {
  const lines = [
    ...(to.length ? ['To: ' + to.join(', ')] : []),
    ...(cc.length ? ['Cc: ' + cc.join(', ')] : []),
    'Subject: ' + encodeHeader(subject),
    ...(inReplyTo ? ['In-Reply-To: ' + headerSafe(inReplyTo), 'References: ' + headerSafe([references, inReplyTo].filter(Boolean).join(' '))] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/.{76}/g, '$&\r\n'),
  ];
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}

// Saves a draft in the configured mailbox. Replies stay in the original thread. Never sends.
export async function createDraft(input, { env = process.env, fetchImpl = fetch } = {}) {
  const draft = checkDraft(input);
  const settings = gmailSettings(env);
  if (!settings.configured) throw fail('Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN (with the gmail.compose scope) to save drafts.', 503);
  const token = await accessToken(settings, fetchImpl);
  const headers = { authorization: 'Bearer ' + token, accept: 'application/json' };
  let threadId = null, inReplyTo = '', references = '';
  if (draft.replyToId) {
    // Read call: the original message's thread and Message-ID, so Gmail threads the reply.
    const response = await fetchImpl(API + '/messages/' + encodeURIComponent(draft.replyToId) + '?format=metadata&metadataHeaders=Message-ID&metadataHeaders=References',
      { headers, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw fail('The original message was not found in Gmail.', 404); }
    const original = await response.json();
    threadId = original.threadId || null;
    inReplyTo = header(original.payload, 'message-id');
    references = header(original.payload, 'references');
  }
  const response = await fetchImpl(API + '/drafts', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ message: { raw: rawMessage({ ...draft, inReplyTo, references }), ...(threadId ? { threadId } : {}) } }),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw fail(response.status === 403 ? 'Gmail refused the draft. Create a new GMAIL_REFRESH_TOKEN that includes the gmail.compose scope.' : 'Gmail could not save the draft (HTTP ' + response.status + ').', response.status === 403 ? 403 : 502);
  }
  const saved = await response.json();
  return { draftId: String(saved.id || ''), messageId: String(saved.message?.id || ''), threadId: saved.message?.threadId || threadId };
}
