import { createHmac } from 'node:crypto';
import { json } from './lib/auth.mjs';
import { digest, linkedIdentity, origin, safeEqual, signLaunch } from './lib/voice/state.mjs';
import { readBody } from './lib/voice/providers.mjs';

const reply = text => json({ response_type: 'ephemeral', text, unfurl_links: false, unfurl_media: false });

export default async (request, { env = process.env, now = Date.now() } = {}) => {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, { Allow: 'POST' });
  if (env.VOICE_ENABLED !== '1' || !env.SLACK_SIGNING_SECRET || !env.VOICE_SLACK_APP_ID) return json({ error: 'Unavailable' }, 503);
  const timestamp = request.headers.get('x-slack-request-timestamp') || '';
  const signature = request.headers.get('x-slack-signature') || '';
  if (!/^\d{10}$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300 || !/^v0=[a-f0-9]{64}$/.test(signature)) {
    return json({ error: 'Invalid Slack signature' }, 401);
  }
  try {
    const body = await readBody(request, 8192);
    const expected = createHmac('sha256', env.SLACK_SIGNING_SECRET).update('v0:' + timestamp + ':').update(body).digest();
    if (!safeEqual(Buffer.from(signature.slice(3), 'hex'), expected)) return json({ error: 'Invalid Slack signature' }, 401);
    const params = new URLSearchParams(body.toString('utf8'));
    const slackId = params.get('team_id') + ':' + params.get('user_id');
    if (params.get('command') !== '/call-lcp' || params.get('api_app_id') !== env.VOICE_SLACK_APP_ID ||
        !/^T[A-Z0-9]+:[UW][A-Z0-9]+$/.test(slackId) || !linkedIdentity(env, slackId)) {
      return reply('This Slack account is not linked to an authorized LCP account.');
    }
    const expires = Number(timestamp) * 1000 + 120000;
    if (expires <= now) return reply('This command expired. Run /call-lcp again.');
    // A replay produces the same token. Only one redemption can create its session.
    const payload = Buffer.from(JSON.stringify({ slackId, expires, id: digest(signature) })).toString('base64url');
    const token = payload + '.' + signLaunch(env, payload).toString('base64url');
    return reply('<' + origin(env) + '/voice.html#launch=' + token + '|Open Call Brain> · Expires in up to 2 minutes.');
  } catch (error) {
    return json({ error: 'Slack voice unavailable' }, error.status || 503);
  }
};
export const config = { path: '/api/slack/voice' };
