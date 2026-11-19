// Mailbox snapshot for the JARVIS Email agent. Reads Gmail (Google Workspace, see gmail.mjs) when GMAIL_* is set,
// otherwise an email app's command-center endpoint (same contract as the A2Z Email Inbox app).
// Keeps a short snapshot in JARVIS storage. No Groq calls here.
// Command-center env: JARVIS_EMAIL_URL (HTTPS URL), MCP_COMMAND_CENTER_TOKEN (bearer token).
// Both sources: JARVIS_EMAIL_PAGES (1 to 4 pages of 5 messages, default 2), JARVIS_EMAIL_SYNC=off stops the 30 minute sync.
import { fetchGmail, gmailSettings } from './gmail.mjs';

export const MAIL_KEY = 'mail/snapshot';
const maxAgeMs = 15 * 60000;
const fail = (message, agentStatus) => Object.assign(new Error(message), { agentStatus });

function excerpt(text, bytes) {
  const value = Buffer.from(String(text).slice(0, 4000), 'utf8');
  return value.length <= bytes ? value.toString() : value.subarray(0, bytes).toString().replace(/�$/, '');
}

export function mailSettings(env = process.env) {
  const token = env.MCP_COMMAND_CENTER_TOKEN?.trim();
  let url = null;
  if (env.JARVIS_EMAIL_URL?.trim()) {
    const custom = URL.parse(env.JARVIS_EMAIL_URL.trim());
    if (!custom || custom.protocol !== 'https:' || custom.username || custom.password) throw fail('JARVIS_EMAIL_URL must be an HTTPS URL.', 503);
    url = custom.href;
  }
  const pages = Math.min(4, Math.max(1, Number.parseInt(env.JARVIS_EMAIL_PAGES, 10) || 2));
  const gmail = gmailSettings(env).configured;
  const configured = gmail || Boolean(token && url);
  return { token, url, pages, gmail, configured, enabled: configured && env.JARVIS_EMAIL_SYNC !== 'off' };
}

export const sampleMailbox = () => ({
  source: 'sample', syncedAt: new Date().toISOString(), asOf: new Date().toISOString(),
  stats: { unreadIncoming: 5, urgentUnread: 1, awaitingReply: 4 },
  messages: [
    { subject: 'Re: Your offer on 1420 Cedar Ave, Long Beach', receivedAt: new Date(Date.now() - 3600e3).toISOString(), text: 'Seller asks if we can close in 21 days and cover the back taxes. Wants an answer by Friday.' },
    { subject: 'Escrow opened: 88 Palm Dr', receivedAt: new Date(Date.now() - 7200e3).toISOString(), text: 'Title opened escrow. EMD of $5,000 due within 3 business days.' },
    { subject: 'Buyer interest: Compton 3/2', receivedAt: new Date(Date.now() - 86400e3).toISOString(), text: 'Cash buyer wants photos and the assignment fee before a walkthrough.' },
  ],
  messagesAvailable: true,
});

export async function fetchMailbox({ env = process.env, fetchImpl = fetch } = {}) {
  if (env.DATA_MODE === 'sample') return sampleMailbox();
  const { token, url, pages, gmail } = mailSettings(env);
  if (gmail) return fetchGmail({ env, fetchImpl, count: pages * 5 });
  if (!token || !url) throw fail('Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN (or JARVIS_EMAIL_URL and MCP_COMMAND_CENTER_TOKEN) so the Email agent can read the mailbox.', 503);
  const get = async target => {
    const response = await fetchImpl(target, { headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) { await response.body?.cancel(); throw fail('The email app is unavailable (HTTP ' + response.status + ').', 502); }
    return response.json();
  };
  const { stats = null, asOf = null } = await get(url);
  const messages = [];
  let cursor = null, messagesAvailable = true;
  for (let page = 0; page < pages; page++) {
    const target = new URL(url);
    target.searchParams.set('view', 'messages');
    target.searchParams.set('limit', '5');
    if (cursor) target.searchParams.set('cursor', cursor);
    let data;
    try { data = await get(target); } catch { messagesAvailable = page > 0; break; }
    if (!Array.isArray(data?.messages)) { messagesAvailable = page > 0; break; }
    for (const message of data.messages.slice(0, 5)) {
      if (typeof message?.subject !== 'string' || typeof message.text !== 'string') continue;
      messages.push({
        subject: excerpt(message.subject, 200),
        ...(typeof message.from === 'string' ? { from: excerpt(message.from, 120) } : {}),
        receivedAt: typeof message.receivedAt === 'string' ? message.receivedAt.slice(0, 40) : null,
        text: excerpt(message.text, 700),
      });
    }
    cursor = typeof data.nextCursor === 'string' && data.nextCursor.length <= 1000 && data.nextCursor !== cursor ? data.nextCursor : null;
    if (!cursor) break;
  }
  return { source: 'email-app', syncedAt: new Date().toISOString(), asOf: typeof asOf === 'string' ? asOf : null, stats, messages, messagesAvailable };
}

export async function syncMailbox({ env = process.env, fetchImpl = fetch, store }) {
  const snapshot = await fetchMailbox({ env, fetchImpl });
  await store.setJSON(MAIL_KEY, snapshot, {});
  return snapshot;
}

// Fresh snapshot for the Email agent: stored copy when under 15 minutes old, otherwise a live read.
// A stale copy is used (and flagged) when the live read fails.
export async function mailboxContext({ env = process.env, fetchImpl = fetch, store = null } = {}) {
  if (env.DATA_MODE === 'sample') return sampleMailbox();
  const stored = store ? await store.getWithMetadata(MAIL_KEY, { type: 'json' }).then(entry => entry?.data, () => null) : null;
  if (stored && Date.now() - Date.parse(stored.syncedAt) < maxAgeMs) return stored;
  try {
    const snapshot = await fetchMailbox({ env, fetchImpl });
    if (store) await store.setJSON(MAIL_KEY, snapshot, {}).catch(() => {});
    return snapshot;
  } catch (error) {
    if (stored) return { ...stored, stale: true };
    throw error;
  }
}
