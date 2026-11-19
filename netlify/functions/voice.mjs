import { dashboardAccess, json } from './lib/auth.mjs';
import { askVoice, voicePresets as presets } from './lib/voice/brain.mjs';
import { readBody, reasoningProviders, speechModes, synthesize, transcribe } from './lib/voice/providers.mjs';
import { charge, digest, fault, issueKey, limit, linkedIdentity, nonce, origin, safeEqual, signLaunch, stateStore, update } from './lib/voice/state.mjs';

const running = new Map();
const maxAudio = 44 + 16000 * 2 * 12;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const invalidSession = () => fault(401, 'Voice session expired or ended. Reconnect to continue.');

function launchIdentity(env, token) {
  const match = typeof token === 'string' && /^([\w-]{1,1024})\.([\w-]{43})$/.exec(token);
  if (!match || !env.SLACK_SIGNING_SECRET || !safeEqual(Buffer.from(match[2], 'base64url'), signLaunch(env, match[1]))) throw invalidSession();
  const launch = JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'));
  if (launch.expires <= Date.now() || !Number.isSafeInteger(launch.expires) || !/^[a-f0-9]{64}$/.test(launch.id)) throw invalidSession();
  const identity = linkedIdentity(env, launch.slackId);
  if (!identity) throw invalidSession();
  return { identity, slackId: launch.slackId, launchId: launch.id };
}

function assertSession(session, env) {
  if (!session || session.ended || session.expires <= Date.now()) throw invalidSession();
  if (session.slackId && !linkedIdentity(env, session.slackId)) throw invalidSession();
  if (session.dashboard && session.dashboard !== digest(env.DASHBOARD_KEY || '')) throw invalidSession();
  return session;
}

function validateWav(wav) {
  if (wav.length < 44 + 3200 || wav.length % 2 || wav.toString('ascii', 0, 4) !== 'RIFF' ||
      wav.readUInt32LE(4) !== wav.length - 8 || wav.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
      wav.readUInt32LE(16) !== 16 || wav.readUInt16LE(20) !== 1 || wav.readUInt16LE(22) !== 1 ||
      wav.readUInt32LE(24) !== 16000 || wav.readUInt32LE(28) !== 32000 || wav.readUInt16LE(32) !== 2 ||
      wav.readUInt16LE(34) !== 16 || wav.toString('ascii', 36, 40) !== 'data' || wav.readUInt32LE(40) !== wav.length - 44) {
    throw fault(400, 'Expected 16 kHz mono PCM audio.');
  }
}

async function begin(request, body, env, store) {
  const launch = body.launch ? launchIdentity(env, body.launch) : null;
  const identity = launch?.identity || dashboardAccess(request, env.DATA_MODE === 'sample', env);
  if (!identity) throw fault(401, 'Dashboard sign-in required.');
  if (!reasoningProviders(env).length) throw fault(503, 'Voice reasoning is not configured. Set VOICE_APPROVED_REASONING.');
  if (launch) {
    const claim = await store.setJSON('redeemed/' + launch.launchId, { at: Date.now() }, { onlyIfNew: true });
    if (!claim.modified) throw fault(409, 'This Slack link has already been used. Run /call-lcp again.');
  }
  await charge(store, env, 'session');
  const expires = Date.now() + limit(env, 'VOICE_SESSION_MINUTES', 10, 15) * 60000;
  const session = { expires, turns: [], active: null };
  if (launch) {
    session.slackId = launch.slackId;
  } else {
    session.dashboard = digest(env.DASHBOARD_KEY || '');
  }
  const token = nonce();
  const saved = await store.setJSON('session/' + digest(token), session, { onlyIfNew: true });
  if (!saved.modified) throw fault(503, 'Unable to create voice session.');
  return json({ token, expires, stt: speechModes(env) });
}

function turnInput(body) {
  if (!Array.isArray(body.history) || body.history.length > 6 || body.history.length % 2 ||
      body.history.some((item, i) => !item || item.role !== (i % 2 ? 'assistant' : 'user') ||
        typeof item.content !== 'string' || item.content.length > 1600)) throw fault(400, 'Invalid conversation history.');
  const history = body.history.map(({ role, content }) => ({ role, content }));
  if ((typeof body.text === 'string') === (typeof body.audio === 'string')) throw fault(400, 'Supply text or audio.');
  if (typeof body.text === 'string') {
    if (!body.text.trim() || body.text.length > 1000) throw fault(400, 'Invalid question.');
    return { text: body.text.trim(), history };
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body.audio)) throw fault(400, 'Invalid audio.');
  const wav = Buffer.from(body.audio, 'base64');
  if (wav.length > maxAudio) throw fault(413, 'Audio is too long.');
  validateWav(wav);
  return { wav, history };
}

async function turn(request, body, env, store, key, fetchImpl) {
  const { text, wav, history } = turnInput(body);
  const modes = speechModes(env);
  if (wav && !modes.some(mode => mode !== 'browser')) throw fault(503, 'Server transcription is unavailable.');
  const session = await update(store, key, current => {
    assertSession(current, env);
    if (current.turns.includes(body.id)) throw fault(409, 'This turn was already accepted. Send a new turn to continue.');
    if (current.turns.length >= limit(env, 'VOICE_SESSION_TURNS', 20, 60)) throw fault(429, 'Session turn limit reached.');
    return { ...current, turns: [...current.turns, body.id], active: body.id };
  });
  const controller = new AbortController();
  const runKey = key + '/' + body.id;
  running.set(runKey, controller);
  const remainingMs = Math.max(0, session.expires - Date.now());
  const signal = AbortSignal.any([controller.signal, request.signal, AbortSignal.timeout(Math.min(25000, remainingMs))]);
  const ctx = { env, signal, fetchImpl };
  async function currentTurn() {
    signal.throwIfAborted();
    const current = assertSession((await store.getWithMetadata(key, { type: 'json' }))?.data, env);
    if (current.active !== body.id) throw fault(409, 'Voice turn interrupted.');
  }
  try {
    await charge(store, env, 'turn');
    await currentTurn();
    const started = performance.now();
    const transcript = text ?? await transcribe(ctx, wav, modes);
    const sttMs = wav ? Math.round(performance.now() - started) : 0;
    if (!transcript) return json({ transcript: '', answer: '', timings: { sttMs } });
    await currentTurn();
    const result = await askVoice({ ...ctx, beforeReasoning: currentTurn }, transcript, history, presets.includes(body.preset) ? body.preset : 'mtd');
    await currentTurn();
    const ttsStart = performance.now();
    const audio = body.speak === true ? await synthesize(ctx, result.answer) : null;
    await currentTurn();
    return json({ ...result, transcript, audio, timings: { ...result.timings, sttMs, ttsMs: audio ? Math.round(performance.now() - ttsStart) : null } });
  } catch (error) {
    if (controller.signal.aborted || request.signal.aborted) throw fault(409, 'Voice turn interrupted.');
    if (signal.aborted && !error.status) throw fault(504, 'Voice turn timed out.');
    throw error;
  } finally {
    running.delete(runKey);
  }
}

export async function voice(request, { env = process.env, store, fetchImpl = fetch } = {}, isAsk = false) {
  if (request.method !== 'POST') return json({ error: 'POST required' }, 405, { Allow: 'POST' });
  if (env.VOICE_ENABLED !== '1') return json({ error: 'Call Brain is disabled.' }, 503);
  try {
    if (request.headers.get('origin') !== origin(env)) throw fault(403, 'Unapproved voice origin.');
    if (request.headers.get('content-type')?.split(';')[0] !== 'application/json') throw fault(415, 'Expected JSON.');
    const body = JSON.parse(await readBody(request, isAsk ? 550000 : 4096));
    if (!body || typeof body !== 'object') throw fault(400, 'Invalid request.');
    if (isAsk ? body.action !== 'turn' : !['start', 'resume', 'end', 'cancel'].includes(body.action)) throw fault(400, 'Invalid voice action.');
    store ||= stateStore(env);
    if (body.action === 'start') return await begin(request, body, env, store);
    const token = request.headers.get('x-lcp-voice') || '';
    if (!issueKey.test(token)) throw invalidSession();
    const key = 'session/' + digest(token);
    if (body.action === 'resume') {
      const { expires } = assertSession((await store.getWithMetadata(key, { type: 'json' }))?.data, env);
      return json({ expires, stt: speechModes(env) });
    }
    if (body.action !== 'end' && !uuid.test(body.id || '')) throw fault(400, 'Invalid turn ID.');
    if (body.action === 'turn') return await turn(request, body, env, store, key, fetchImpl);
    await update(store, key, session => {
      assertSession(session, env);
      if (body.action === 'end') return { ...session, ended: true, active: null };
      return session.active === body.id ? { ...session, active: null } : session;
    });
    if (body.action === 'cancel') running.get(key + '/' + body.id)?.abort();
    else for (const [id, controller] of running) {
      if (id.startsWith(key + '/')) controller.abort();
    }
    return json({ ok: true });
  } catch (error) {
    const status = error instanceof SyntaxError ? 400 : error.status || 503;
    return json({ error: error instanceof SyntaxError ? 'Invalid JSON.' : error.status ? error.message : 'Voice temporarily unavailable.' }, status);
  }
}

export default (request, context) => voice(request, context);
export const config = { path: '/api/voice' };
