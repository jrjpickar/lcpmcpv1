// Groq errors: the reply shows Groq's error code, and json_validate_failed retries once without JSON mode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { groqModel } from '../netlify/functions/lib/jarvis-agents.mjs';

const res = (status, obj) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
const ok = content => res(200, { choices: [{ message: { content } }], usage: { total_tokens: 5 } });

test('json_validate_failed retries once without response_format and parses the JSON', async () => {
  const bodies = [];
  const fetchImpl = async (url, options) => {
    bodies.push(JSON.parse(options.body));
    return bodies.length === 1 ? res(400, { error: { code: 'json_validate_failed', message: 'Failed to validate JSON' } }) : ok('Sure: {"agent":"main","answer":"hi"}');
  };
  assert.deepEqual(await groqModel('k', fetchImpl)('x', {}, true), { agent: 'main', answer: 'hi' });
  assert.equal(bodies[0].response_format.type, 'json_object');
  assert.equal(bodies[1].response_format, undefined);
});

test('other 400 errors show the Groq code and message', async () => {
  const fetchImpl = async () => res(400, { error: { code: 'model_decommissioned', message: 'The model has been decommissioned' } });
  await assert.rejects(groqModel('k', fetchImpl)('x', {}, true), error => /HTTP 400, model_decommissioned\): The model has been decommissioned/.test(error.message));
});

test('non JSON error bodies and 429 keep the short messages', async () => {
  await assert.rejects(groqModel('k', async () => new Response('bad gateway', { status: 502 }))('x', {}), error => error.message === 'Groq request failed (HTTP 502).');
  await assert.rejects(groqModel('k', async () => res(429, {}))('x', {}), error => error.agentStatus === 429);
});
