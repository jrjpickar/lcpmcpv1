import { buildReport, paramsFrom } from './lib/report.mjs';
import { askGroq } from './lib/groq.mjs';
import { dashboardAuthorized, json } from './lib/auth.mjs';

// POST /api/ask { question, from, to, rep }  -> Groq answer over the same metrics the page shows.
export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  if (!dashboardAuthorized(request)) return json({ error: 'Unauthorized' }, 401);
  try {
    const text = await request.text();
    if (text.length > 4000) return json({ error: 'Request too large' }, 413);
    const body = JSON.parse(text || '{}');
    const result = await buildReport(paramsFrom(body));
    const ai = await askGroq({ question: body.question, result });
    if (!ai.configured) return json({ configured: false, answer: null, insights: result.insights, note: 'GROQ_API_KEY is not set. Showing rule-based insights.' });
    return json({ ...ai, insights: result.insights });
  } catch (error) {
    return json({ error: error.message }, error.status || 500);
  }
}
export const config = { path: '/api/ask' };
