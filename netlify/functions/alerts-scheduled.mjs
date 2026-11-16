import { runAlertCheck } from './lib/alerts.mjs';

// Every 5 minutes. The UTC hours cover 9am to 9pm Pacific in both PDT (16:00-04:59 UTC) and PST (17:00-05:59 UTC);
// runAlertCheck exits early outside 9am to 9pm Pacific, so the edge hours cost one tiny invocation and no API calls.
export default async () => {
  const result = await runAlertCheck();
  if (result.sent || result.error) console.log('alert check', JSON.stringify(result));
  return new Response(null, { status: 204 });
};
export const config = { schedule: '*/5 0-5,16-23 * * *' };
