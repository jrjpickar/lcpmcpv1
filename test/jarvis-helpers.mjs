// Shared fixtures for the JARVIS v2 tests. No live Groq or Netlify calls.
export const env = { LCP_STUDIO_KEY: 'gateway-studio-key-for-testing', GROQ_API_KEY: 'gsk_test_fixture' };
export const origin = 'https://lcp.example';
export function post(path, body, headers = {}) {
  return new Request(origin + path, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json', 'x-lcp-studio-key': env.LCP_STUDIO_KEY, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
export function get(path, headers = {}) {
  return new Request(origin + path, { headers: { 'x-lcp-studio-key': env.LCP_STUDIO_KEY, ...headers } });
}
export function groqReply(content, tokens = 100) {
  return Response.json({ model: 'openai/gpt-oss-20b', choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }], usage: { total_tokens: tokens } });
}
// Groq fixture that answers from a queue of responders and records every request body.
export function fakeGroq(...responders) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (String(url) !== 'https://api.groq.com/openai/v1/chat/completions') throw new Error('Unexpected fetch ' + url);
    const body = JSON.parse(init.body);
    calls.push(body);
    const next = responders.length > 1 ? responders.shift() : responders[0];
    return groqReply(typeof next === 'function' ? next(body, calls.length) : next);
  };
  return { calls, fetchImpl };
}
