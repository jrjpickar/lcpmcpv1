// Background run of the dashboard data sync (lib/dash-sync.mjs). Started by dash-sync-scheduled with DASH_SYNC_SECRET.
// A run that does not finish in one invocation (the nightly full contact pass) queues the next one itself.
import { timingSafeEqual, createHash } from 'node:crypto';
import { runDashSync } from './lib/dash-sync.mjs';

const same = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());

export function createSyncHandler({ env = process.env, run = runDashSync, fetchImpl = fetch } = {}) {
  return async function handler(request) {
    const secret = env.DASH_SYNC_SECRET || '';
    if (request.method !== 'POST' || secret.length < 16 || !same(request.headers.get('x-sync-secret') || '', secret)) return new Response(null, { status: 401 });
    const force = new URL(request.url).searchParams.get('force') === 'full' ? 'full' : '';
    const hop = Number(request.headers.get('x-sync-hop') || 0);
    const result = await run({ env, force, budgetMs: 13 * 60000 });
    console.log('dash sync', JSON.stringify({ ...result, warnings: result.warnings?.length }));
    if (result.more && hop < 8 && env.URL) {
      await fetchImpl(`${env.URL}/.netlify/functions/dash-sync-background`, { method: 'POST', headers: { 'x-sync-secret': secret, 'x-sync-hop': String(hop + 1) }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    }
    return new Response(null, { status: 202 });
  };
}
export default createSyncHandler();
