import { dashboardAuthorized, json } from './lib/auth.mjs';
import { sourceStatus } from './lib/sources.mjs';
import { loadBrainStatus } from './lib/brain-status.mjs';

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (process.env.DATA_MODE !== 'sample' && !dashboardAuthorized(request, false)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  const status = await loadBrainStatus(process.env, fetch, { fresh });
  return json(status.sample ? status : { ...status, sources: sourceStatus() });
}

export const config = { path: '/api/brain-status' };
