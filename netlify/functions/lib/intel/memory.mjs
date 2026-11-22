// Durable knowledge memory: decisions, preferences, outcomes, bugs, deployments, research and open items.
// Survives restarts and model changes because it lives in JARVIS storage (Netlify Blobs / Supabase on Netlify,
// SQLite or Supabase on the VM), never in function memory or local files on Netlify.
// One record per scope: facts/<scope> = { items: [...] }. Scopes are access boundaries (INTEL_SCOPES).
// Dedupe: same normalized text = update; Jaccard >= 0.8 within the same kind = merge into the existing item.
// Retention: per-kind TTL in days (INTEL_MEMORY_TTL_DAYS JSON overrides). Expired items are purged on write and hidden on read.
// Secrets are refused: the memory never stores API keys, tokens or passwords.
import { randomUUID } from 'node:crypto';
import { update } from '../jarvis-memory.mjs';
import { clip, jaccard, sha256, tokenize, bm25 } from './text.mjs';
import { allowedScopes, checkScope } from './knowledge.mjs';
import { containsSecret } from './safety.mjs';

export const KINDS = ['architecture', 'decision', 'preference', 'instruction', 'task', 'outcome', 'bug', 'fix', 'deployment', 'research', 'todo'];
const DEFAULT_TTL = { task: 120, outcome: 180, research: 180, todo: 365 };
const MAX_ITEMS = 1000;
const key = scope => 'facts/' + scope;
const empty = () => ({ items: [] });
const normal = text => String(text).toLowerCase().replace(/\s+/g, ' ').replace(/[^\w ]/g, '').trim();

export function ttlDays(kind, env = process.env) {
  let overrides = {};
  try { overrides = JSON.parse(env.INTEL_MEMORY_TTL_DAYS || '{}'); } catch { /* ignore a broken value */ }
  const value = overrides[kind] ?? DEFAULT_TTL[kind];
  return Number.isFinite(value) && value > 0 ? value : null;
}
const live = (item, at = Date.now()) => !item.expiresAt || Date.parse(item.expiresAt) > at;
const fail = (message, status) => Object.assign(new Error(message), { status });

export function createFacts({ store, env = process.env, now = () => Date.now() }) {
  function clean(input) {
    const text = clip(String(input.text || '').trim(), 1200);
    if (text.length < 3) throw fail('Memory text is required.', 400);
    if (containsSecret(text) || containsSecret(input.source || '')) throw fail('Memory never stores secrets (API keys, tokens, passwords). Store the variable name instead.', 422);
    const kind = KINDS.includes(input.kind) ? input.kind : 'decision';
    const tags = (Array.isArray(input.tags) ? input.tags : []).map(tag => clip(String(tag).toLowerCase().replace(/[^a-z0-9_-]/g, ''), 30)).filter(Boolean).slice(0, 8);
    const status = ['open', 'resolved'].includes(input.status) ? input.status : (['todo', 'bug'].includes(kind) ? 'open' : undefined);
    return { text, kind, tags, source: clip(input.source || '', 300), ...(status ? { status } : {}) };
  }

  async function add(input, { scope = 'lcp', by = 'operator' } = {}) {
    checkScope(scope, env);
    const fields = clean(input);
    const stamp = new Date(now()).toISOString();
    const ttl = input.ttlDays === null ? null : Number.isFinite(input.ttlDays) && input.ttlDays > 0 ? input.ttlDays : ttlDays(fields.kind, env);
    const expiresAt = ttl ? new Date(now() + ttl * 86400000).toISOString() : null;
    let outcome;
    await update(store, key(scope), empty, data => {
      data.items = data.items.filter(item => live(item, now()));
      const hash = sha256(normal(fields.text)).slice(0, 24);
      const same = data.items.find(item => item.hash === hash) ||
        data.items.find(item => item.kind === fields.kind && jaccard(item.text, fields.text) >= 0.8);
      if (same) {
        Object.assign(same, fields, { hash, updatedAt: stamp, expiresAt: expiresAt ?? same.expiresAt, mentions: (same.mentions || 1) + 1, by });
        outcome = { status: 'merged', item: { ...same } };
        return;
      }
      const item = { id: randomUUID(), scope, ...fields, hash, by, createdAt: stamp, updatedAt: stamp, expiresAt, mentions: 1 };
      data.items.unshift(item);
      if (data.items.length > MAX_ITEMS) data.items = data.items.slice(0, MAX_ITEMS);
      outcome = { status: 'added', item: { ...item } };
    });
    return outcome;
  }

  async function edit(id, changes, { scope = 'lcp' } = {}) {
    checkScope(scope, env);
    let found = null;
    await update(store, key(scope), empty, data => {
      const item = data.items.find(entry => entry.id === id);
      if (!item) return false;
      const fields = clean({ ...item, ...changes });
      Object.assign(item, fields, { hash: sha256(normal(fields.text)).slice(0, 24), updatedAt: new Date(now()).toISOString() });
      if (changes.ttlDays === null) item.expiresAt = null;
      found = { ...item };
    });
    if (!found) throw fail('Memory item not found.', 404);
    return found;
  }

  async function remove(id, { scope = 'lcp' } = {}) {
    checkScope(scope, env);
    let removed = false;
    await update(store, key(scope), empty, data => {
      const before = data.items.length;
      data.items = data.items.filter(item => item.id !== id);
      removed = data.items.length < before;
      if (!removed) return false;
    });
    if (!removed) throw fail('Memory item not found.', 404);
    return { removed: true };
  }

  // Retention control: drop expired items, and optionally everything of a kind or older than N days.
  async function purge({ scope = 'lcp', kind, olderThanDays } = {}) {
    checkScope(scope, env);
    let count = 0;
    await update(store, key(scope), empty, data => {
      const before = data.items.length;
      const cutoff = Number.isFinite(olderThanDays) ? now() - olderThanDays * 86400000 : null;
      data.items = data.items.filter(item => live(item, now()) && !(kind && item.kind === kind && !cutoff) && !(cutoff && Date.parse(item.updatedAt) < cutoff && (!kind || item.kind === kind)));
      count = before - data.items.length;
      if (!count) return false;
    });
    return { purged: count };
  }

  async function all(scopes = allowedScopes(env)) {
    const lists = await Promise.all(scopes.filter(s => allowedScopes(env).includes(s)).map(async scope => (await store.getWithMetadata(key(scope), { type: 'json' }))?.data?.items || []));
    return lists.flat().filter(item => live(item, now()));
  }

  // Keyword retrieval with a small boost for recent and open items. Empty query lists the newest items.
  async function search(query = '', { scopes, kinds, limit = 10, status } = {}) {
    let items = await all(scopes);
    if (kinds?.length) items = items.filter(item => kinds.includes(item.kind));
    if (status) items = items.filter(item => item.status === status);
    const q = tokenize(query);
    if (!q.length) return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit);
    const scores = bm25(q, items.map(item => tokenize(item.text + ' ' + item.tags.join(' ') + ' ' + item.kind)));
    return items.map((item, i) => ({ item, score: scores[i] + (item.status === 'open' ? 0.2 : 0) + Math.max(0, 0.3 - (now() - Date.parse(item.updatedAt)) / (86400000 * 300)) }))
      .filter(row => row.score > 0.35).sort((a, b) => b.score - a.score).slice(0, limit).map(row => ({ ...row.item, score: Number(row.score.toFixed(3)) }));
  }

  async function stats() {
    const items = await all();
    const byKind = {};
    for (const item of items) byKind[item.kind] = (byKind[item.kind] || 0) + 1;
    return { total: items.length, byKind, open: items.filter(item => item.status === 'open').length, scopes: allowedScopes(env) };
  }

  return { add, edit, remove, purge, search, stats, all };
}
