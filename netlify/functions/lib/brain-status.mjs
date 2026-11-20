import { twilioCredentials } from './activity.mjs';
import { DEFAULT_MODEL } from './groq.mjs';

const check = (status, detail, values) => ({ status, detail, ...values });

async function balanceStatus(env, fetchImpl) {
  const billingSid = env.TWILIO_BILLING_ACCOUNT_SID;
  const billingToken = env.TWILIO_BILLING_AUTH_TOKEN;
  if (!billingSid && !billingToken && !env.TWILIO_ACCOUNT_SID) return check('off', 'Not configured');
  if ((billingSid || billingToken) && (!billingSid || !billingToken)) {
    return check('warn', 'Set both TWILIO_BILLING_ACCOUNT_SID and TWILIO_BILLING_AUTH_TOKEN');
  }
  let auth;
  try {
    auth = twilioCredentials(billingSid ? { TWILIO_ACCOUNT_SID: billingSid, TWILIO_AUTH_TOKEN: billingToken } : env);
  } catch (error) {
    return check('warn', error.message);
  }
  try {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${auth.account}/Balance.json`, {
      method: 'GET', headers: { authorization: auth.authorization, accept: 'application/json' },
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!res.ok) return check('down', `Balance read failed (HTTP ${res.status})`);
    const { balance, currency } = await res.json();
    const amount = Number(balance);
    if (!/^[+-]?\d+(?:\.\d+)?$/.test(String(balance ?? '')) || !Number.isFinite(amount) || !/^[A-Z]{3}$/.test(currency || '')) {
      return check('down', 'Twilio returned an invalid balance');
    }
    return check('ok', 'Billing balance read', { balance: amount, currency, checkedAt: new Date().toISOString() });
  } catch {
    return check('down', 'Twilio balance request failed');
  }
}

async function groqStatus(env, fetchImpl) {
  if (!env.GROQ_API_KEY) return check('off', 'Not configured');
  try {
    const res = await fetchImpl('https://api.groq.com/openai/v1/models', {
      method: 'GET', headers: { authorization: `Bearer ${env.GROQ_API_KEY}`, accept: 'application/json' },
      signal: AbortSignal.timeout(5000), redirect: 'error',
    });
    if (!res.ok) return check('down', `Model read failed (HTTP ${res.status})`);
    const { data } = await res.json();
    if (!Array.isArray(data)) return check('down', 'Groq returned an invalid model list');
    const model = env.GROQ_MODEL || DEFAULT_MODEL;
    return data.some(item => item?.id === model) ? check('ok', 'Configured model listed', { model }) : check('warn', 'Configured model unavailable: ' + model, { model });
  } catch {
    return check('down', 'Groq model request failed');
  }
}

let cached;
export async function loadBrainStatus(env = process.env, fetchImpl = fetch, { fresh = false } = {}) {
  if (env.DATA_MODE === 'sample') return { sample: true };
  const load = async () => {
    const started = Date.now();
    const timed = async run => {
      const start = Date.now();
      const result = await run(env, fetchImpl);
      return { ...result, elapsedMs: Date.now() - start };
    };
    const [billing, groq] = await Promise.all([timed(balanceStatus), timed(groqStatus)]);
    return { billing, groq, checkedAt: new Date().toISOString(), elapsedMs: Date.now() - started };
  };
  if (env !== process.env || fetchImpl !== fetch) return load();
  if (cached?.until === Infinity || (!fresh && cached?.until > Date.now())) return cached.result;
  const entry = { until: Infinity };
  entry.result = load().then(result => {
    entry.until = Date.now() + ((result.billing.status === 'down' || result.groq.status === 'down') ? 30000 : 120000);
    return result;
  });
  cached = entry;
  return entry.result;
}
