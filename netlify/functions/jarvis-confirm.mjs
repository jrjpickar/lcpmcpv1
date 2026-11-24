// POST /api/jarvis/confirm  Preview or confirm a new GHL opportunity (lcp_create_opportunity). Ported from A2Z.
// Body: { action: "create_opportunity", dryRun: true, args }                         -> preview + hash
//       { action: "create_opportunity", dryRun: false, args, hash, idempotencyKey }  -> creates once
// Studio key, same origin, JSON. Not reachable from MCP. JARVIS can prepare a preview; only this endpoint writes.
import { json } from './lib/auth.mjs';
import { jarvisAccess, readBody } from './lib/studio.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { createOpportunity, kv } from './lib/ghl-write.mjs';

export function createConfirmHandler({ env = process.env, fetchImpl = fetch, openStore = () => openJarvisStore(env) } = {}) {
  return async function handler(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405, { allow: 'POST' });
    if (!jarvisAccess(request, env)) return json({ error: 'Administrator key rejected.' }, 401);
    if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
    let body;
    try {
      body = await readBody(request, 16384);
      if (body?.action !== 'create_opportunity' || typeof body.dryRun !== 'boolean' || !body.args || typeof body.args !== 'object' || Array.isArray(body.args)) throw new Error();
    } catch {
      return json({ error: 'Invalid opportunity request.' }, 400);
    }
    try {
      const store = kv(await openStore());
      const result = await createOpportunity({ dryRun: body.dryRun, args: body.args, hash: body.hash, idempotencyKey: body.idempotencyKey, actor: 'dashboard (Studio key)' }, { env, fetchImpl, store });
      return json(result, body.dryRun ? 200 : 201);
    } catch (error) {
      return json({ error: error.status ? error.message : 'The opportunity request failed.' }, error.status || 502);
    }
  };
}
export default createConfirmHandler();
export const config = { path: '/api/jarvis/confirm' };
