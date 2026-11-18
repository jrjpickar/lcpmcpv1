import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// The local sandbox runs as one process. The synchronous compare and rename
// keep writes atomic within that process. Netlify uses its own Blob adapter.
export function localStudioStore(file) {
  function read() {
    try {
      return JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  return {
    getWithMetadata: read,
    setJSON(_key, data, condition) {
      const current = read();
      if (condition.onlyIfNew ? current : current?.etag !== condition.onlyIfMatch) return { modified: false };
      const etag = randomUUID();
      const pending = file + '.' + etag;
      writeFileSync(pending, JSON.stringify({ data, etag }), { mode: 0o600, flag: 'wx' });
      renameSync(pending, file);
      return { modified: true, etag };
    },
  };
}

// Multi-key store for JARVIS chats and memory. One JSON file per key inside a directory.
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
