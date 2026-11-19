// Storage for JARVIS. Netlify Blobs (store "lcp-jarvis", strong consistency) by default.
// Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to use the Supabase table lcp_jarvis_kv instead
// (see supabase/migrations). Both adapters expose getWithMetadata, setJSON with conditional writes, and delete.
import { randomUUID } from 'node:crypto';

export const STORE_NAME = 'lcp-jarvis';
const TABLE = 'lcp_jarvis_kv';

export function supabaseStore({ url, key, fetchImpl = fetch }) {
  const base = new URL('/rest/v1/' + TABLE, url);
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(base.hostname)) throw new Error('SUPABASE_URL must use HTTPS.');
  const headers = (extra = {}) => ({ apikey: key, authorization: 'Bearer ' + key, 'content-type': 'application/json', accept: 'application/json', ...extra });
  const at = (query = {}) => {
    const target = new URL(base);
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
    return target;
  };
  async function send(target, init) {
    const response = await fetchImpl(target, { ...init, redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (response.status === 409) { await response.body?.cancel(); return null; }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error('Supabase HTTP ' + response.status);
    }
    return response;
  }
  return {
    async getWithMetadata(key) {
      const response = await send(at({ key: 'eq.' + key, select: 'data,etag' }), { headers: headers() });
      const [row] = await response.json();
      return row ? { data: row.data, etag: row.etag } : null;
    },
    async setJSON(key, data, condition = {}) {
      const etag = randomUUID();
      const row = { key, data, etag, updated_at: new Date().toISOString() };
      if (condition.onlyIfNew) {
        const response = await send(at(), { method: 'POST', headers: headers({ prefer: 'return=minimal' }), body: JSON.stringify(row) });
        return response ? { modified: true, etag } : { modified: false };
      }
      if (condition.onlyIfMatch) {
        const response = await send(at({ key: 'eq.' + key, etag: 'eq.' + condition.onlyIfMatch }),
          { method: 'PATCH', headers: headers({ prefer: 'return=representation' }), body: JSON.stringify({ data, etag, updated_at: row.updated_at }) });
        const rows = response ? await response.json() : [];
        return rows.length ? { modified: true, etag } : { modified: false };
      }
      await send(at({ on_conflict: 'key' }), { method: 'POST', headers: headers({ prefer: 'resolution=merge-duplicates,return=minimal' }), body: JSON.stringify(row) });
      return { modified: true, etag };
    },
    async delete(key) {
      await send(at({ key: 'eq.' + key }), { method: 'DELETE', headers: headers({ prefer: 'return=minimal' }) });
    },
  };
}

export async function openJarvisStore(env = process.env) {
  const url = env.SUPABASE_URL?.trim();
  const key = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (url && key) return supabaseStore({ url, key });
  const { getStore } = await import('@netlify/blobs');
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}
