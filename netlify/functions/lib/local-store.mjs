import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// File store: one JSON file per key, for the Docker server on the VM (Netlify Blobs only exists on Netlify). Ported from A2Z.
// The synchronous compare and rename keep writes atomic within one process. Netlify deploys use Blobs or Supabase.
export function localKeyedStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = key => {
    if (!/^[a-z0-9/-]+$/i.test(key)) throw new TypeError('Invalid key.');
    return join(directory, key.replaceAll('/', '__') + '.json');
  };
  const read = key => {
    try {
      return JSON.parse(readFileSync(path(key), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  return {
    async getWithMetadata(key) { return read(key); },
    async setJSON(key, data, condition = {}) {
      const current = read(key);
      if (condition.onlyIfNew ? current : condition.onlyIfMatch && current?.etag !== condition.onlyIfMatch) return { modified: false };
      const etag = randomUUID();
      const pending = path(key) + '.' + etag;
      writeFileSync(pending, JSON.stringify({ data, etag }), { mode: 0o600, flag: 'wx' });
      renameSync(pending, path(key));
      return { modified: true, etag };
    },
    async delete(key) { rmSync(path(key), { force: true }); },
  };
}
