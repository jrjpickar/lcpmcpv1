import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStudioHandler } from '../netlify/functions/lib/studio.mjs';
import { localStudioStore } from '../sandbox/studio-store.mjs';
import { initialConfig } from '../public/studio-schema.mjs';

test('Studio protects drafts, persists releases, rejects conflicts and restores the baseline', async t => {
  const folder = await mkdtemp(join(tmpdir(), 'lcp-studio-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const previousMode = process.env.DATA_MODE;
  process.env.DATA_MODE = 'sample';
  t.after(() => {
    if (previousMode === undefined) delete process.env.DATA_MODE;
    else process.env.DATA_MODE = previousMode;
  });

  const file = join(folder, 'layout.json');
  const origin = 'https://dashboard.example';
  const key = 'studio-key-for-tests-only';
  const start = () => createStudioHandler(() => localStudioStore(file), () => key);
  let handle = start();
  const get = (admin, credential) => handle(new Request(origin + '/api/studio' + (admin ? '?admin=1' : ''), {
    headers: credential ? { 'x-lcp-studio-key': credential } : {},
  }));
  const post = (command, overrides = {}) => handle(new Request(origin + '/api/studio?admin=1', {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-lcp-studio-key': key, ...overrides },
    body: JSON.stringify(command),
  }));

  assert.equal((await get(true)).status, 401);
  const config = initialConfig();
  config.tabs.reverse();
  config.sales[0].hidden = true;
  config.modules.push({ id: 'dial-count', type: 'metric', page: 'sales', title: 'Dial count', metric: 'dials' });

  const save = { action: 'save', revision: 0, config };
  assert.equal((await post(save, { origin: 'https://other.example' })).status, 403);
  assert.equal((await post({ ...save, config: { ...config, modules: [{ type: 'javascript' }] } })).status, 400);
  assert.equal((await post({ action: 'publish', revision: 0 })).status, 409);

  const writes = await Promise.all([post(save), post(save)]);
  assert.deepEqual(writes.map(response => response.status).sort(), [200, 409]);
  assert.deepEqual(await (await get(false)).json(), { published: initialConfig() });

  handle = start();
  assert.deepEqual((await (await get(true, key)).json()).draft, config);
  assert.equal((await post({ action: 'publish', revision: 1 })).status, 200);
  handle = start();
  assert.deepEqual(await (await get(false)).json(), { published: config });
  const restored = await post({ action: 'rollback', revision: 2, version: 0 });
  assert.equal(restored.status, 200);
  assert.deepEqual(await (await get(false)).json(), { published: initialConfig() });
  assert.deepEqual((await restored.json()).history.map(entry => entry.action), ['rollback', 'publish', 'baseline']);
});
