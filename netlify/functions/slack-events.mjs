// POST /api/slack/events: Slack Events API endpoint for the JARVIS bot user.
// Verifies the Slack signature, answers url_verification, acks within Slack's 3 second limit,
// then hands the event to slack-worker-background (signed with SLACK_SIGNING_SECRET).
import { slackSettings, verifySlack, workerSignature } from './lib/slack.mjs';
import { json } from './lib/auth.mjs';

const seen = new Map();
export function createSlackEventsHandler({ env = process.env, fetchImpl = fetch, dispatch = null } = {}) {
  return async function handler(request) {
    if (request.method !== 'POST') return json({ error: 'POST required' }, 405, { Allow: 'POST' });
    const { secret, token } = slackSettings(env);
    if (!secret || !token) return json({ error: 'Set SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET.' }, 503);
    const body = await request.text();
    if (body.length > 65536 || !verifySlack(request.headers, body, secret)) return json({ error: 'Invalid Slack signature.' }, 401);
    let payload;
    try { payload = JSON.parse(body); } catch { return json({ error: 'Invalid JSON.' }, 400); }
    if (payload.type === 'url_verification') return json({ challenge: String(payload.challenge || '') });
    // Slack retries when the first ack was slow. The first delivery already started the work.
    if (request.headers.get('x-slack-retry-num')) return new Response('', { status: 200 });
    if (payload.type !== 'event_callback' || !payload.event) return new Response('', { status: 200 });
    if (payload.event_id) {
      if (seen.has(payload.event_id)) return new Response('', { status: 200 });
      seen.set(payload.event_id, Date.now());
      if (seen.size > 500) seen.delete(seen.keys().next().value);
    }
    const work = JSON.stringify({ event: payload.event });
    try {
      if (dispatch) await dispatch(work);
      else {
        await fetchImpl(new URL('/.netlify/functions/slack-worker-background', request.url), {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-lcp-slack-worker': workerSignature(secret, work) }, body: work, signal: AbortSignal.timeout(2500),
        });
      }
    } catch (error) {
      console.log('Slack dispatch failed', error.message);
    }
    return new Response('', { status: 200 });
  };
}
export default createSlackEventsHandler();
export const config = { path: '/api/slack/events' };
