// Bundles src/brain3d.mjs + Three.js into public/brain3d.js (one file, global LcpBrain, no runtime CDN).
// npm i && node scripts/build-brain.mjs
import { build } from 'esbuild';
await build({ entryPoints: ['src/brain3d.mjs'], bundle: true, minify: true, format: 'iife', target: 'es2019', outfile: 'public/brain3d.js', legalComments: 'eof', logLevel: 'info' });
