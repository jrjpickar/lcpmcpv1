// Weekdays 7:05 AM Pacific standard time (15:05 UTC, so 8:05 AM during daylight saving time): post the Systems briefing to SLACK_BRIEFING_CHANNEL.
// Skips when SLACK_BOT_TOKEN or SLACK_BRIEFING_CHANNEL is missing.
import { postBriefing, slackSettings } from './lib/slack.mjs';
import { claimRun, netlifyShouldSkip } from './lib/schedules.mjs';

// RUN_SCHEDULES_ON=vm: the VM runs this job and Netlify exits at once.
export default async () => {
  if (netlifyShouldSkip('slack-briefing')) return;
  try {
    const { token, briefingChannel } = slackSettings();
    if (token && briefingChannel && !(await claimRun('slack-briefing'))) return;
    const result = await postBriefing();
    console.log('Slack briefing', JSON.stringify(result));
  } catch (error) {
    console.log('Slack briefing failed', error.message);
  }
};
export const config = { schedule: '5 15 * * 1-5' };
