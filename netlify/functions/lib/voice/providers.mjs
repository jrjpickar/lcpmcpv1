import { DEFAULT_MODEL } from '../groq.mjs';
import { GEMINI_MODEL } from '../jarvis-agents.mjs';

const groqReasoningOptions = model => (/^openai\/gpt-oss-(?:20b|120b)$/.test(model) ? { reasoning_effort: 'low', include_reasoning: false } : {});
import { fault, limit } from './state.mjs';

export async function readBody(request, maximum) {
  if (Number(request.headers.get('content-length')) > maximum) throw fault(413, 'Request too large.');
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks);
      size += value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => {});
        throw fault(413, 'Request too large.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export function speechModes(env) {
  const stt = [];
  if (env.VOICE_WHISPER_URL) stt.push('local');
  if (env.VOICE_GROQ_STT_APPROVED === '1' && env.GROQ_API_KEY) stt.push('groq');
  if (env.VOICE_BROWSER_STT_APPROVED === '1') stt.push('browser');
  return stt;
}

export function reasoningProviders(env) {
  const groq = env.GROQ_MODEL || DEFAULT_MODEL;
  return [
    ['groq', env.GROQ_API_KEY, groq, 'https://api.groq.com/openai/v1/chat/completions', groqReasoningOptions(groq)],
    // Gemini reuses the JARVIS GEMINI_API_KEY. Model: VOICE_GEMINI_MODEL, else GEMINI_MODEL, else gemini-3.1-flash-lite.
    ['gemini', env.GEMINI_API_KEY?.trim(), env.VOICE_GEMINI_MODEL?.trim() || env.GEMINI_MODEL?.trim() || GEMINI_MODEL, 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', {}],
    ['openrouter', env.OPENROUTER_API_KEY, env.VOICE_OPENROUTER_MODEL, 'https://openrouter.ai/api/v1/chat/completions', {}],
  ].filter(([name, key, model]) => key && model && (env.VOICE_APPROVED_REASONING || '').split(',').map(item => item.trim().toLowerCase()).includes(name));
}

function adapterSignal(signal, env) {
  return AbortSignal.any([signal, AbortSignal.timeout(limit(env, 'VOICE_PROVIDER_TIMEOUT_MS', 4500, 12000))]);
}

async function requestProvider(ctx, url, options) {
  ctx.signal.throwIfAborted();
  const response = await ctx.fetchImpl(url, { method: 'POST', redirect: 'error', ...options, signal: adapterSignal(ctx.signal, ctx.env) });
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw fault(response.status === 429 ? 429 : 502, 'Voice provider unavailable.');
  }
  return response;
}

async function tryProviders(ctx, adapters) {
  let rateLimited = false;
  for (const adapter of adapters) {
    try {
      return await adapter();
    } catch (error) {
      ctx.signal.throwIfAborted();
      rateLimited ||= error.status === 429;
    }
  }
  throw fault(rateLimited ? 429 : 502, rateLimited ? 'Voice providers are rate limited. Try again shortly.' : 'Voice providers are unavailable.');
}

export async function transcribe(ctx, wav, modes) {
  return tryProviders(ctx, modes.filter(mode => mode !== 'browser').map(mode => async () => {
    const local = mode === 'local';
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'utterance.wav');
    form.append('model', local ? ctx.env.VOICE_WHISPER_MODEL || 'whisper-1' : ctx.env.VOICE_GROQ_STT_MODEL || 'whisper-large-v3-turbo');
    form.append('response_format', 'json');
    const key = local ? ctx.env.VOICE_WHISPER_KEY : ctx.env.GROQ_API_KEY;
    const response = await requestProvider(ctx, local ? ctx.env.VOICE_WHISPER_URL : 'https://api.groq.com/openai/v1/audio/transcriptions', {
      headers: key ? { Authorization: 'Bearer ' + key } : {}, body: form,
    });
    const { text } = JSON.parse(await readBody(response, 32000));
    if (typeof text !== 'string') throw new Error('Invalid transcript');
    return text.trim().slice(0, 1000);
  }));
}

export async function reason(ctx, messages) {
  const providers = reasoningProviders(ctx.env);
  if (!providers.length) throw fault(503, 'Configure an approved voice reasoning provider.');
  return tryProviders(ctx, providers.map(([provider, key, model, url, options]) => async () => {
    const response = await requestProvider(ctx, url, {
      headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model, messages, temperature: 0.2, ...options,
        [provider === 'groq' ? 'max_completion_tokens' : 'max_tokens']: limit(ctx.env, 'VOICE_MAX_OUTPUT_TOKENS', 256, 1024),
      }),
    });
    const data = JSON.parse(await readBody(response, 128000));
    const answer = data.choices?.[0]?.message?.content?.trim();
    if (!answer) throw new Error('Empty response');
    return { provider, answer: answer.slice(0, 1600) };
  }));
}

export async function synthesize(ctx, text) {
  const { env } = ctx;
  const url = env.VOICE_TTS_URL || (env.VOICE_EXTERNAL_TTS_APPROVED === '1' && env.VOICE_EXTERNAL_TTS_URL);
  if (!url) return null;
  const key = env.VOICE_TTS_URL ? env.VOICE_TTS_KEY : env.VOICE_EXTERNAL_TTS_KEY;
  try {
    const response = await requestProvider(ctx, url, {
      headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: 'Bearer ' + key } : {}) },
      body: JSON.stringify({ text }),
    });
    const type = response.headers.get('content-type')?.split(';')[0];
    if (!['audio/mpeg', 'audio/wav', 'audio/mp4'].includes(type)) {
      void response.body?.cancel().catch(() => {});
      return null;
    }
    return { type, base64: (await readBody(response, 750000)).toString('base64') };
  } catch {
    ctx.signal.throwIfAborted();
    return null; // Browser speech is the configured playback fallback.
  }
}
