import { buildReport, paramsFrom } from './lib/report.mjs';
import { dashboardAuthorized, json } from './lib/auth.mjs';

// GET /api/metrics?from=YYYY-MM-DD&to=YYYY-MM-DD&rep=Name   (or preset=today|7d|wtd|mtd|30d|90d|ytd)
export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (!dashboardAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  try {
    const url = new URL(request.url);
    return json(await buildReport(paramsFrom(Object.fromEntries(url.searchParams))));
  } catch (error) {
    return json({ error: error.message }, error.status || 500);
  }
}
export const config = { path: '/api/metrics' };
