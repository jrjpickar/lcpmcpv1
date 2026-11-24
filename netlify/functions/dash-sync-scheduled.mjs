// Starts the dashboard data sync. Every 30 minutes from 7am to 9pm Pacific, hourly overnight (the full contact pass runs 1am to 5am).
// Minutes 7 and 37 keep it off the :00 slot the data dashboard and dialer use. RUN_SCHEDULES_ON=vm: the VM runs it instead.
import { claimRun, netlifyShouldSkip } from './lib/schedules.mjs';
import { syncConfigured } from './lib/dash-sync.mjs';

export function shouldRun(now = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).filter(x => x.type !== 'literal').map(x => [x.type, Number(x.value)]));
  const hour = p.hour % 24;
  return (hour >= 7 && hour < 21) || p.minute < 30;
}

export default async () => {
  if (netlifyShouldSkip('dash-sync')) return new Response(null, { status: 204 });
  if (!syncConfigured() || !process.env.DASH_SYNC_SECRET || !process.env.URL || !shouldRun()) return new Response(null, { status: 204 });
  if (!(await claimRun('dash-sync'))) return new Response(null, { status: 204 });
  await fetch(`${process.env.URL}/.netlify/functions/dash-sync-background`, { method: 'POST', headers: { 'x-sync-secret': process.env.DASH_SYNC_SECRET }, signal: AbortSignal.timeout(10000) }).catch(error => console.log('dash sync kick failed', error.message));
  return new Response(null, { status: 204 });
};
export const config = { schedule: '7,37 * * * *' };
