import { dashboardAuthorized, json } from './lib/auth.mjs';
import { activityIsSample, loadActivity } from './lib/activity.mjs';

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!dashboardAuthorized(request, activityIsSample())) return json({ error: 'Unauthorized' }, 401);
  try {
    return json(await loadActivity(Object.fromEntries(new URL(request.url).searchParams)));
  } catch (error) {
    return json({ error: error.message }, error.status || 500);
  }
}
export const config = { path: '/api/activity' };
