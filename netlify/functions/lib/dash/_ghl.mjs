const API = 'https://services.leadconnectorhq.com';
export async function ghl(path, { method = 'GET', version = 'v3', body, token = process.env.GHL_ACCESS_TOKEN, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  for (let attempt = 0; attempt < 4; attempt++) {
    let response;
    try {
      response = await fetchImpl(`${API}${path}`, {
        method, signal: AbortSignal.timeout(30000),
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}`, Version: version, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (error) {
      if (attempt === 3) throw error;
      await sleep(1000 * 2 ** attempt); continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      const retry = response.headers.get('retry-after');
      const wait = /^\d+$/.test(retry || '') ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      await response.text();
      await sleep(Math.min(30000, Math.max(1000 * 2 ** attempt, Number.isFinite(wait) ? wait : 0))); continue;
    }
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; } catch { throw new Error(`GHL returned invalid JSON for ${path.split('?')[0]}`); }
    if (!response.ok) {
      const error = new Error(typeof payload.message === 'string' ? payload.message : `GoHighLevel returned ${response.status}`);
      error.status = response.status; error.path = path.split('?')[0]; throw error;
    }
    return payload;
  }
}
export function rowsFrom(payload, field) {
  if (!Array.isArray(payload[field])) throw new Error(`GHL response missing ${field}; refusing to publish incomplete data.`);
  return payload[field];
}
