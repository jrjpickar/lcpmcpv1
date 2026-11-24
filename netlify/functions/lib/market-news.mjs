// Niche market news for LCP marketing decisions (LA County distressed-property wholesaling).
// Source: self-hosted SearXNG news category when SEARXNG_URL is set, else Google News RSS search. Read only.
// Headlines are untrusted text: titles and links only, no page bodies. Cached 6 hours.
import { XMLParser } from 'fast-xml-parser';
import { searxngBase } from './intel/web.mjs';

// Each topic says which marketing lever it informs, so a headline can be read against the yield report.
export const DEFAULT_TOPICS = [
  { topic: 'Los Angeles County foreclosure filings', lever: 'Pre-foreclosure lists: more notices of default means more fresh pre-foreclosure records to pull.' },
  { topic: 'Los Angeles County property tax delinquent', lever: 'Tax delinquent lists: changes to the tax-defaulted sale schedule or penalties shift seller urgency.' },
  { topic: 'Los Angeles code enforcement violations housing', lever: 'Code violation lists: enforcement sweeps create new motivated owners in the affected areas.' },
  { topic: 'California probate real estate', lever: 'Probate lists: rule or court backlog changes affect timeline to sell inherited homes.' },
  { topic: 'California real estate wholesaling law', lever: 'Compliance: wholesaling disclosure or licensing rules change how offers and assignments are worded.' },
  { topic: 'Los Angeles rent control landlord law', lever: 'Tired landlord lists: new tenant protections push small landlords to sell.' },
  { topic: 'Southern California home prices inventory', lever: 'Pricing: rising inventory and slower sales lower offer prices and lift seller motivation.' },
  { topic: 'mortgage rates this week', lever: 'Buyer side: rate moves change end-buyer demand and assignment spreads.' },
];

export function topicsFrom(env = process.env) {
  const raw = String(env.MARKET_NEWS_TOPICS || '').trim();
  if (!raw) return DEFAULT_TOPICS;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(t => (typeof t === 'string' ? { topic: t, lever: '' } : { topic: String(t.topic || ''), lever: String(t.lever || '') })).filter(t => t.topic).slice(0, 12);
  } catch { /* plain list */ }
  return raw.split('|').map(t => ({ topic: t.trim(), lever: '' })).filter(t => t.topic).slice(0, 12);
}

const clean = s => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 220);
const okUrl = u => /^https:\/\/[^\s]+$/.test(String(u || ''));

async function searx(topic, { env, fetchImpl, limit }) {
  const params = new URLSearchParams({ q: topic, format: 'json', categories: 'news', time_range: 'month', language: 'en' });
  const headers = { accept: 'application/json', ...(env.SEARXNG_TOKEN?.trim() ? { authorization: 'Bearer ' + env.SEARXNG_TOKEN.trim() } : {}) };
  const res = await fetchImpl(searxngBase(env) + '/search?' + params, { headers, signal: AbortSignal.timeout(8000), redirect: 'error' });
  if (!res.ok) throw new Error('SearXNG HTTP ' + res.status);
  const data = await res.json();
  return (data.results || []).filter(r => okUrl(r.url)).slice(0, limit)
    .map(r => ({ title: clean(r.title), url: r.url, source: clean(r.engine || new URL(r.url).host), publishedAt: r.publishedDate ? new Date(r.publishedDate).toISOString() : null }));
}

async function googleNews(topic, { fetchImpl, limit }) {
  const url = 'https://news.google.com/rss/search?' + new URLSearchParams({ q: topic + ' when:30d', hl: 'en-US', gl: 'US', ceid: 'US:en' });
  const res = await fetchImpl(url, { headers: { accept: 'application/rss+xml, application/xml' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Google News HTTP ' + res.status);
  const text = (await res.text()).slice(0, 500000);
  const items = new XMLParser({ ignoreAttributes: false, processEntities: true }).parse(text)?.rss?.channel?.item || [];
  return (Array.isArray(items) ? items : [items]).filter(i => okUrl(i.link)).slice(0, limit)
    .map(i => ({ title: clean(i.title), url: i.link, source: clean(typeof i.source === 'object' ? i.source['#text'] : i.source), publishedAt: i.pubDate ? new Date(i.pubDate).toISOString() : null }));
}

const SAMPLE = topic => [{ title: `Sample headline about ${topic.toLowerCase()}`, url: 'https://example.com/sample', source: 'sample', publishedAt: null }];
const memo = new Map();

export async function marketNews({ env = process.env, fetchImpl = fetch, limit = 4, topics, store = null, now = Date.now() } = {}) {
  const list = topics?.length ? topics.map(t => (typeof t === 'string' ? { topic: t, lever: '' } : t)) : topicsFrom(env);
  const key = 'market-news/' + Buffer.from(JSON.stringify([list.map(t => t.topic), limit])).toString('base64url').slice(0, 80);
  const hit = memo.get(key) || (store ? await store.get(key, { type: 'json' }).catch(() => null) : null);
  if (hit && now - Date.parse(hit.retrievedAt) < 6 * 3600000) return hit;
  const sample = env.DATA_MODE === 'sample' || env.MARKET_NEWS === 'off';
  const provider = sample ? 'sample' : searxngBase(env) ? 'searxng' : 'google-news-rss';
  const failures = [];
  const groups = await Promise.all(list.map(async t => {
    try {
      const items = sample ? SAMPLE(t.topic) : provider === 'searxng' ? await searx(t.topic, { env, fetchImpl, limit }) : await googleNews(t.topic, { fetchImpl, limit });
      return { topic: t.topic, lever: t.lever, items };
    } catch (error) {
      failures.push({ topic: t.topic, error: String(error.message).slice(0, 120) });
      return { topic: t.topic, lever: t.lever, items: [] };
    }
  }));
  const out = { provider, retrievedAt: new Date(now).toISOString(), note: 'Headlines are external, unverified text. Read the article before acting.', topics: groups, failures };
  memo.set(key, out);
  if (store && !sample) await store.setJSON(key, out).catch(() => {});
  return out;
}
