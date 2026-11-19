// POST /api/jarvis-email-draft { to, cc?, subject, body, replyToId? } -> saves a Gmail draft (drafts.create) for review.
// Studio key with mailbox access, same origin, JSON. Never sends: there is no send code path in this project.
// Sample mode returns a fake draft id and makes no Gmail call.
import { json } from './lib/auth.mjs';
import { checkDraft, createDraft } from './lib/gmail.mjs';
import { jarvisAccess, readBody } from './lib/studio.mjs';

export function createEmailDraftHandler({ env = process.env, fetchImpl = fetch } = {}) {
  return async function handler(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    const access = jarvisAccess(request, env);
    if (!access) return json({ error: 'Administrator key rejected.' }, 401);
    if (!access.mailbox) return json({ error: 'Mailbox access is not enabled for this sign-in.' }, 403);
    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
    let input;
    try {
      input = await readBody(request, 32768);
      checkDraft(input);
    } catch (error) {
      return json({ error: error.agentStatus === 400 ? error.message : 'Invalid draft.' }, 400);
    }
    if (env.DATA_MODE === 'sample') return json({ ok: true, sample: true, draftId: 'sample-draft', link: 'https://mail.google.com/mail/u/0/#drafts' });
    try {
      const saved = await createDraft(input, { env, fetchImpl });
      return json({ ok: true, ...saved, link: 'https://mail.google.com/mail/u/0/#drafts' });
    } catch (error) {
      return json({ error: error.agentStatus ? error.message : 'Gmail could not save the draft.' }, error.agentStatus || 502);
    }
  };
}

export default createEmailDraftHandler();
export const config = { path: '/api/jarvis-email-draft' };
