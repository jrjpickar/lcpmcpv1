import { safeEqual, dashboardAuthorized, json } from './auth.mjs';
import { initialConfig, validateConfig } from '../../../public/studio-schema.mjs';

const layoutKey = 'layout-v1';
const historyLimit = 20;
const bodyLimit = 131072;

export async function readBody(request, limit = bodyLimit) {
  const reader = request.body?.getReader();
  if (!reader) throw new TypeError('A JSON body is required.');
  const decoder = new TextDecoder();
  let size = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new TypeError('Request body exceeds the size limit.');
      }
      body += decoder.decode(value, { stream: true });
    }
    return JSON.parse(body + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

function adminView(state) {
  return {
    revision: state.revision,
    draft: state.draft,
    published: state.published,
    history: state.history.map(({ version, action, at }) => ({ version, action, at })),
  };
}

export function studioAuthorized(request, expected = process.env.LCP_STUDIO_KEY) {
  return Boolean(expected && expected.length >= 24 && safeEqual(request.headers.get('x-lcp-studio-key'), expected));
}

export function createStudioHandler(openStore, adminKey = () => process.env.LCP_STUDIO_KEY) {
  return async function studio(request) {
    const url = new URL(request.url);
    const admin = url.searchParams.get('admin') === '1';
    const headers = { allow: 'GET, POST' };
    if (request.method !== 'GET' && request.method !== 'POST') return json({ error: 'Method not allowed' }, 405, headers);
    if (admin || request.method === 'POST') {
      const expected = adminKey();
      if (!studioAuthorized(request, expected)) {
        return json({ error: 'Administrator key rejected.' }, 401);
      }
    } else if (!dashboardAuthorized(request)) {
      return json({ error: 'Unauthorized' }, 401);
    }
    let command;
    if (request.method === 'POST') {
      if (request.headers.get('origin') !== url.origin) return json({ error: 'Origin rejected.' }, 403);
      if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') return json({ error: 'Expected JSON.' }, 415);
      try {
        command = await readBody(request);
        if (!Number.isSafeInteger(command?.revision) || !['save', 'publish', 'rollback'].includes(command.action)) {
          return json({ error: 'Invalid revision or action.' }, 400);
        }
        if (command.action === 'save') validateConfig(command.config);
      } catch (error) {
        return json({ error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message }, 400);
      }
    }
    try {
      const store = await openStore();
      const entry = await store.getWithMetadata(layoutKey, { type: 'json' });
      const state = entry?.data ?? { revision: 0, draft: null, published: initialConfig(), history: [] };
      if (!command) return json(admin ? adminView(state) : { published: state.published });
      if (command.revision !== state.revision) return json({ error: 'Layout changed. Reload before saving.' }, 409);

      if (command.action === 'save') {
        state.draft = command.config;
      } else {
        const target = command.action === 'publish'
          ? state.draft
          : state.history.find(release => release.version === command.version)?.config;
        if (!target) return json({ error: 'No saved draft or selected release found.' }, 409);
        validateConfig(target);
        if (!state.history.length) {
          state.history.push({ version: 0, action: 'baseline', at: null, config: state.published });
        }
        state.published = target;
        if (command.action === 'publish') state.draft = null;
        state.history.unshift({ version: state.revision + 1, action: command.action, at: new Date().toISOString(), config: target });
        state.history.length = Math.min(state.history.length, historyLimit);
      }
      state.revision += 1;
      const saved = await store.setJSON(layoutKey, state, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
      if (!saved.modified) return json({ error: 'Layout changed. Reload before saving.' }, 409);
      return json(adminView(state));
    } catch {
      return json({ error: 'Studio storage is unavailable.' }, 503);
    }
  };
}
