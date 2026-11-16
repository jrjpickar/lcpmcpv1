import Metrics from '../../../public/lcp-metrics.js';
import Sample from '../../../public/sample-data.js';
import { loadData, sourceStatus } from './sources.mjs';
import { alertConfig } from './alerts.mjs';

// Shared by /api/metrics, /api/ask and /mcp.
export async function buildReport({ from, to, preset, rep } = {}) {
  const range = from && to ? { from, to } : Metrics.presetRange(preset || '30d');
  if (Metrics.shiftDay(range.from, 400) < range.to) throw Object.assign(new Error('Pick a range of at most 400 days.'), { status: 400 });
  const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86400000) + 1;
  const data = await loadData({ from: Metrics.shiftDay(range.from, -days), to: range.to }); // previous period too, for deltas
  const result = Metrics.compute(data, { ...range, rep: rep || '', compare: true, lookbackDays: Number(process.env.TOUCH_LOOKBACK_DAYS) || 60, alertConfig: alertConfig() });
  if (process.env.GHL_LOCATION_ID) result.links = { ghlContact: `${(process.env.GHL_APP_URL || 'https://app.gohighlevel.com').replace(/\/+$/, '')}/v2/location/${process.env.GHL_LOCATION_ID}/contacts/detail/` };
  if (data.meta?.mode === 'sample') result.ops = Sample.ops(); // 3D Brain is sandbox-only for now
  result.sources = { ...sourceStatus(), label: data.meta?.label || '', loadedAt: data.meta?.loadedAt || data.meta?.generatedAt || null, warnings: data.meta?.warnings || [] };
  return result;
}

export function paramsFrom(input = {}) {
  const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  return { from: day(input.from), to: day(input.to), preset: String(input.preset || ''), rep: String(input.rep || '').slice(0, 80) };
}
