// Where the always-on jobs run: RUN_SCHEDULES_ON=netlify (default) or vm. Set the same value on Netlify and in the VM .env.
// Netlify scheduled functions exit at once when it is vm. The VM server starts its timers only when it is exactly vm.
// With Supabase set (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) every run also claims a one-time lease per job and time slot,
// so even a misconfigured pair cannot post twice: the second claimant skips.
import { openJarvisStore } from './jarvis-store.mjs';

export const schedulesOn = (env = process.env) => (String(env.RUN_SCHEDULES_ON || 'netlify').trim().toLowerCase() === 'vm' ? 'vm' : 'netlify');

// For Netlify scheduled functions. Returns true (and logs) when the VM owns the jobs.
export function netlifyShouldSkip(job, env = process.env) {
  if (schedulesOn(env) !== 'vm') return false;
  console.log(job + ' skipped on Netlify: RUN_SCHEDULES_ON=vm');
  return true;
}

const pacific = now => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
}).formatToParts(new Date(now)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));

// Slot ids are the same on Netlify and the VM for the same run, whatever second each side fires on.
export function slotFor(job, now = Date.now()) {
  const p = pacific(now);
  const day = p.year + '-' + p.month + '-' + p.day;
  if (job === 'slack-briefing') return day;
  const step = job === 'jarvis-mail-sync' || job === 'dash-sync' ? 30 : 5;
  return day + 't' + p.hour + '-' + String(Math.floor(Number(p.minute) / step) * step).padStart(2, '0');
}

// One run per job and slot across Netlify and the VM. Without Supabase there is no shared store, so the flag alone decides.
export async function claimRun(job, { now = Date.now(), env = process.env, openStore = () => openJarvisStore(env), by = 'netlify' } = {}) {
  if (!(env.SUPABASE_URL?.trim() && env.SUPABASE_SERVICE_ROLE_KEY?.trim())) return true;
  try {
    const store = await openStore();
    const saved = await store.setJSON('lease/' + job + '/' + slotFor(job, now), { by, at: new Date(now).toISOString() }, { onlyIfNew: true });
    if (!saved.modified) console.log(job + ' skipped: this slot already ran elsewhere');
    return saved.modified;
  } catch (error) {
    console.log(job + ' lease unavailable, running on the flag alone:', error.message);
    return true;
  }
}

// VM timetable in Pacific time. Matches the Netlify crons: alerts every 5 minutes 9am to 9pm, mail every 30 minutes,
// briefing weekdays at 7:05 (Netlify fires at 15:05 UTC, which is 8:05 during daylight saving time; the VM stays at 7:05).
export function dueJobs(now = Date.now()) {
  const p = pacific(now);
  const hour = Number(p.hour), minute = Number(p.minute);
  const weekday = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day))).getUTCDay();
  const due = [];
  if (minute % 5 === 0 && hour >= 9 && hour < 21) due.push('alerts-scheduled');
  if (minute % 30 === 0) due.push('jarvis-mail-sync');
  // Dashboard data sync: minutes 7 and 37, 7am to 9pm; only minute 7 overnight (same as dash-sync-scheduled).
  if (minute % 30 === 7 && ((hour >= 7 && hour < 21) || minute === 7)) due.push('dash-sync');
  if (hour === 7 && minute === 5 && weekday >= 1 && weekday <= 5) due.push('slack-briefing');
  return due;
}
