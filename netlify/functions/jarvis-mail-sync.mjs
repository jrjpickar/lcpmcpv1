import { openJarvisStore } from './lib/jarvis-store.mjs';
import { mailSettings, syncMailbox } from './lib/jarvis-mail.mjs';
import { claimRun, netlifyShouldSkip } from './lib/schedules.mjs';

// Every 30 minutes: refresh the Email agent's mailbox snapshot. No Groq calls.
// Skips when neither Gmail (GMAIL_*) nor the command-center (JARVIS_EMAIL_URL, MCP_COMMAND_CENTER_TOKEN) is set, or JARVIS_EMAIL_SYNC=off.
// RUN_SCHEDULES_ON=vm: the VM runs this job and Netlify exits at once.
export default async () => {
  if (netlifyShouldSkip('jarvis-mail-sync')) return;
  try {
    if (!mailSettings().enabled) return console.log('JARVIS mail sync skipped');
    if (!(await claimRun('jarvis-mail-sync'))) return;
    const snapshot = await syncMailbox({ store: await openJarvisStore() });
    console.log('JARVIS mail sync', JSON.stringify({ messages: snapshot.messages.length, messagesAvailable: snapshot.messagesAvailable }));
  } catch (error) {
    console.log('JARVIS mail sync failed', error.message);
  }
};
export const config = { schedule: '*/30 * * * *' };
