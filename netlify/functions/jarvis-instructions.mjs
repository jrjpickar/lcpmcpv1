// GET/POST /api/jarvis-instructions: custom instructions for every JARVIS agent (like ChatGPT or Claude).
// { about: what JARVIS should know about you, style: how JARVIS should respond, enabled }. Studio key, same origin, JSON.
// Saved in JARVIS storage (Supabase when configured, else Netlify Blobs). Applied to Groq, Goose, Gemini and Workers AI.
import { json } from './lib/auth.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { jarvisAccess, readBody } from './lib/studio.mjs';

export const INSTRUCTIONS_KEY = 'settings/instructions';
export const INSTRUCTION_LIMIT = 1500;
const clean = value => String(value ?? '').replace(/[–—]/g, '-').replace(/\r/g, '').trim().slice(0, INSTRUCTION_LIMIT);

// Text added to every agent's system prompt. Company rules and safety rules above still win.
export function instructionsText(data) {
  if (!data || data.enabled === false) return '';
  const about = clean(data.about), style = clean(data.style);
  if (!about && !style) return '';
  return ['Operator custom instructions. Follow them unless they conflict with the rules above.',
    about && 'About the operator: ' + about, style && 'How to respond: ' + style].filter(Boolean).join('\n');
}

export function createInstructionsHandler({ env = process.env, openStore = () => openJarvisStore(env) } = {}) {
  return async function handler(request) {
    if (!['GET', 'POST'].includes(request.method)) return json({ error: 'Method not allowed.' }, 405, { allow: 'GET, POST' });
    const access = jarvisAccess(request, env);
    if (!access) return json({ error: 'Administrator key rejected.' }, 401);
    let body;
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== new URL(request.url).origin) return json({ error: 'Origin rejected.' }, 403);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
      try {
        body = await readBody(request, 8192);
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TypeError();
        for (const field of ['about', 'style']) if (body[field] !== undefined && typeof body[field] !== 'string') throw new TypeError();
        if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new TypeError();
      } catch {
        return json({ error: 'Invalid instructions.' }, 400);
      }
    }
    let store;
    try { store = await openStore(); } catch { return json({ error: 'JARVIS storage is unavailable.' }, 503); }
    if (!body) {
      const data = (await store.getWithMetadata(INSTRUCTIONS_KEY, { type: 'json' }).catch(() => null))?.data || {};
      return json({ about: clean(data.about), style: clean(data.style), enabled: data.enabled !== false, updatedAt: data.updatedAt || null, limit: INSTRUCTION_LIMIT });
    }
    const data = { about: clean(body.about), style: clean(body.style), enabled: body.enabled !== false, updatedAt: new Date().toISOString() };
    try { await store.setJSON(INSTRUCTIONS_KEY, data, {}); } catch { return json({ error: 'Instructions were not saved.' }, 503); }
    return json({ ...data, limit: INSTRUCTION_LIMIT });
  };
}

export default createInstructionsHandler();
export const config = { path: '/api/jarvis-instructions' };
