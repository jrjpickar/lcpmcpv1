import { dashboardAuthorized, json } from './lib/auth.mjs';
import { sourceStatus } from './lib/sources.mjs';
import { loadBrainStatus } from './lib/brain-status.mjs';

import { openJarvisStore } from './lib/jarvis-store.mjs';
import { HISTORY_KEY, sourceState } from './lib/source-history.mjs';

export default async function handler(request) {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
  if (process.env.DATA_MODE !== 'sample' && !dashboardAuthorized(request, false)) {
    return json({ error: 'Unauthorized' }, 401);
  }
  const fresh = new URL(request.url).searchParams.get('fresh') === '1';
  const status = await loadBrainStatus(process.env, fetch, { fresh });
  if (status.sample) return json(status);
  const record = await openJarvisStore()
    .then(store => store.getWithMetadata(HISTORY_KEY, { type: 'json' }))
    .catch(() => null);
  const history = {};
  for (const key of ['billing', 'groq']) {
    if (status[key].status !== 'off') history[key] = sourceState(record?.data?.[key]);
  }
  return json({ ...status, sources: sourceStatus(), history });
}

export const config = { path: '/api/brain-status' };
