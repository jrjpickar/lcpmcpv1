// Read side of the dashboard data sync: the small derived snapshot the reports, MCP tools, JARVIS and the city read.
// Live: the last finished sync (Netlify Blobs "lcp-dash", or the VM file store). Sample: built from dash-sample.
import { derive, WINDOWS } from './dash-derived.mjs';
import { generateDashSample } from './dash-sample.mjs';
import { dashStore, syncConfigured } from './dash-sync.mjs';

let memo = null;
let sample = null;
let storeOverride = null;
export const setDashStore = store => { storeOverride = store; memo = null; };

export async function dashDerived({ env = process.env, now = Date.now(), store } = {}) {
  if (!syncConfigured(env)) {
    if (!sample || now - sample.at > 3600000) sample = { at: now, data: { ...derive(generateDashSample({ now }), {}, now), meta: { mode: 'sample', refreshedAt: new Date(now).toISOString(), warnings: [] } } };
    return sample.data;
  }
  if (memo && now - memo.at < 60000) return memo.data;
  const s = store || storeOverride || dashStore();
  const data = await s.get('dash/derived', { type: 'json' });
  const state = await s.get('dash/state', { type: 'json' }).catch(() => null);
  const result = data
    ? { ...data, sync: syncInfo(state) }
    : { empty: true, meta: { mode: 'live', warnings: ['No dashboard sync has finished yet. The first full sync runs at the next scheduled slot, or POST /api/dash-sync with the admin key.'] }, sync: syncInfo(state) };
  memo = { at: now, data: result };
  return result;
}

const syncInfo = state => (state?.run ? { runId: state.run.id, full: state.run.full, startedAt: state.run.startedAt, finishedAt: state.run.finishedAt || null,
  running: !state.run.done, phase: state.run.done ? null : state.run.phase, warnings: state.run.warnings || [] } : null);

export const windowName = w => (WINDOWS.includes(w) ? w : '30d');
export const ageMinutes = (d, now = Date.now()) => (d?.meta?.refreshedAt ? Math.round((now - Date.parse(d.meta.refreshedAt)) / 60000) : null);
