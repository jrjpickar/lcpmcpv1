// POST /api/dash-publish  The VM (RUN_SCHEDULES_ON=vm) sends each finished data dashboard sync here, so Brain, Marketing
// and Netlify MCP read the same numbers. Header x-sync-secret: DASH_SYNC_SECRET. Body: { derived, state }. Stores only those two keys.
import { createHash, timingSafeEqual } from 'node:crypto';
import { json } from './lib/auth.mjs';
import { dashStore } from './lib/dash-sync.mjs';

const same = (a, b) => timingSafeEqual(createHash('sha256').update(String(a)).digest(), createHash('sha256').update(String(b)).digest());
const LIMIT = 5 * 1024 * 1024;

export function createPublishHandler({ env = process.env, store = () => dashStore() } = {}) {
  return async function handler(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    const secret = env.DASH_SYNC_SECRET || '';
    if (secret.length < 16 || !same(request.headers.get('x-sync-secret') || '', secret)) return json({ error: 'Unauthorized' }, 401);
    const text = await request.text();
    if (text.length > LIMIT) return json({ error: 'Snapshot too large.' }, 413);
    let body;
    try { body = JSON.parse(text); } catch { return json({ error: 'Expected JSON.' }, 400); }
    const d = body?.derived;
    if (!d || typeof d !== 'object' || !d.windows || !d.marketing || typeof d.builtAt !== 'string') return json({ error: 'Invalid snapshot.' }, 400);
    const s = store();
    await s.setJSON('dash/derived', d);
    if (body.state?.run && typeof body.state.run === 'object') await s.setJSON('dash/state', { run: { ...body.state.run, ref: undefined, cursor: null, publishedFrom: 'vm' } });
    return json({ ok: true, builtAt: d.builtAt });
  };
}
export default createPublishHandler();
export const config = { path: '/api/dash-publish' };
