// Outbound HTTP for research: retrying JSON reads (ported from A2Z lib/http.mjs readJson) and a guarded page fetch.
// Page fetch rules: https only, no credentials in URLs, public IPs only (checked per redirect hop), 3 redirects,
// 1 MB cap, text content types only. Results carry the final URL and a retrieval timestamp.
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const retryPolicy = Object.freeze({ maxAttempts: 3, initialIntervalMs: 300, backoffCoefficient: 2, maximumIntervalMs: 2000, attemptTimeoutMs: 6000 });
const retryableStatus = status => status === 408 || status === 425 || status === 429 || status >= 500;
const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});
function retryDelay(response, attempt, policy) {
  const header = response?.headers?.get('retry-after');
  if (header) {
    const ms = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms)) return Math.min(policy.maximumIntervalMs, Math.max(0, ms));
  }
  return Math.min(policy.maximumIntervalMs, policy.initialIntervalMs * policy.backoffCoefficient ** (attempt - 1));
}

// GET retries on timeouts, 408, 425, 429 and 5xx. POST is tried once. The caller signal caps the whole call.
export async function readJson(url, options = {}, { policy = retryPolicy, fetchImpl = fetch } = {}) {
  const { signal: outer, ...init } = options;
  const attempts = (init.method || 'GET').toUpperCase() === 'GET' ? policy.maxAttempts : 1;
  for (let attempt = 1; ; attempt++) {
    const timeout = AbortSignal.timeout(policy.attemptTimeoutMs);
    const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;
    let response;
    try {
      response = await fetchImpl(url, { ...init, signal, redirect: 'error' });
    } catch (error) {
      if (outer?.aborted || attempt >= attempts) throw error;
      await pause(retryDelay(null, attempt, policy), outer);
      continue;
    }
    if (response.ok) return response.json();
    await response.body?.cancel().catch(() => {});
    if (attempt >= attempts || !retryableStatus(response.status)) throw Object.assign(new Error('Upstream HTTP ' + response.status), { status: response.status });
    await pause(retryDelay(response, attempt, policy), outer);
  }
}

// Private, loopback, link-local, CGNAT, multicast and reserved ranges are refused (SSRF guard).
export function privateAddress(address) {
  const kind = isIP(address);
  if (kind === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (kind === 6) {
    const v = address.toLowerCase();
    if (v === '::' || v === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return privateAddress(mapped[1]);
    return /^(?:fc|fd|fe8|fe9|fea|feb|ff)/.test(v) || v.startsWith('64:ff9b:') || v.startsWith('2001:db8');
  }
  return true;
}

export async function checkPublicUrl(raw, { resolve = lookup } = {}) {
  const url = URL.parse(String(raw || ''));
  if (!url || url.protocol !== 'https:') throw Object.assign(new Error('Only https URLs can be fetched.'), { status: 400 });
  if (url.username || url.password) throw Object.assign(new Error('URLs with credentials are refused.'), { status: 400 });
  if (url.port && url.port !== '443') throw Object.assign(new Error('Only the default https port is allowed.'), { status: 400 });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (/^(?:localhost|.*\.local|.*\.internal|metadata\.google\.internal)$/i.test(host)) throw Object.assign(new Error('Internal hosts are refused.'), { status: 400 });
  const addresses = isIP(host) ? [{ address: host }] : await resolve(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(entry => privateAddress(entry.address))) throw Object.assign(new Error('The host resolves to a private address.'), { status: 400 });
  return url;
}

const entities = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', hellip: '...', copy: '(c)', rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };
export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, code) => {
    if (code[0] === '#') { const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ' '; }
    return entities[code.toLowerCase()] ?? match;
  });
}

// HTML to readable text: drops scripts, styles, navigation and forms; keeps headings, paragraphs, lists, code and tables as lines.
export function htmlToText(html) {
  const source = String(html || '');
  const title = decodeEntities((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(source)?.[1] || '').replace(/\s+/g, ' ').trim()).slice(0, 200);
  const main = /<(main|article)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(source)?.[2] || /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(source)?.[1] || source;
  let text = main
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header|form|iframe|template|aside)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])\b[^>]*>/gi, (m, n) => '\n\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<\/(h[1-6]|p|div|section|tr|li|pre|blockquote|table|ul|ol|dd|dt)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ').replace(/<br\s*\/?>/gi, '\n').replace(/<t[dh]\b[^>]*>/gi, ' | ')
    .replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text).replace(/[ \t\f\v]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
}

const textTypes = /^(?:text\/(?:html|plain|markdown|csv|xml)|application\/(?:json|xml|xhtml\+xml|rss\+xml|atom\+xml|x-ndjson))\b/i;

export async function fetchPage(raw, { fetchImpl = fetch, resolve = lookup, maxBytes = 1048576, timeoutMs = 6000, signal } = {}) {
  let url = await checkPublicUrl(raw, { resolve });
  const deadline = AbortSignal.timeout(timeoutMs);
  const stop = signal ? AbortSignal.any([signal, deadline]) : deadline;
  for (let hop = 0; hop <= 3; hop++) {
    const response = await fetchImpl(url, { redirect: 'manual', signal: stop,
      headers: { 'user-agent': 'LCP-JARVIS-Research/1.0 (+read-only)', accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.1' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => {});
      if (hop === 3) throw Object.assign(new Error('Too many redirects.'), { status: 502 });
      url = await checkPublicUrl(new URL(response.headers.get('location') || '', url).href, { resolve });
      continue;
    }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw Object.assign(new Error('Page returned HTTP ' + response.status), { status: response.status }); }
    const type = response.headers.get('content-type') || 'text/html';
    if (!textTypes.test(type)) { await response.body?.cancel().catch(() => {}); throw Object.assign(new Error('Unsupported content type: ' + type.split(';')[0]), { status: 415 }); }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let size = 0, body = '', truncated = false;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { truncated = true; await reader.cancel().catch(() => {}); break; }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
    const isHtml = /html|xml/i.test(type);
    const { title, text } = isHtml ? htmlToText(body) : { title: '', text: body };
    return { url: String(raw), finalUrl: url.href, title: title || url.hostname + url.pathname, text, contentType: type.split(';')[0], bytes: size, truncated, retrievedAt: new Date().toISOString() };
  }
  throw Object.assign(new Error('Too many redirects.'), { status: 502 });
}
