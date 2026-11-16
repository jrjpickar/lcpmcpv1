import { loadWorkflows } from './lib/sources.mjs';
import { dashboardAuthorized, json } from './lib/auth.mjs';

// GET /api/workflows?days=30  GHL workflow stats, read from the v2 data dashboard's workflow feed.
export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!dashboardAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  try { return json(await loadWorkflows(new URL(request.url).searchParams.get('days'))); }
  catch (error) { return json({ error: error.message }, error.status || 500); }
}
export const config = { path: '/api/workflows' };
