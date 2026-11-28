// Uses the existing Groq key and call budget for both models.
import { setTimeout as delay } from 'node:timers/promises';
import { DEFAULT_MODEL } from './groq.mjs';

const transient = new Set([429, 502, 503, 504]);

function cooldown(response, now) {
  const header = response?.headers.get('retry-after');
  const wait = /^\d+(?:\.\d+)?$/.test(header || '') ? Number(header) * 1000 : Date.parse(header) - now;
  return Math.min(86400000, Math.max(30000, Number.isFinite(wait) ? wait : 0));
}

export function createGroqFailover({ env, fetchImpl, timeoutMs, now = Date.now, wait = delay }) {
  const primary = env.JARVIS_GROQ_MODEL?.trim() || DEFAULT_MODEL;
  const backup = primary === DEFAULT_MODEL ? 'openai/gpt-oss-120b' : DEFAULT_MODEL;
  let retryAt = 0;
  let probing = false;
  let active = null;
  let lastFailure = null;
  const events = [];

  function record(type, model, status = null) {
    events.unshift({ type, model, status, at: new Date(now()).toISOString() });
    if (events.length > 30) events.pop();
  }

  const request = (url, init, model, budget) => {
    const body = { ...JSON.parse(init.body), model };
    if (!model.startsWith('openai/gpt-oss-')) delete body.reasoning_effort;
    const timeout = AbortSignal.timeout(budget);
    return fetchImpl(url, {
      ...init,
      body: JSON.stringify(body),
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };

  return {
    primary,
    status: () => ({
      primary, backup, active, lastFailure,
      retryAt: retryAt > now() ? new Date(retryAt).toISOString() : null,
      events: events.slice(),
    }),
    async fetch(url, init) {
      const started = now();
      const primaryBudget = Math.floor(timeoutMs * 0.6);
      init.signal?.throwIfAborted();
      if (started >= retryAt && !probing) {
        const probe = retryAt !== 0;
        if (probe) {
          probing = true;
          record('probe', primary);
        }
        try {
          let response;
          try {
            response = await request(url, init, primary, primaryBudget);
            const remaining = primaryBudget - (now() - started);
            if (!probe && transient.has(response.status) && response.status !== 429 &&
              !response.headers.has('retry-after') && remaining >= 1200) {
              record('retry', primary, response.status);
              void response.body?.cancel().catch(() => {});
              response = undefined;
              await wait(300, undefined, { signal: init.signal });
              response = await request(url, init, primary, Math.max(1, primaryBudget - (now() - started)));
            }
          } catch (error) {
            if (init.signal?.aborted) throw error;
          }
          if (response && !transient.has(response.status)) {
            if (response.ok) {
              active = primary;
              if (probe) record('recovery', primary);
              retryAt = 0;
            } else if (probe) {
              retryAt = 0;
            }
            return response;
          }
          retryAt = now() + cooldown(response, now());
          lastFailure = { at: new Date(now()).toISOString(), status: response?.status ?? null };
          record('failure', primary, lastFailure.status);
          void response?.body?.cancel().catch(() => {});
        } finally {
          if (probe) probing = false;
        }
      }
      init.signal?.throwIfAborted();
      record('failover', backup);
      try {
        const response = await request(url, init, backup, Math.max(1, timeoutMs - (now() - started)));
        if (response.ok) active = backup;
        else record('failure', backup, response.status);
        return response;
      } catch (error) {
        if (!init.signal?.aborted) record('failure', backup);
        throw error;
      }
    },
  };
}
