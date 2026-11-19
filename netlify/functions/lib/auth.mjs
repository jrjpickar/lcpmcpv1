import { timingSafeEqual, createHash } from 'node:crypto';
import { mode } from './sources.mjs';
import { activityIsSample } from './activity.mjs';

const digest = s => createHash('sha256').update(String(s)).digest();
export const safeEqual = (a, b) => Boolean(a) && Boolean(b) && timingSafeEqual(digest(a), digest(b));

// Dashboard + /api/ask: x-lcp-key header (the page reads it from #key= in the GHL Custom Page URL),
// Returns { admin, mailbox } or null.
// Sample mode needs no key. Live mode with no DASHBOARD_KEY set fails closed.
export function dashboardAccess(request, sample = mode() === 'sample', env = process.env) {
  if (sample) return { admin: true, mailbox: true };
  const expected = env.DASHBOARD_KEY || '';
  if (expected.length < 16) return null;
  return safeEqual(request.headers.get('x-lcp-key') || '', expected) ? { admin: true, mailbox: true } : null;
}
export function dashboardAuthorized(request, sample = mode() === 'sample') {
  return Boolean(dashboardAccess(request, sample));
}

// /mcp: Authorization: Bearer MCP_KEY (falls back to DASHBOARD_KEY).
export function mcpAuthorized(request) {
  const expected = process.env.MCP_KEY || process.env.DASHBOARD_KEY || '';
  if (mode() === 'sample' && activityIsSample() && !expected) return true;
  if (expected.length < 16) return false;
  const token = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  return safeEqual(token, expected);
}

export const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, no-store', ...headers },
});
