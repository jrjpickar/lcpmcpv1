// Build check: syntax-load every module and run the engine once on sample data.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
process.env.DATA_MODE = 'sample';
const M = require('../public/lcp-metrics.js');
const S = require('../public/sample-data.js');
for (const f of ['metrics', 'ask', 'mcp', 'workflows']) await import(`../netlify/functions/${f}.mjs`);
const r = M.compute(S.generate({ days: 40 }), { preset: '30d' });
for (const k of ['callsByUser', 'opportunities', 'smsToQualified', 'dialsToQualified']) if (!r[k]) throw new Error(`missing ${k}`);
if (!(r.kpis.dials > 0)) throw new Error('engine produced no dials');
const { readFile } = await import('node:fs/promises');
const brain = await readFile(new URL('../public/brain3d.js', import.meta.url), 'utf8');
if (!brain.includes('LcpBrain')) throw new Error('public/brain3d.js is missing or stale. Run node scripts/build-brain.mjs');
console.log('Build check passed:', JSON.stringify(r.kpis));
