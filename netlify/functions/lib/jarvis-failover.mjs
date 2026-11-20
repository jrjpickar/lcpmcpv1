// Uses the existing Groq key and call budget for both models.
import { DEFAULT_MODEL } from './groq.mjs';

const transient = new Set([429, 502, 503, 504]);

export function createGroqFailover({ env, fetchImpl, timeoutMs, now = Date.now }) {
  const primary = env.JARVIS_GROQ_MODEL?.trim() || DEFAULT_MODEL;
  const backup = primary === DEFAULT_MODEL ? 'openai/gpt-oss-120b' : DEFAULT_MODEL;
  let retryAt = 0;
  let active = null;
  let lastFailure = null;

  const request = (url, init, model, budget) => {
    const body = { ...JSON.parse(init.body), model };
    if (!model.startsWith('openai/gpt-oss-')) delete body.reasoning_effort;
    return fetchImpl(url, {
      ...init,
      body: JSON.stringify(body),
      signal: AbortSignal.any([init.signal, AbortSignal.timeout(budget)]),
    });
  };

  return {
    primary,
    status: () => ({ primary, backup, active, lastFailure, retryAt: retryAt > now() ? new Date(retryAt).toISOString() : null }),
    async fetch(url, init) {
      const started = now();
      if (started >= retryAt) {
        let response;
        try {
          response = await request(url, init, primary, Math.floor(timeoutMs * 0.6));
        } catch (error) {
          if (init.signal.aborted) throw error;
        }
        if (response && !transient.has(response.status)) {
          if (response.ok) {
            active = primary;
            retryAt = 0;
          }
          return response;
        }
        const header = response?.headers.get('retry-after');
        const delay = /^\d+(?:\.\d+)?$/.test(header || '') ? Number(header) * 1000 : Date.parse(header) - now();
        retryAt = now() + Math.min(86400000, Math.max(30000, Number.isFinite(delay) ? delay : 0));
        lastFailure = { at: new Date(now()).toISOString(), status: response?.status ?? null };
        void response?.body?.cancel().catch(() => {});
      }
      const response = await request(url, init, backup, Math.max(1, timeoutMs - (now() - started)));
      if (response.ok) active = backup;
      return response;
    },
  };
}
