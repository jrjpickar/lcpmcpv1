// Embeddings for semantic retrieval, using providers the repo already configures. No new provider is added.
// INTEL_EMBEDDINGS=auto (default) | cloudflare | gemini | off
//   cloudflare: Workers AI @cf/baai/bge-small-en-v1.5 (384 dims) with CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_AI_TOKEN
//   gemini:     gemini-embedding-001 with outputDimensionality 256, GEMINI_API_KEY
// Without a provider, retrieval is keyword only (BM25). The model id is stored with every index so mixed vectors are never compared.
export const CF_EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
export const GEMINI_EMBED_MODEL = 'gemini-embedding-001';

export function embedSettings(env = process.env) {
  const choice = String(env.INTEL_EMBEDDINGS || 'auto').trim().toLowerCase();
  const cf = /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID?.trim() || '') && Boolean(env.CLOUDFLARE_AI_TOKEN?.trim());
  const gemini = Boolean(env.GEMINI_API_KEY?.trim());
  if (choice === 'off') return { provider: null, model: null };
  if ((choice === 'cloudflare' || choice === 'auto') && cf) return { provider: 'cloudflare', model: env.INTEL_CF_EMBED_MODEL?.trim() || CF_EMBED_MODEL };
  if ((choice === 'gemini' || choice === 'auto') && gemini) return { provider: 'gemini', model: env.INTEL_GEMINI_EMBED_MODEL?.trim() || GEMINI_EMBED_MODEL };
  return { provider: null, model: null };
}

const queryCache = new Map();

// Returns arrays of numbers aligned with texts, or null when no provider is configured. Throws on provider errors.
export async function embed(texts, { env = process.env, fetchImpl = fetch, timeoutMs = 8000, query = false } = {}) {
  const { provider, model } = embedSettings(env);
  if (!provider || !texts.length) return null;
  const key = query && texts.length === 1 ? model + '|' + texts[0] : null;
  if (key && queryCache.has(key)) return [queryCache.get(key)];
  const out = [];
  const batch = provider === 'cloudflare' ? 50 : 50;
  for (let start = 0; start < texts.length; start += batch) {
    const slice = texts.slice(start, start + batch).map(text => String(text).slice(0, 2000));
    if (provider === 'cloudflare') {
      const response = await fetchImpl('https://api.cloudflare.com/client/v4/accounts/' + env.CLOUDFLARE_ACCOUNT_ID.trim() + '/ai/run/' + model, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { authorization: 'Bearer ' + env.CLOUDFLARE_AI_TOKEN.trim(), 'content-type': 'application/json' },
        body: JSON.stringify({ text: slice }),
      });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('Workers AI embeddings HTTP ' + response.status), { status: response.status }); }
      const data = await response.json();
      const vectors = data?.result?.data;
      if (!Array.isArray(vectors) || vectors.length !== slice.length) throw new Error('Workers AI returned no embeddings.');
      out.push(...vectors);
    } else {
      const response = await fetchImpl('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':batchEmbedContents', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { 'x-goog-api-key': env.GEMINI_API_KEY.trim(), 'content-type': 'application/json' },
        body: JSON.stringify({ requests: slice.map(text => ({ model: 'models/' + model, content: { parts: [{ text }] },
          taskType: query ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: 256 })) }),
      });
      if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error('Gemini embeddings HTTP ' + response.status), { status: response.status }); }
      const data = await response.json();
      const vectors = (data?.embeddings || []).map(item => item.values);
      if (vectors.length !== slice.length) throw new Error('Gemini returned no embeddings.');
      out.push(...vectors);
    }
  }
  if (key) { queryCache.set(key, out[0]); if (queryCache.size > 100) queryCache.delete(queryCache.keys().next().value); }
  return out;
}
