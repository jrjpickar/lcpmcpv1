// Local sandbox: sample data only. No dialer, GHL, Ledger or Groq requests (unless GROQ_API_KEY is set).
// npm run sandbox  ->  http://127.0.0.1:4173   MCP: POST http://127.0.0.1:4173/mcp
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { createJarvisMemoryHandler } from '../netlify/functions/jarvis-memory.mjs';
import { createInstructionsHandler } from '../netlify/functions/jarvis-instructions.mjs';
import { createExecuteHandler } from '../netlify/functions/jarvis-execute.mjs';
import { createStudioHandler } from '../netlify/functions/lib/studio.mjs';
import { localKeyedStore, localStudioStore } from './studio-store.mjs';
process.env.DATA_MODE = 'sample';
const studioFile = resolve(process.env.LCP_STUDIO_LOCAL_FILE || '.lcp-studio-local.json');
const jarvisStore = localKeyedStore(resolve(process.env.LCP_JARVIS_LOCAL_DIR || '.lcp-jarvis-local'));
const routes = {
  '/api/jarvis': createJarvisHandler({ openStore: async () => jarvisStore }),
  '/api/jarvis-memory': createJarvisMemoryHandler({ openStore: async () => jarvisStore }),
  '/api/jarvis-instructions': createInstructionsHandler({ openStore: async () => jarvisStore }),
  '/api/jarvis-execute': createExecuteHandler({ openStore: async () => jarvisStore }),
  '/api/jarvis-email-draft': (await import('../netlify/functions/jarvis-email-draft.mjs')).default,
  '/api/voice': (await import('../netlify/functions/voice.mjs')).default,
  '/api/voice-turn': (await import('../netlify/functions/voice-turn.mjs')).default,
  '/api/studio': createStudioHandler(() => localStudioStore(studioFile)),
  '/api/brain-status': (await import('../netlify/functions/brain-status.mjs')).default,
  '/api/activity': (await import('../netlify/functions/activity.mjs')).default,
  '/api/metrics': (await import('../netlify/functions/metrics.mjs')).default,
  '/api/ask': (await import('../netlify/functions/ask.mjs')).default,
  '/mcp': (await import('../netlify/functions/mcp.mjs')).default,
  '/api/workflows': (await import('../netlify/functions/workflows.mjs')).default,
  '/api/alerts': (await import('../netlify/functions/alerts.mjs')).default,
};
const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/lcp-metrics.js': ['lcp-metrics.js', 'application/javascript'], '/sample-data.js': ['sample-data.js', 'application/javascript'], '/brain3d.js': ['brain3d.js', 'application/javascript'] };
for (const name of ['studio.mjs', 'jarvis.mjs', 'jarvis-intent.mjs', 'jarvis-instructions.mjs', 'studio-schema.mjs', 'studio.css', 'voice.js', 'voice-vad.js', 'voice-launch.js', 'voice.css', 'voice.html']) {
  files['/' + name] = [name, name.endsWith('.css') ? 'text/css' : name.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/javascript'];
}
const port = Number(process.env.PORT || 4173);
http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  const fn = routes[url.pathname];
  if (fn) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if ((url.pathname === '/api/studio' && size > 131072) || (['/api/jarvis', '/api/jarvis-execute'].includes(url.pathname) && size > 16384) || (['/api/jarvis-memory', '/api/jarvis-instructions'].includes(url.pathname) && size > 8192)) {
        res.writeHead(413); res.end('Request body exceeds the size limit.'); return;
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    const response = await fn(new Request(url, { method: req.method, headers: req.headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body }));
    res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer())); return;
  }
  const f = files[url.pathname];
  if (!f) { res.writeHead(404); res.end('Not found'); return; }
  res.writeHead(200, { 'content-type': f[1], 'cache-control': 'no-store' });
  res.end(await readFile(new URL(`../public/${f[0]}`, import.meta.url)));
}).listen(port, '127.0.0.1', () => console.log(`LCP MCP sandbox (SAMPLE DATA): http://127.0.0.1:${port}`));
