import { loadLeads } from './lib/leads.mjs';
import { dashboardAuthorized, json } from './lib/auth.mjs';

// GET /api/leads?from=YYYY-MM-DD&to=YYYY-MM-DD&rep=Name   Opportunities created in range, by pipeline and by city (ZIP tag).
export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!dashboardAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  try {
    const url = new URL(request.url);
    return json(await loadLeads({ from: url.searchParams.get('from'), to: url.searchParams.get('to'), rep: url.searchParams.get('rep') || '' }));
  } catch (error) {
    return json({ error: error.message }, error.status || 500);
  }
}
export const config = { path: '/api/leads' };
