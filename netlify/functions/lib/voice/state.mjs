import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';

export const digest = value => createHash('sha256').update(value).digest('hex');
export const nonce = () => randomBytes(32).toString('base64url');
export const issueKey = /^[\w-]{43}$/;
export const fault = (status, message) => Object.assign(new Error(message), { status });
export const limit = (env, name, fallback, ceiling) => {
  const value = Number(env[name]);
  return Number.isInteger(value) && value > 0 ? Math.min(value, ceiling) : fallback;
};
export const safeEqual = (a, b) => a.length === b.length && timingSafeEqual(a, b);

export function origin(env) {
  const url = new URL(env.VOICE_ORIGIN);
  if (url.href !== url.origin + '/' || (url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Invalid VOICE_ORIGIN');
  return url.origin;
}

// Slack users allowed to launch Call Brain with /call-lcp: VOICE_SLACK_USERS="T0TEAM:U0USER,T0TEAM:U0OTHER".
export function linkedIdentity(env, slackId) {
  const allowed = (env.VOICE_SLACK_USERS || '').split(',').map(item => item.trim()).filter(Boolean);
  return typeof slackId === 'string' && allowed.includes(slackId) ? { slackId } : null;
}

export function signLaunch(env, payload) {
  return createHmac('sha256', env.SLACK_SIGNING_SECRET).update('lcp-voice-launch-v1.' + payload).digest();
}

export function memoryStore() {
  const entries = new Map();
  return {
    async getWithMetadata(key) { return structuredClone(entries.get(key) ?? null); },
    async setJSON(key, data, options) {
      const old = entries.get(key);
      if (options.onlyIfNew ? old : old?.etag !== options.onlyIfMatch) return { modified: false };
      entries.set(key, { data: structuredClone(data), etag: nonce() });
      return { modified: true };
    },
  };
}
let local;
export function stateStore(env) {
  if (env.VOICE_LOCAL_MEMORY === '1' && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin(env))) {
    return local ||= memoryStore();
  }
  return getStore({ name: 'lcp-voice', consistency: 'strong' });
}

export async function update(store, key, mutate) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const old = await store.getWithMetadata(key, { type: 'json' });
    const value = mutate(old?.data);
    if ((await store.setJSON(key, value, old ? { onlyIfMatch: old.etag } : { onlyIfNew: true })).modified) return value;
  }
  throw fault(503, 'Voice storage is busy. Try again.');
}

export async function charge(store, env, kind) {
  const isTurn = kind === 'turn';
  const maximum = isTurn ? limit(env, 'VOICE_DAILY_TURNS', 100, 10000) : limit(env, 'VOICE_DAILY_SESSIONS', 50, 2000);
  const day = new Date().toISOString().slice(0, 10);
  return update(store, 'quota/' + day + '/' + kind, (count = 0) => {
    if (count >= maximum) throw fault(429, 'Daily voice usage limit reached.');
    return count + 1;
  });
}
