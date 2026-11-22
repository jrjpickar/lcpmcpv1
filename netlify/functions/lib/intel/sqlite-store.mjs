// SQLite key-value store for the VM (persistent /data volume). Same interface as the Blobs and Supabase adapters:
// getWithMetadata(key) -> { data, etag } | null, setJSON(key, data, { onlyIfNew | onlyIfMatch }) -> { modified, etag }, delete(key).
// Never used on Netlify: function filesystems are not durable there. Uses node:sqlite (Node 22.5+), no dependency.
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export async function sqliteKeyedStore(file) {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, data TEXT NOT NULL, etag TEXT NOT NULL, updated_at TEXT NOT NULL)');
  const get = db.prepare('SELECT data, etag FROM kv WHERE key = ?');
  const insert = db.prepare('INSERT OR IGNORE INTO kv (key, data, etag, updated_at) VALUES (?, ?, ?, ?)');
  const match = db.prepare('UPDATE kv SET data = ?, etag = ?, updated_at = ? WHERE key = ? AND etag = ?');
  const upsert = db.prepare('INSERT INTO kv (key, data, etag, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET data = excluded.data, etag = excluded.etag, updated_at = excluded.updated_at');
  const remove = db.prepare('DELETE FROM kv WHERE key = ?');
  return {
    kind: 'sqlite',
    async getWithMetadata(key) {
      const row = get.get(key);
      return row ? { data: JSON.parse(row.data), etag: row.etag } : null;
    },
    async setJSON(key, data, condition = {}) {
      const etag = randomUUID(), at = new Date().toISOString(), text = JSON.stringify(data);
      if (condition.onlyIfNew) return { modified: insert.run(key, text, etag, at).changes === 1, etag };
      if (condition.onlyIfMatch) return { modified: match.run(text, etag, at, key, condition.onlyIfMatch).changes === 1, etag };
      upsert.run(key, text, etag, at);
      return { modified: true, etag };
    },
    async delete(key) { remove.run(key); },
    close() { db.close(); },
  };
}
