// Local sandbox: sample data only. No dialer, GHL, Ledger or Groq requests (unless GROQ_API_KEY is set).
// npm run sandbox  ->  http://127.0.0.1:4173   MCP: POST http://127.0.0.1:4173/mcp
import http from 'node:http';
import { readFile } from 'node:fs/promises';
process.env.DATA_MODE = 'sample';
const routes = {
  '/api/metrics': (await import('../netlify/functions/metrics.mjs')).default,
  '/api/ask': (await import('../netlify/functions/ask.mjs')).default,
  '/mcp': (await import('../netlify/functions/mcp.mjs')).default,
  '/api/workflows': (await import('../netlify/functions/workflows.mjs')).default,
  '/api/alerts': (await import('../netlify/functions/alerts.mjs')).default,
};
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/lcp-metrics.js': ['lcp-metrics.js', 'application/javascript'], '/sample-data.js': ['sample-data.js', 'application/javascript'], '/brain3d.js': ['brain3d.js', 'application/javascript'] };
const port = Number(process.env.PORT || 4173);
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const fn = routes[url.pathname];
  if (fn) {
    let body = ''; for await (const chunk of req) body += chunk;
    const response = await fn(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
  }
  const f = files[url.pathname];
  if (!f) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' });
  res.end(await readFile(new URL(`../public/${f[0]}`, import.meta.url)));
}).listen(port, '127.0.0.1', () => console.log(`LCP MCP sandbox (SAMPLE DATA): http://127.0.0.1:${port}`));
