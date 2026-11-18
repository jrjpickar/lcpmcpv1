import { readFileSync, renameSync, writeFileSync } from 'node:fs';
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
