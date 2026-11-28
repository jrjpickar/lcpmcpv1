// Retry policy for upstream reads (shape from Temporal RetryPolicy, limits from n8n retryOnFail).
// GET only. Each try has its own timeout. The caller signal caps the whole call, retries included.
export const retryPolicy = Object.freeze({ maxAttempts: 3, initialIntervalMs: 300, backoffCoefficient: 2, maximumIntervalMs: 2000, attemptTimeoutMs: 7500 });
const retryableStatus = status => status === 408 || status === 425 || status === 429 || status >= 500;

function retryDelay(response, attempt, policy) {
  const header = response?.headers?.get('retry-after');
  if (header) {
    const seconds = /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(seconds)) return Math.min(policy.maximumIntervalMs, Math.max(0, seconds));
  }
  return Math.min(policy.maximumIntervalMs, policy.initialIntervalMs * policy.backoffCoefficient ** (attempt - 1));
}

function pause(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener('abort', stop, { once: true });
  });
}

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
      // Stop when the caller's budget ran out. Retry a timed out or failed connection while tries remain.
      if (outer?.aborted || attempt >= attempts) throw error;
      await pause(retryDelay(null, attempt, policy), outer);
      continue;
    }
    if (response.ok) return response.json();
    await response.body?.cancel().catch(() => {});
    if (attempt >= attempts || !retryableStatus(response.status)) throw Object.assign(new Error('Upstream HTTP ' + response.status), { upstreamStatus: response.status });
    await pause(retryDelay(response, attempt, policy), outer);
  }
}
