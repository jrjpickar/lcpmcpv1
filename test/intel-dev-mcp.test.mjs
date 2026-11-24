// Dev runner sandbox, archives, MCP scoped tokens and intel tools, JARVIS research agent, Slack research prefix, Socket Mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync, inflateRawSync } from 'node:zlib';
import { memoryAdapter } from '../netlify/functions/lib/jarvis-memory.mjs';
import { untarGz, unifiedDiff, zip } from '../netlify/functions/lib/intel/archive.mjs';
import { createDev, devRepos } from '../netlify/functions/lib/intel/dev.mjs';
import { applyEdits, commandFor, createDevRunner, safePath } from '../server/dev-runner.mjs';
import { createJarvisHandler } from '../netlify/functions/jarvis.mjs';
import { parseMessage } from '../netlify/functions/lib/slack.mjs';
import { startSlackSocket } from '../server/slack-socket.mjs';
import { env, post, groqReply } from './jarvis-helpers.mjs';

process.env.DATA_MODE = 'sample';

function tarGz(files) {
  const blocks = [];
  for (const [path, content] of Object.entries(files)) {
    const data = Buffer.from(content);
    const header = Buffer.alloc(512);
    header.write('repo-abc123/' + path, 0, 'utf8');
    header.write('0000644\0', 100); header.write('0000000\0', 108); header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.write('00000000000\0', 136); header.write('        ', 148); header.write('0', 156); header.write('ustar\0', 257);
    let sum = 0; for (const byte of header) sum += byte;
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}

// Reads back our ZIP: local headers only, enough to check names and contents.
function unzip(buffer) {
  const out = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8), size = buffer.readUInt32LE(offset + 18), nameLength = buffer.readUInt16LE(offset + 26), extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    const body = buffer.subarray(offset + 30 + nameLength + extra, offset + 30 + nameLength + extra + size);
    out[name] = (method === 8 ? inflateRawSync(body) : body).toString();
    offset += 30 + nameLength + extra + size;
  }
  return out;
}

test('archives: tar.gz reader strips the top folder and refuses traversal; zip and diff round trip', () => {
  const files = untarGz(tarGz({ 'src/a.mjs': 'export const a = 1;\n', '../evil.txt': 'x' }));
  assert.deepEqual(files.map(f => f.path), ['src/a.mjs']);
  const archive = zip([{ path: 'src/a.mjs', content: 'export const a = 2;\n' }, { path: 'README.md', content: 'x'.repeat(2000) }]);
  assert.deepEqual(Object.keys(unzip(archive)), ['src/a.mjs', 'README.md']);
  assert.equal(unzip(archive)['README.md'].length, 2000);
  const diff = unifiedDiff('src/a.mjs', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n');
  assert.match(diff, /^--- a\/src\/a\.mjs\n\+\+\+ b\/src\/a\.mjs\n@@ -1,4 \+1,4 @@\n one\n-two\n\+TWO\n three\n/);
});

test('dev sandbox guards: repo allowlist, path checks, fixed command allowlist, exact-match edits', async () => {
  const store = memoryAdapter();
  const dev = createDev({ store, env: { DEV_REPOS: 'jesse/app' } });
  assert.deepEqual(devRepos({ DEV_REPOS: 'jesse/app, bad repo' }), ['jesse/app']);
  await assert.rejects(dev.create({ repo: 'someone/else', objective: 'Change everything now please' }), /DEV_REPOS/);
  const root = await mkdtemp(join(tmpdir(), 'lcp-dev-'));
  await mkdir(join(root, 'src'));
  await symlink('/etc', join(root, 'src', 'link'));
  await assert.rejects(safePath(root, '../outside.txt'), /not allowed/);
  await assert.rejects(safePath(root, '.git/config'), /not allowed/);
  await assert.rejects(safePath(root, '.env'), /not allowed/);
  await assert.rejects(safePath(root, 'src/link/passwd'), /escapes|Symlink/);
  assert.equal((await safePath(root, 'src/new.mjs')).rel, 'src/new.mjs');
  assert.equal(commandFor('rm -rf /', {}), null);
  assert.equal(commandFor('deploy', { scripts: { deploy: 'netlify deploy --prod' } }), null);
  assert.deepEqual(commandFor('test', { scripts: { test: 'node --test' } }), ['npm', ['test']]);
  const files = new Map([['a.mjs', 'const x = 1;\nconst x2 = 1;\n']]);
  assert.match(applyEdits(files, [{ path: 'a.mjs', search: 'const x', replace: 'let x' }]).errors[0], /more than once/);
  assert.equal(applyEdits(files, [{ path: 'a.mjs', search: 'x2 = 1', replace: 'x2 = 2' }]).changed.get('a.mjs'), 'const x = 1;\nconst x2 = 2;\n');
});

test('dev runner fixes a bug in an isolated workspace, runs the real tests and returns a patch ZIP, never deploying', async () => {
  const store = memoryAdapter();
  const workdir = await mkdtemp(join(tmpdir(), 'lcp-runner-'));
  const repoFiles = {
    'package.json': JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node --test', deploy: 'echo should-never-run' } }),
    'src/fee.mjs': 'export const assignmentFee = (contract, sale) => contract - sale;\n',
    'test/fee.test.mjs': "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { assignmentFee } from '../src/fee.mjs';\ntest('fee', () => assert.equal(assignmentFee(200000, 215000), 15000));\n",
  };
  const prompts = [];
  const fetchImpl = async (url, init) => {
    const href = String(url);
    if (href === 'https://api.github.com/repos/jesse/app/tarball') return new Response(tarGz(repoFiles));
    if (href.startsWith('https://api.groq.com/')) {
      const body = JSON.parse(init.body);
      prompts.push(body.messages.at(-1).content);
      return groqReply({ rootCause: 'Subtraction order is reversed.', summary: 'Fee is sale minus contract.', edits: [{ path: 'src/fee.mjs', search: 'contract - sale', replace: 'sale - contract' }], tests: 'npm test' });
    }
    throw new Error('Unexpected fetch ' + href);
  };
  const runEnv = { DEV_REPOS: 'jesse/app', GROQ_API_KEY: 'gsk_fixture', DEV_WORKDIR: workdir, INTEL_WEB: 'off', GITHUB_TOKEN: 'ghp_' + 'z'.repeat(36) };
  const queued = await createDev({ store, env: runEnv }).create({ repo: 'jesse/app', objective: 'The assignment fee test fails. Fix the fee calculation.' });
  const runner = createDevRunner({ env: runEnv, openStore: async () => store, fetchImpl, log: () => {} });
  const task = await runner.tick();
  assert.equal(task.id, queued.id);
  assert.equal(task.status, 'validated', JSON.stringify(task.attempts));
  assert.equal(task.deployed, false);
  assert.equal(task.attempts[0].results[0].code, 0);
  assert.ok(!task.attempts[0].results.some(r => /deploy/.test(r.command)));
  assert.ok(!prompts.join('').includes('ghp_'), 'tokens never reach the model');
  const artifact = await createDev({ store, env: runEnv }).artifact(task.id);
  assert.deepEqual(artifact.files, ['src/fee.mjs']);
  assert.match(artifact.patch, /-export const assignmentFee = \(contract, sale\) => contract - sale;\n\+export const assignmentFee = \(contract, sale\) => sale - contract;/);
  assert.equal(unzip(Buffer.from(artifact.zipBase64, 'base64'))['src/fee.mjs'], 'export const assignmentFee = (contract, sale) => sale - contract;\n');
  assert.equal(await runner.tick(), null, 'queue is empty');
});

test('MCP: main key unchanged, scoped tokens see only their scopes, intel tools are opt-in', async () => {
  const { default: mcp } = await import('../netlify/functions/mcp.mjs');
  process.env.MCP_KEY = 'm'.repeat(32);
  const scoped = 's'.repeat(24);
  process.env.MCP_TOKENS = JSON.stringify([{ name: 'kb', sha256: createHash('sha256').update(scoped).digest('hex'), scopes: ['knowledge:read'] }]);
  const call = (token, body) => mcp(new Request('http://x/mcp', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(body) }));
  const list = async token => (await (await call(token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).json()).result.tools.map(t => t.name);
  assert.equal((await list('m'.repeat(32))).length, 13);
  assert.deepEqual(await list(scoped), []);
  process.env.MCP_INTEL_TOOLS = '1';
  assert.deepEqual(await list(scoped), ['knowledge_search']);
  assert.equal((await list('m'.repeat(32))).length, 17);
  const denied = await (await call(scoped, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'calls_by_user', arguments: {} } })).json();
  assert.equal(denied.error.code, -32602);
  assert.equal((await call('x'.repeat(24), { jsonrpc: '2.0', id: 3, method: 'ping' })).status, 401);
  for (const name of ['MCP_KEY', 'MCP_TOKENS', 'MCP_INTEL_TOOLS']) delete process.env[name];
});

test('JARVIS research agent answers with citations and the dispatcher routes research requests to it', async () => {
  const store = memoryAdapter();
  const fetchImpl = async (url, init) => {
    if (!String(url).startsWith('https://api.groq.com/')) throw new Error('Unexpected fetch ' + url);
    const body = JSON.parse(init.body);
    return groqReply(body.messages[0].content.includes('research and knowledge agent')
      ? { answer: 'Saved memory says the target is 5 minutes [M1].', assumptions: [], outstanding: [] } : 'unused');
  };
  const run = createJarvisHandler({ env: { ...env, INTEL_WEB: 'off' }, fetchImpl, openStore: async () => store, readSystems: async () => ({}) });
  const { createFacts } = await import('../netlify/functions/lib/intel/memory.mjs');
  await createFacts({ store, env: {} }).add({ kind: 'decision', text: 'Speed to lead target is 5 minutes.' });
  const direct = await (await run(post('/api/jarvis', { role: 'research', prompt: 'What is our speed to lead target?' }))).json();
  assert.equal(direct.agent, 'research');
  assert.equal(direct.citations[0].type, 'memory');
  assert.match(direct.answer, /Sources: saved memory/);
  const routed = await (await run(post('/api/jarvis', { role: 'main', prompt: 'Look up what we decided: what did we decide about speed to lead?' }))).json();
  assert.deepEqual(routed.trace, ['main', 'research']);
  assert.deepEqual(parseMessage('research: netlify blob limits'), { role: 'research', prompt: 'netlify blob limits' });
});

test('Slack Socket Mode acks envelopes, runs each event once and stays off without SLACK_APP_TOKEN', async () => {
  assert.equal(startSlackSocket({ env: {} }).status(), 'off');
  const sent = [];
  let socket;
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.url = url; socket = this; queueMicrotask(() => this.dispatchEvent(new Event('open'))); }
    send(data) { sent.push(JSON.parse(data)); }
    close() {}
  }
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async url => (String(url).includes('apps.connections.open') ? Response.json({ ok: true, url: 'wss://wss-primary.slack.com/link' }) : Response.json({ ok: true }));
  try {
    const handle = startSlackSocket({ env: { SLACK_APP_TOKEN: 'xapp-1-test', SLACK_BOT_TOKEN: 'xoxb-test', SLACK_ALLOWED_USERS: '' }, openStore: async () => memoryAdapter(), WebSocketImpl: FakeSocket, log: () => {} });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(socket.url, 'wss://wss-primary.slack.com/link');
    const envelope = { envelope_id: 'e1', type: 'events_api', payload: { event_id: 'Ev1', event: { type: 'message', channel_type: 'im', user: 'U1', text: 'hi' } } };
    socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(envelope) }));
    socket.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify({ ...envelope, envelope_id: 'e2' }) }));
    assert.deepEqual(sent.map(s => s.envelope_id), ['e1', 'e2']);
    handle.stop();
  } finally { globalThis.fetch = originalFetch; }
});
