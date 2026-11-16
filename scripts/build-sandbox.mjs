// Builds one self-contained HTML file (sample data computed in the browser) for sharing a preview.
// node scripts/build-sandbox.mjs dist/index.html  (also copies brain3d.js next to it)
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { dirname } from 'node:path';
const out = process.argv[2] || 'dist/sandbox.html';
const read = f => readFile(new URL(`../public/${f}`, import.meta.url), 'utf8');
const [html, metrics, sample] = await Promise.all([read('index.html'), read('lcp-metrics.js'), read('sample-data.js')]);
const safe = s => s.replace(/<\/script/gi, '<\\/script');
const page = html
  .replace('<script src="lcp-metrics.js"></script>', () => `<script>${safe(metrics)}</script>`)
  .replace('<!--SAMPLE-->', () => `<script>${safe(sample)}</script><script>window.LCP_STATIC=true;</script>`)
  .replace('<title>LCP MCP</title>', '<title>LCP MCP Sandbox</title>');
await mkdir(dirname(out), { recursive: true });
await writeFile(out, page);
// The 3D Brain loads brain3d.js from the same folder.
await copyFile(new URL('../public/brain3d.js', import.meta.url), `${dirname(out)}/brain3d.js`);
console.log(`Wrote ${out} (${(page.length / 1024).toFixed(0)} KB)`);
