import { dashboardAuthorized, json } from './lib/auth.mjs';
import { loadBrainStatus } from './lib/brain-status.mjs';

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (process.env.DATA_MODE !== 'sample' && !dashboardAuthorized(request, false)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  return json(await loadBrainStatus());
}

export const config = { path: '/api/brain-status' };
