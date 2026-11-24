// GET /api/dash             The synced data dashboard numbers (KPIs per window, tasks, appointments, marketing yield).
// GET /api/dash?part=news   Niche market headlines for the Marketing tab (cached 6 hours).
// Dashboard key, read only. The numbers come from lib/dash-sync.mjs (GHL, Twilio and the dialer, dashboard rules).
import { dashboardAuthorized, json } from './lib/auth.mjs';
import { dashDerived } from './lib/dash-data.mjs';
import { marketNews } from './lib/market-news.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { kv } from './lib/ghl-write.mjs';

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { allow: 'GET' });
  if (!dashboardAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  try {
    if (new URL(request.url).searchParams.get('part') === 'news') {
      const store = await openJarvisStore().then(kv).catch(() => null);
      return json(await marketNews({ store, limit: 3 }));
    }
    return json(await dashDerived());
  } catch (error) {
    return json({ error: error.message }, 500);
  }
}
export const config = { path: '/api/dash' };
