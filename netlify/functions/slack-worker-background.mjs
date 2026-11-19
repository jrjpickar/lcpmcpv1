// Netlify background function (up to 15 minutes). Runs the JARVIS work for one Slack event.
// Only accepts work signed by slack-events with SLACK_SIGNING_SECRET.
import { createSlackWorker, slackSettings, verifyWorker } from './lib/slack.mjs';

export default async request => {
  const { secret } = slackSettings();
  const body = await request.text();
  if (!verifyWorker(secret, body, request.headers.get('x-lcp-slack-worker'))) return new Response('', { status: 401 });
  try {
    const { event } = JSON.parse(body);
    await createSlackWorker()(event);
  } catch (error) {
    console.log('Slack worker failed', error.message);
  }
  return new Response('', { status: 202 });
};
export const config = {};
