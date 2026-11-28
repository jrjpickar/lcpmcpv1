import { loadBrainStatus } from './lib/brain-status.mjs';
import { update } from './lib/jarvis-memory.mjs';
import { openJarvisStore } from './lib/jarvis-store.mjs';
import { addSamples, HISTORY_KEY } from './lib/source-history.mjs';

// The dashboard and this job use the same store, even when the VM runs alerts.
export default async function handler() {
  const { billing, groq, sample } = await loadBrainStatus(process.env, fetch, { fresh: true });
  if (!sample && [billing, groq].some(source => source.status !== 'off')) {
    const slot = new Date(Math.floor(Date.now() / 300000) * 300000).toISOString();
    await update(await openJarvisStore(), HISTORY_KEY, () => ({}), history => {
      addSamples(history, { billing, groq }, slot);
    });
  }
  return new Response(null, { status: 204 });
}

export const config = { schedule: '*/5 * * * *' };
