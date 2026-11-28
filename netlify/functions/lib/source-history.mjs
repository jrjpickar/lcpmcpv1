// Keep up to 288 scheduled checks per source.
// Warnings count as failed checks. Skip sources that are off.
export const HISTORY_KEY = 'sources/history';
const MAX_SAMPLES = 288;

export function addSamples(history, sources, at) {
  const out = history && typeof history === 'object' ? history : {};
  for (const [name, source] of Object.entries(sources || {})) {
    if (source.status === 'off') continue;
    const list = Array.isArray(out[name]) ? out[name] : [];
    if (list.some(sample => sample[0] === at)) continue;
    list.push([at, source.status === 'ok' ? 1 : 0, Number.isFinite(source.elapsedMs) ? source.elapsedMs : null]);
    list.sort((a, b) => a[0].localeCompare(b[0]));
    out[name] = list.slice(-MAX_SAMPLES);
  }
  return out;
}

export function sourceState(samples, downAfter = 1, now = Date.now()) {
  if (!samples?.length) return null;
  const since = now - 24 * 3600000;
  const day = samples.filter(sample => Date.parse(sample[0]) >= since && Date.parse(sample[0]) <= now);
  if (!day.length) return null;
  let misses = 0;
  for (let i = day.length - 1; i >= 0 && day[i][1] === 0; i--) misses++;
  return {
    state: misses === 0 ? 'up' : misses >= Math.max(1, downAfter) ? 'down' : 'pending',
    misses,
    uptime24h: Math.round(day.reduce((total, sample) => total + sample[1], 0) / day.length * 1000) / 10,
    checks24h: day.length,
  };
}
