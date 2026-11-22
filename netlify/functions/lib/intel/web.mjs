// External knowledge: web search, page retrieval, GitHub reads and passage extraction.
// General web search: a self-hosted SearXNG instance (SEARXNG_URL, JSON format enabled). On the VM it runs next to the
// LCP container at http://searxng:8080 and is not reachable from the internet. Optional SEARXNG_TOKEN is sent as a
// Bearer header for an instance behind an auth proxy.
// Keyless sources, always available and used for their kind of question:
//   Wikipedia search API, GitHub search and contents API (GITHUB_TOKEN optional, raises rate limits), npm registry search.
// Every result has source URL and retrievedAt. Nothing here follows instructions in retrieved text.
import { bm25, chunkText, clip, mapLimit, sha256, tokenize } from './text.mjs';
import { fetchPage, readJson } from './fetch.mjs';
import { sanitizeUntrusted } from './safety.mjs';

const now = () => new Date().toISOString();
const cache = new Map();
const cached = async (key, ttlMs, fn, store) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return { ...hit.value, cached: true };
  if (store) {
    try {
      const entry = (await store.getWithMetadata('webcache/' + key, { type: 'json' }))?.data;
      if (entry && Date.now() - Date.parse(entry.at) < ttlMs) { cache.set(key, { at: Date.parse(entry.at), value: entry.value }); return { ...entry.value, cached: true }; }
    } catch { /* cache is optional */ }
  }
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  if (store) store.setJSON('webcache/' + key, { at: now(), value }).catch(() => {});
  return value;
};

// SEARXNG_URL is operator configuration, so internal hosts are allowed (http://searxng:8080 on the VM).
export function searxngBase(env = process.env) {
  const url = URL.parse(env.SEARXNG_URL?.trim() || '');
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
  return url.href.replace(/\/+$/, '');
}
export function webSettings(env = process.env) {
  const searxng = searxngBase(env);
  return { provider: searxng ? 'searxng' : null, searxng: searxng ? new URL(searxng).host : null, github: Boolean(env.GITHUB_TOKEN?.trim()), enabled: env.INTEL_WEB !== 'off' };
}

const result = (fields) => ({ title: clip(fields.title || fields.url, 200), url: fields.url, snippet: clip(sanitizeUntrusted(fields.snippet || '', 600), 600), source: fields.source, retrievedAt: now() });

async function searxng(query, { env, fetchImpl, limit, signal }) {
  const params = new URLSearchParams({ q: query, format: 'json', safesearch: '1', language: env.SEARXNG_LANGUAGE?.trim() || 'en' });
  if (env.SEARXNG_CATEGORIES?.trim()) params.set('categories', env.SEARXNG_CATEGORIES.trim());
  const headers = { accept: 'application/json', 'user-agent': 'LCP-JARVIS-Research/1.0', ...(env.SEARXNG_TOKEN?.trim() ? { authorization: 'Bearer ' + env.SEARXNG_TOKEN.trim() } : {}) };
  const data = await readJson(searxngBase(env) + '/search?' + params, { signal, headers }, { fetchImpl });
  return (data.results || []).filter(item => typeof item?.url === 'string' && /^https?:\/\//.test(item.url)).slice(0, limit)
    .map(item => result({ title: item.title, url: item.url, snippet: item.content, source: 'searxng' + (item.engine ? ':' + String(item.engine).slice(0, 20) : '') }));
}

async function wikipedia(query, { fetchImpl, limit, signal }) {
  const url = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ action: 'query', list: 'search', format: 'json', srlimit: String(limit), srsearch: query, origin: '*' });
  const data = await readJson(url, { signal, headers: { 'user-agent': 'LCP-JARVIS-Research/1.0' } }, { fetchImpl });
  return (data.query?.search || []).map(item => result({ title: item.title, url: 'https://en.wikipedia.org/wiki/' + encodeURIComponent(item.title.replace(/ /g, '_')),
    snippet: String(item.snippet || '').replace(/<[^>]+>/g, ''), source: 'wikipedia' }));
}

const githubHeaders = env => ({ accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'LCP-JARVIS-Research',
  ...(env.GITHUB_TOKEN?.trim() ? { authorization: 'Bearer ' + env.GITHUB_TOKEN.trim() } : {}) });

async function githubSearch(query, { env, fetchImpl, limit, signal }) {
  const url = 'https://api.github.com/search/repositories?' + new URLSearchParams({ q: query, per_page: String(limit), sort: 'stars' });
  const data = await readJson(url, { signal, headers: githubHeaders(env) }, { fetchImpl });
  return (data.items || []).map(item => result({ title: item.full_name + (item.stargazers_count ? ' (' + item.stargazers_count + ' stars)' : ''), url: item.html_url,
    snippet: [item.description, item.language, item.pushed_at ? 'last push ' + item.pushed_at.slice(0, 10) : ''].filter(Boolean).join(' · '), source: 'github' }));
}

async function npmSearch(query, { fetchImpl, limit, signal }) {
  const data = await readJson('https://registry.npmjs.org/-/v1/search?' + new URLSearchParams({ text: query, size: String(limit) }), { signal }, { fetchImpl });
  return (data.objects || []).map(({ package: p }) => result({ title: p.name + '@' + p.version, url: p.links?.npm || 'https://www.npmjs.com/package/' + p.name,
    snippet: [p.description, p.date ? 'published ' + String(p.date).slice(0, 10) : ''].filter(Boolean).join(' · '), source: 'npm' }));
}

// Which keyless sources fit a query. Deterministic.
export function searchKinds(query, provider) {
  const kinds = [];
  if (provider) kinds.push(provider);
  if (/\b(?:github|repo(?:sitory)?|open[- ]source|library|sdk|package)\b/i.test(query)) kinds.push('github');
  if (/\b(?:npm|node(?:\.js)?|javascript|typescript|package)\b/i.test(query)) kinds.push('npm');
  if (!provider || /\b(?:what is|who is|history of|definition|explain)\b/i.test(query)) kinds.push('wikipedia');
  return [...new Set(kinds)];
}

// Search across the chosen sources in parallel. Failed sources are reported, never hidden.
export async function webSearch(query, { env = process.env, fetchImpl = fetch, limit = 5, kinds, store = null, signal } = {}) {
  const q = String(query || '').trim().slice(0, 300);
  if (!q) throw Object.assign(new Error('A search query is required.'), { status: 400 });
  const { provider, enabled } = webSettings(env);
  if (!enabled) return { query: q, results: [], failures: [{ source: 'web', error: 'Web research is off (INTEL_WEB=off).' }] };
  const chosen = kinds?.length ? kinds.filter(kind => kind !== 'searxng' || kind === provider) : searchKinds(q, provider);
  const fns = { searxng, wikipedia, github: githubSearch, npm: npmSearch };
  return cached(sha256(JSON.stringify(['s', q, chosen, limit])).slice(0, 32), 6 * 3600000, async () => {
    const settled = await Promise.allSettled(chosen.map(kind => fns[kind](q, { env, fetchImpl, limit, signal })));
    const seen = new Set(), results = [], failures = [];
    settled.forEach((outcome, index) => {
      if (outcome.status === 'rejected') failures.push({ source: chosen[index], error: clip(outcome.reason?.message || 'failed', 160) });
      else for (const item of outcome.value) if (!seen.has(item.url)) { seen.add(item.url); results.push(item); }
    });
    return { query: q, sources: chosen, results: results.slice(0, limit * 2), failures, retrievedAt: now() };
  }, store);
}

// Fetch one page and keep only the passages relevant to the question.
export async function readPage(url, { question = '', fetchImpl = fetch, resolve, maxPassages = 4, passageChars = 700, store = null, signal } = {}) {
  const page = await cached(sha256('p' + url).slice(0, 32), 6 * 3600000, () => fetchPage(url, { fetchImpl, resolve, signal }), store);
  const chunks = chunkText(page.text, { size: passageChars, maxChunks: 300 });
  const scores = question ? bm25(tokenize(question), chunks.map(chunk => tokenize(chunk.heading + ' ' + chunk.text))) : chunks.map((_, i) => -i);
  const passages = chunks.map((chunk, i) => ({ ...chunk, score: scores[i] })).sort((a, b) => b.score - a.score).slice(0, maxPassages)
    .map(chunk => ({ heading: chunk.heading, text: sanitizeUntrusted(chunk.text, passageChars), score: Number(chunk.score.toFixed(3)) }));
  return { url: page.url, finalUrl: page.finalUrl, title: page.title, retrievedAt: page.retrievedAt, contentType: page.contentType, truncated: page.truncated, passages };
}

// Search, then read the top pages within a budget. Findings are retrieved text, marked verified=false until a check confirms them.
export async function research(question, { env = process.env, fetchImpl = fetch, resolve, pages = 2, limit = 5, budgetMs = 6000, store = null } = {}) {
  const signal = AbortSignal.timeout(budgetMs);
  const search = await webSearch(question, { env, fetchImpl, limit, store, signal });
  const failures = [...search.failures];
  const readable = search.results.filter(item => !/\.(?:pdf|zip|png|jpe?g|gif|mp4)(?:$|\?)/i.test(item.url)).slice(0, pages);
  const read = await mapLimit(readable, 3, async item => {
    try { return await readPage(item.url, { question, fetchImpl, resolve, store, signal }); }
    catch (error) { failures.push({ source: item.url, error: clip(error.message, 160) }); return null; }
  });
  const findings = [];
  for (const page of read.filter(Boolean)) for (const passage of page.passages.slice(0, 2)) {
    findings.push({ text: passage.text, url: page.finalUrl, title: page.title, retrievedAt: page.retrievedAt, kind: 'retrieved', verified: false });
  }
  for (const item of search.results) if (!read.some(page => page?.finalUrl === item.url || page?.url === item.url)) {
    findings.push({ text: item.snippet, url: item.url, title: item.title, retrievedAt: item.retrievedAt, kind: 'snippet', verified: false });
  }
  return { question, results: search.results, findings: findings.slice(0, 10), failures, retrievedAt: now() };
}

// GitHub read-only: repo metadata, README, a directory listing or one file. Public repos, or private ones the token can read.
export async function githubRead(target, { env = process.env, fetchImpl = fetch, signal } = {}) {
  const match = /^(?:https:\/\/github\.com\/)?([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})(?:\/(?:blob|tree)\/([^/]+))?(?:\/(.*))?$/.exec(String(target || '').trim());
  if (!match) throw Object.assign(new Error('Use owner/repo or a github.com URL.'), { status: 400 });
  const [, owner, repo, ref, path = ''] = match;
  const base = 'https://api.github.com/repos/' + owner + '/' + repo.replace(/\.git$/, '');
  const headers = githubHeaders(env);
  const meta = await readJson(base, { signal, headers }, { fetchImpl });
  const query = ref ? '?ref=' + encodeURIComponent(ref) : '';
  const retrievedAt = now();
  if (!path) {
    let readme = '';
    try {
      const file = await readJson(base + '/readme' + query, { signal, headers }, { fetchImpl });
      readme = Buffer.from(file.content || '', 'base64').toString('utf8');
    } catch { /* no README */ }
    return { repo: meta.full_name, url: meta.html_url, description: meta.description, defaultBranch: meta.default_branch, language: meta.language,
      stars: meta.stargazers_count, pushedAt: meta.pushed_at, private: meta.private, readme: sanitizeUntrusted(readme, 6000), retrievedAt };
  }
  const item = await readJson(base + '/contents/' + path.split('/').map(encodeURIComponent).join('/') + query, { signal, headers }, { fetchImpl });
  if (Array.isArray(item)) return { repo: meta.full_name, path, url: meta.html_url + '/tree/' + (ref || meta.default_branch) + '/' + path, entries: item.slice(0, 200).map(e => ({ name: e.name, type: e.type, size: e.size })), retrievedAt };
  const content = item.encoding === 'base64' ? Buffer.from(item.content || '', 'base64').toString('utf8') : '';
  return { repo: meta.full_name, path, url: item.html_url, sha: item.sha, size: item.size, content: sanitizeUntrusted(content, 20000), retrievedAt };
}
