// Internal knowledge index (RAG) over JARVIS storage (Netlify Blobs or Supabase lcp_jarvis_kv; SQLite on the VM).
// Layout:
//   kb/manifest/<scope>          { embedModel, docs: { <docId>: { path, source, title, type, version, chunks, bytes, updatedAt } } }
//   kb/doc/<scope>/<docId>       { path, version, embedModel, chunks: [{ i, heading, text, v? }] }
// docId = sha256(scope + path). version = sha256(content) or the Git blob sha. Same version = no work, no embedding cost.
// Search = BM25 over chunk text, blended with cosine similarity when every chunk has a vector from the same embedding model.
// Scopes: lcp, a2z, shared. A deployment only touches the scopes in INTEL_SCOPES (default lcp,shared).
import { inflateSync } from 'node:zlib';
import { update } from '../jarvis-memory.mjs';
import { bm25, chunkCsv, chunkText, clip, cosine, mapLimit, packVector, sha256, tokenize, unpackVector } from './text.mjs';
import { embed, embedSettings } from './embed.mjs';
import { htmlToText, readJson } from './fetch.mjs';
import { containsSecret, sanitizeUntrusted } from './safety.mjs';

export const SCOPES = ['lcp', 'a2z', 'shared'];
export const limits = { docs: 500, docBytes: 2 * 1048576, chunksPerDoc: 400, repoFiles: 150, repoFileBytes: 262144 };
export const TEXT_TYPES = { md: 'markdown', markdown: 'markdown', txt: 'text', text: 'text', csv: 'csv', tsv: 'csv', json: 'json', html: 'html', htm: 'html', pdf: 'pdf',
  mjs: 'code', js: 'code', cjs: 'code', ts: 'code', tsx: 'code', jsx: 'code', py: 'code', sql: 'code', sh: 'code', yml: 'code', yaml: 'code', toml: 'code', css: 'code', xml: 'text', rst: 'text' };

export function allowedScopes(env = process.env) {
  const list = String(env.INTEL_SCOPES || 'lcp,shared').split(',').map(s => s.trim().toLowerCase()).filter(s => SCOPES.includes(s));
  return list.length ? list : ['lcp', 'shared'];
}
export function checkScope(scope, env = process.env) {
  if (!allowedScopes(env).includes(scope)) throw Object.assign(new Error('Scope "' + scope + '" is not allowed on this deployment. Allowed: ' + allowedScopes(env).join(', ') + '.'), { status: 403 });
  return scope;
}
export const typeOf = path => TEXT_TYPES[String(path).toLowerCase().split('.').pop()] || null;
const keys = { manifest: scope => 'kb/manifest/' + scope, doc: (scope, id) => 'kb/doc/' + scope + '/' + id };
const emptyManifest = () => ({ embedModel: null, docs: {} });
const docCache = new Map();

// Best-effort PDF text: Flate or raw content streams, literal strings in Tj, TJ, ' and ". Scanned PDFs and CID fonts yield nothing.
export function pdfText(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input, 'base64');
  const raw = buffer.toString('latin1');
  if (!raw.startsWith('%PDF')) throw Object.assign(new Error('Not a PDF file.'), { status: 400 });
  const out = [];
  const streamRe = /<<([\s\S]{0,2000}?)>>\s*stream\r?\n/g;
  let match;
  while ((match = streamRe.exec(raw)) && out.join('').length < 500000) {
    const start = match.index + match[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    const dict = match[1];
    if (/\/Subtype\s*\/Image|\/Type\s*\/XObject/.test(dict) && !/\/Subtype\s*\/Form/.test(dict)) { streamRe.lastIndex = end; continue; }
    let data = buffer.subarray(start, end);
    if (/\/FlateDecode/.test(dict)) { try { data = inflateSync(data); } catch { streamRe.lastIndex = end; continue; } }
    else if (/\/Filter/.test(dict)) { streamRe.lastIndex = end; continue; }
    const content = data.toString('latin1');
    if (!/\bBT\b/.test(content)) { streamRe.lastIndex = end; continue; }
    for (const block of content.match(/BT[\s\S]*?ET/g) || []) {
      const parts = [];
      const opRe = /\[((?:\([^)\\]*(?:\\.[^)\\]*)*\)|[^\]])*)\]\s*TJ|\(((?:[^()\\]|\\.|\([^()]*\))*)\)\s*(?:Tj|'|")|(T\*|Td|TD|Tm)/g;
      let op;
      while ((op = opRe.exec(block))) {
        if (op[3]) { parts.push(op[3] === 'Tm' || op[3] === 'T*' || op[3] === 'TD' ? '\n' : ' '); continue; }
        const strings = op[1] !== undefined ? [...op[1].matchAll(/\(((?:[^()\\]|\\.)*)\)/g)].map(m => m[1]) : [op[2]];
        parts.push(strings.map(s => s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (m, c) => ({ n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' })[c] ?? String.fromCharCode(parseInt(c, 8)))).join(''));
      }
      out.push(parts.join('').replace(/[ \t]+/g, ' '));
    }
    streamRe.lastIndex = end;
  }
  const text = out.join('\n').replace(/[^\x09\x0A\x20-\x7E\xA0-\xFF]/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (text.length < 40) throw Object.assign(new Error('No extractable text in this PDF (scanned or embedded fonts). Convert it with pdftotext and index the .txt.'), { status: 422 });
  return text;
}

// Turn an uploaded file into plain text + chunks. content is text, or base64 for PDF (encoding: 'base64').
export function extract(path, content, { encoding } = {}) {
  const type = typeOf(path);
  if (!type) throw Object.assign(new Error('Unsupported file type: ' + path), { status: 415 });
  let text;
  if (type === 'pdf') text = pdfText(encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'latin1'));
  else if (type === 'html') { const page = htmlToText(content); text = (page.title ? '# ' + page.title + '\n\n' : '') + page.text; }
  else if (type === 'json') { try { text = JSON.stringify(JSON.parse(content), null, 1); } catch { text = String(content); } }
  else text = String(content);
  if (Buffer.byteLength(text) > limits.docBytes) throw Object.assign(new Error('The document exceeds 2 MB of text. Split it first.'), { status: 413 });
  const chunks = type === 'csv' ? chunkCsv(text, { maxChunks: limits.chunksPerDoc }) : chunkText(text, { size: type === 'code' ? 1200 : 900, maxChunks: limits.chunksPerDoc });
  const title = /^#\s+(.+)$/m.exec(text)?.[1]?.slice(0, 160) || path.split('/').pop();
  return { type, text, chunks, title };
}

export function createKnowledge({ store, env = process.env, fetchImpl = fetch }) {
  async function manifest(scope) { return (await store.getWithMetadata(keys.manifest(scope), { type: 'json' }))?.data || emptyManifest(); }

  // Upsert one document. Returns { status: 'unchanged' | 'indexed', ... }.
  async function ingest({ scope = 'lcp', path, content, encoding, source = 'upload', version: given, title: givenTitle }) {
    checkScope(scope, env);
    if (typeof path !== 'string' || !/^[\w .@()/+-]{1,240}$/.test(path) || path.includes('..')) throw Object.assign(new Error('Invalid document path.'), { status: 400 });
    if (typeof content !== 'string' || !content) throw Object.assign(new Error('Document content is required.'), { status: 400 });
    const id = sha256(scope + ':' + path).slice(0, 40);
    const version = given || sha256(content);
    const current = await manifest(scope);
    const { model } = embedSettings(env);
    if (current.docs[id]?.version === version && (current.docs[id].embedModel || null) === (model || null)) return { status: 'unchanged', id, path, version };
    if (!current.docs[id] && Object.keys(current.docs).length >= limits.docs) throw Object.assign(new Error('The index holds ' + limits.docs + ' documents. Delete some first.'), { status: 409 });
    const { type, chunks, title } = extract(path, content, { encoding });
    if (containsSecret(chunks.map(c => c.text).join('\n'))) throw Object.assign(new Error('The document appears to contain a secret (API key, token or password). It was not indexed.'), { status: 422 });
    let vectors = null, embedError = null;
    try { vectors = await embed(chunks.map(c => (c.heading ? c.heading + '\n' : '') + c.text), { env, fetchImpl }); }
    catch (error) { embedError = clip(error.message, 160); }
    const stored = chunks.map((chunk, index) => ({ i: chunk.i, heading: chunk.heading, text: chunk.text, ...(vectors ? { v: packVector(vectors[index]) } : {}) }));
    const embedModel = vectors ? model : null;
    await store.setJSON(keys.doc(scope, id), { path, version, embedModel, chunks: stored });
    const bytes = chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
    await update(store, keys.manifest(scope), emptyManifest, data => {
      data.docs[id] = { path, source, title: givenTitle || title, type, version, chunks: chunks.length, bytes, embedModel, updatedAt: new Date().toISOString() };
    });
    docCache.delete(scope + ':' + id);
    return { status: 'indexed', id, path, version, chunks: chunks.length, embedded: Boolean(vectors), ...(embedError ? { embedError } : {}) };
  }

  async function remove(scope, ids) {
    checkScope(scope, env);
    const list = [].concat(ids).filter(Boolean);
    await update(store, keys.manifest(scope), emptyManifest, data => { for (const id of list) delete data.docs[id]; });
    await Promise.all(list.map(id => store.delete(keys.doc(scope, id)).catch(() => {})));
    for (const id of list) docCache.delete(scope + ':' + id);
    return { removed: list.length };
  }

  // Drop documents from a source whose paths are no longer present (stale entries after a repo sync).
  async function prune(scope, source, keepPaths) {
    const keep = new Set(keepPaths);
    const current = await manifest(scope);
    const stale = Object.entries(current.docs).filter(([, doc]) => doc.source === source && !keep.has(doc.path)).map(([id]) => id);
    if (stale.length) await remove(scope, stale);
    return stale.length;
  }

  async function loadDoc(scope, id, version) {
    const cacheKey = scope + ':' + id;
    const hit = docCache.get(cacheKey);
    if (hit?.version === version) return hit;
    const doc = (await store.getWithMetadata(keys.doc(scope, id), { type: 'json' }))?.data;
    if (!doc) return null;
    doc.tokens = doc.chunks.map(chunk => tokenize((chunk.heading || '') + ' ' + chunk.text + ' ' + doc.path));
    docCache.set(cacheKey, doc);
    if (docCache.size > 600) docCache.delete(docCache.keys().next().value);
    return doc;
  }

  // Hybrid search across allowed scopes. Returns passages with path, scope, score and a stable citation key.
  async function search(query, { scopes = allowedScopes(env), limit = 6, maxChars = 900 } = {}) {
    const q = String(query || '').trim().slice(0, 500);
    if (!q) return { query: q, results: [], searched: 0 };
    const allowed = scopes.filter(scope => allowedScopes(env).includes(scope));
    const manifests = await Promise.all(allowed.map(async scope => [scope, await manifest(scope)]));
    const entries = manifests.flatMap(([scope, m]) => Object.entries(m.docs).map(([id, doc]) => ({ scope, id, ...doc })));
    if (!entries.length) return { query: q, results: [], searched: 0 };
    const docs = (await mapLimit(entries, 8, entry => loadDoc(entry.scope, entry.id, entry.version))).map((doc, i) => doc && { ...entries[i], doc }).filter(Boolean);
    const flat = docs.flatMap(entry => entry.doc.chunks.map((chunk, index) => ({ entry, chunk, tokens: entry.doc.tokens[index] })));
    const keyword = bm25(tokenize(q), flat.map(item => item.tokens));
    const maxKeyword = Math.max(...keyword, 1e-9);
    const { model } = embedSettings(env);
    let qv = null, semantic = false;
    if (model && flat.some(item => item.entry.doc.embedModel === model && item.chunk.v)) {
      try { qv = (await embed([q], { env, fetchImpl, query: true, timeoutMs: 4000 }))?.[0]; semantic = Boolean(qv); } catch { /* keyword only */ }
    }
    const scored = flat.map((item, index) => {
      const k = keyword[index] / maxKeyword;
      const vector = semantic && item.entry.doc.embedModel === model && item.chunk.v;
      const s = vector ? Math.max(0, cosine(qv, unpackVector(item.chunk.v))) : 0;
      return { item, score: vector ? 0.45 * k + 0.55 * s : 0.8 * k, keyword: k, semantic: s };
    }).filter(row => row.score > (semantic ? 0.2 : 0.05)).sort((a, b) => b.score - a.score);
    const perDoc = new Map(), results = [];
    for (const row of scored) {
      const count = perDoc.get(row.item.entry.id) || 0;
      if (count >= 2) continue;
      perDoc.set(row.item.entry.id, count + 1);
      results.push({ scope: row.item.entry.scope, path: row.item.entry.path, title: row.item.entry.title, source: row.item.entry.source, version: row.item.entry.version.slice(0, 12),
        heading: row.item.chunk.heading || '', text: sanitizeUntrusted(row.item.chunk.text, maxChars), score: Number(row.score.toFixed(3)), updatedAt: row.item.entry.updatedAt });
      if (results.length >= limit) break;
    }
    return { query: q, results, searched: flat.length, mode: semantic ? 'hybrid' : 'keyword' };
  }

  async function status() {
    const out = {};
    for (const scope of allowedScopes(env)) {
      const m = await manifest(scope);
      const docs = Object.values(m.docs);
      out[scope] = { documents: docs.length, chunks: docs.reduce((s, d) => s + d.chunks, 0), embedded: docs.filter(d => d.embedModel).length,
        sources: [...new Set(docs.map(d => d.source))], updatedAt: docs.map(d => d.updatedAt).sort().pop() || null };
    }
    return { scopes: out, embeddings: embedSettings(env), limits };
  }

  async function list(scope) {
    checkScope(scope, env);
    return Object.entries((await manifest(scope)).docs).map(([id, doc]) => ({ id, ...doc })).sort((a, b) => a.path.localeCompare(b.path));
  }

  // Index a GitHub repository (read-only). Unchanged files are skipped by Git blob sha; removed files are pruned.
  async function syncRepo({ repo, ref, scope = 'lcp', include = /./, deadlineMs = 600000 }) {
    checkScope(scope, env);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(String(repo || ''))) throw Object.assign(new Error('Use owner/repo.'), { status: 400 });
    const allowed = String(env.INTEL_REPOS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!allowed.includes(repo.toLowerCase())) throw Object.assign(new Error('Add ' + repo + ' to INTEL_REPOS before indexing it.'), { status: 403 });
    const started = Date.now();
    const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'LCP-JARVIS-Index',
      ...(env.GITHUB_TOKEN?.trim() ? { authorization: 'Bearer ' + env.GITHUB_TOKEN.trim() } : {}) };
    const base = 'https://api.github.com/repos/' + repo;
    const branch = ref || (await readJson(base, { headers }, { fetchImpl })).default_branch;
    const tree = await readJson(base + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1', { headers }, { fetchImpl });
    const skip = /(?:^|\/)(?:node_modules|dist|build|\.git|\.netlify|coverage|vendor)\/|package-lock\.json$|\.min\.js$|(?:^|\/)\.env/;
    const files = (tree.tree || []).filter(item => item.type === 'blob' && typeOf(item.path) && item.size <= limits.repoFileBytes && !skip.test(item.path) && include.test(item.path))
      .slice(0, limits.repoFiles);
    const source = 'github:' + repo;
    const current = await manifest(scope);
    const byPath = new Map(Object.values(current.docs).filter(d => d.source === source).map(d => [d.path, d.version]));
    const report = { repo, ref: branch, files: files.length, indexed: 0, unchanged: 0, failed: [], truncated: Boolean(tree.truncated) };
    for (const file of files) {
      const path = repo + '/' + file.path;
      if (byPath.get(path) === file.sha) { report.unchanged++; continue; }
      if (Date.now() - started > deadlineMs) { report.failed.push({ path: file.path, error: 'time budget reached' }); continue; }
      try {
        const blob = await readJson(base + '/git/blobs/' + file.sha, { headers }, { fetchImpl });
        const buffer = Buffer.from(blob.content || '', 'base64');
        const isPdf = typeOf(file.path) === 'pdf';
        const result = await ingest({ scope, path, content: isPdf ? buffer.toString('base64') : buffer.toString('utf8'), encoding: isPdf ? 'base64' : undefined, source, version: file.sha });
        report[result.status === 'unchanged' ? 'unchanged' : 'indexed']++;
      } catch (error) { report.failed.push({ path: file.path, error: clip(error.message, 120) }); }
    }
    report.pruned = report.truncated ? 0 : await prune(scope, source, files.map(file => repo + '/' + file.path));
    report.ms = Date.now() - started;
    return report;
  }

  return { ingest, remove, prune, search, status, list, syncRepo, manifest };
}
