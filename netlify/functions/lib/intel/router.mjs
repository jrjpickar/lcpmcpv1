// Capability-based model routing over the providers the repo already uses (Groq, Gemini, Workers AI).
// Deterministic: a regex classifier picks the task class, a route table picks an ordered provider list,
// configured and healthy providers are tried in order. 429 and 5xx open a per-model cooldown (circuit) shared through storage.
// INTEL_ROUTES (JSON) can override any class: {"coding":["groq:openai/gpt-oss-120b","gemini:gemini-3.1-flash-lite"]}.
import { DEFAULT_MODEL } from '../groq.mjs';
import { CLOUDFLARE_MODEL, GEMINI_MODEL, cloudflareModel, geminiModel, groqModel, modelTimeout } from '../jarvis-agents.mjs';
import { update } from '../jarvis-memory.mjs';

export const CLASSES = ['research', 'coding', 'debugging', 'data', 'operations', 'planning', 'verification', 'general'];
const patterns = [
  ['debugging', /\b(?:bug|error|exception|stack ?trace|fails?|failing|broken|crash(?:es|ed)?|root cause|debug|why (?:does|is) .{0,40}(?:not|n't))\b/i],
  ['coding', /\b(?:code|function|refactor|implement|patch|endpoint|api route|unit tests?|typescript|javascript|python|sql|regex|module|repo(?:sitory)?|pull request|diff)\b/i],
  ['research', /\b(?:research|latest|news|docs?|documentation|look up|search (?:the )?web|github|library|compare (?:tools|options|vendors)|best practices?|what is|how does)\b/i],
  ['data', /\b(?:kpis?|metrics?|dials?|connect rate|conversion|opportunit(?:y|ies)|qualified|trend|average|median|per rep|breakdown|compare (?:this|last)|numbers)\b/i],
  ['operations', /\b(?:ghl|highlevel|twilio|workflow|make\.com|netlify|slack|deploy(?:ment)?|campaign|dialer|sms|pipeline|automation|integration)\b/i],
  ['planning', /\b(?:plan|roadmap|strategy|steps to|prioriti[sz]e|milestones?|approach|architecture)\b/i],
];
export function classify(text) {
  for (const [name, pattern] of patterns) if (pattern.test(String(text || ''))) return name;
  return 'general';
}

const defaults = env => {
  const small = env.JARVIS_GROQ_MODEL?.trim() || DEFAULT_MODEL;
  const large = env.INTEL_GROQ_LARGE_MODEL?.trim() || 'openai/gpt-oss-120b';
  const gemini = env.GEMINI_MODEL?.trim() || GEMINI_MODEL;
  const cf = env.CLOUDFLARE_AI_MODEL?.trim() || CLOUDFLARE_MODEL;
  return {
    research: ['groq:' + small, 'gemini:' + gemini, 'cloudflare:' + cf],
    coding: ['groq:' + large, 'gemini:' + gemini, 'groq:' + small],
    debugging: ['groq:' + large, 'gemini:' + gemini, 'groq:' + small],
    data: ['groq:' + small, 'gemini:' + gemini, 'groq:' + large],
    operations: ['groq:' + small, 'gemini:' + gemini, 'cloudflare:' + cf],
    planning: ['groq:' + large, 'gemini:' + gemini, 'groq:' + small],
    // Verification prefers a different provider than the usual producer (Groq) for independence.
    verification: ['gemini:' + gemini, 'cloudflare:' + cf, 'groq:' + large],
    general: ['groq:' + small, 'gemini:' + gemini, 'cloudflare:' + cf],
  };
};

export function routeTable(env = process.env) {
  const table = defaults(env);
  try {
    const custom = JSON.parse(env.INTEL_ROUTES || '{}');
    for (const [name, list] of Object.entries(custom)) {
      if (CLASSES.includes(name) && Array.isArray(list) && list.every(item => /^(?:groq|gemini|cloudflare):[\w@./:-]{1,100}$/.test(item))) table[name] = list;
    }
  } catch { /* a broken INTEL_ROUTES keeps the defaults */ }
  return table;
}

export function providers(env = process.env) {
  return {
    groq: { configured: Boolean(env.GROQ_API_KEY?.trim()), note: 'GROQ_API_KEY' },
    gemini: { configured: Boolean(env.GEMINI_API_KEY?.trim()), note: 'GEMINI_API_KEY' },
    cloudflare: { configured: /^[a-f0-9]{32}$/i.test(env.CLOUDFLARE_ACCOUNT_ID?.trim() || '') && Boolean(env.CLOUDFLARE_AI_TOKEN?.trim()), note: 'CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_AI_TOKEN' },
  };
}

export const CIRCUIT_KEY = 'router/circuit';
const sharedCircuit = new Map(); // per warm process; also persisted to storage

export function createRouter({ env = process.env, fetchImpl = fetch, store = null, now = Date.now, timeoutMs = modelTimeout(env), circuit = sharedCircuit } = {}) {
  const configured = providers(env);
  let hydrated = false;
  async function hydrate() {
    if (hydrated || !store) return;
    hydrated = true;
    try {
      const data = (await store.getWithMetadata(CIRCUIT_KEY, { type: 'json' }))?.data || {};
      for (const [id, until] of Object.entries(data)) if (until > now() && !(circuit.get(id) > until)) circuit.set(id, until);
    } catch { /* routing works without shared state */ }
  }
  async function trip(id, ms) {
    const until = now() + ms;
    circuit.set(id, until);
    if (store) await update(store, CIRCUIT_KEY, () => ({}), data => { for (const k of Object.keys(data)) if (data[k] < now()) delete data[k]; data[id] = until; }).catch(() => {});
  }
  const caller = (id, usage) => {
    const [provider, ...rest] = id.split(':');
    const model = rest.join(':');
    if (provider === 'groq') return groqModel(env.GROQ_API_KEY.trim(), fetchImpl, { model, usage, timeoutMs });
    if (provider === 'gemini') return geminiModel(env.GEMINI_API_KEY.trim(), fetchImpl, { model, usage, timeoutMs });
    return cloudflareModel(env.CLOUDFLARE_ACCOUNT_ID.trim(), env.CLOUDFLARE_AI_TOKEN.trim(), fetchImpl, { model, usage, timeoutMs });
  };

  function candidates(taskClass, { exclude = [] } = {}) {
    const list = routeTable(env)[taskClass] || routeTable(env).general;
    return [...new Set(list)].filter(id => configured[id.split(':')[0]]?.configured && !exclude.includes(id));
  }

  // Call the first healthy candidate. Same call shape as groqModel: (instruction, context, structured, guidance).
  // Returns { output, model, attempts }. Throws with every attempt listed when all fail.
  async function call(taskClass, instruction, context, { structured = false, guidance = null, usage = { total: 0, calls: 0 }, exclude = [], deadline = now() + 3 * timeoutMs } = {}) {
    await hydrate();
    const list = candidates(taskClass, { exclude });
    if (!list.length) throw Object.assign(new Error('No model provider is configured for ' + taskClass + '. Set GROQ_API_KEY, GEMINI_API_KEY or Workers AI.'), { agentStatus: 503 });
    const attempts = [];
    for (const id of list) {
      if ((circuit.get(id) || 0) > now()) { attempts.push({ model: id, skipped: 'cooling down' }); continue; }
      if (now() >= deadline) { attempts.push({ model: id, skipped: 'deadline' }); break; }
      const started = now();
      try {
        const output = await caller(id, usage)(instruction, context, structured, guidance);
        attempts.push({ model: id, ok: true, ms: now() - started });
        return { output, model: id, attempts };
      } catch (error) {
        const status = error.agentStatus || 0;
        const timeout = error.name === 'TimeoutError' || error.name === 'AbortError';
        attempts.push({ model: id, ok: false, ms: now() - started, error: timeout ? 'timed out' : String(error.message || 'failed').slice(0, 160) });
        // Rate limits and provider outages cool the model down; a bad response does not.
        if (status === 429) await trip(id, 60000);
        else if (timeout || /HTTP 5\d\d/.test(error.message || '')) await trip(id, 30000);
      }
    }
    const error = Object.assign(new Error('All model providers failed: ' + attempts.map(a => a.model + ' ' + (a.error || a.skipped)).join('; ')), { agentStatus: 502, attempts });
    throw error;
  }

  function status() {
    const t = now();
    return { providers: configured, routes: routeTable(env), cooling: Object.fromEntries([...circuit].filter(([, until]) => until > t).map(([id, until]) => [id, new Date(until).toISOString()])) };
  }

  return { call, candidates, status, classify };
}
