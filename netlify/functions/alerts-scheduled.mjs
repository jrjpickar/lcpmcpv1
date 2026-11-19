import { runAlertCheck, withinHours } from './lib/alerts.mjs';
import { claimRun, netlifyShouldSkip } from './lib/schedules.mjs';

// Every 5 minutes. The UTC hours cover 9am to 9pm Pacific in both PDT (16:00-04:59 UTC) and PST (17:00-05:59 UTC);
// runAlertCheck exits early outside 9am to 9pm Pacific, so the edge hours cost one tiny invocation and no API calls.
// RUN_SCHEDULES_ON=vm: the VM runs this job and Netlify exits at once.
export default async () => {
  if (netlifyShouldSkip('alerts-scheduled')) return new Response(null, { status: 204 });
  if (process.env.ALERT_WEBHOOK_URL && withinHours() && !(await claimRun('alerts-scheduled'))) return new Response(null, { status: 204 });
  const result = await runAlertCheck();
  if (result.sent || result.error) console.log('alert check', JSON.stringify(result));
  return new Response(null, { status: 204 });
};
export const config = { schedule: '*/5 0-5,16-23 * * *' };
