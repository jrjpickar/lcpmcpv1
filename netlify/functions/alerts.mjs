import { currentAlerts, postSlack, alertStore } from './lib/alerts.mjs';
import { dashboardAuthorized, json } from './lib/auth.mjs';

// GET  /api/alerts          what the 5-minute check would send right now (nothing is posted)
// POST /api/alerts {test}   posts one test message to ALERT_WEBHOOK_URL so you can confirm the Slack wiring
export default async function handler(request) {
  if (!dashboardAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  try {
    if (request.method === 'GET') { const { alerts, baseline } = await currentAlerts({ store: alertStore() }); return json({ alerts, baselineDay: baseline.day }); }
    if (request.method === 'POST') { await postSlack({ text: ':white_check_mark: *LCP alerts connected.* Checks run every 5 minutes, 9am to 9pm Pacific.' }); return json({ ok: true }); }
    return json({ error: 'Method not allowed' }, 405);
  } catch (error) { return json({ error: error.message }, error.status || 500); }
}
export const config = { path: '/api/alerts' };
