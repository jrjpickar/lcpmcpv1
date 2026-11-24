import { ghl } from './_ghl.mjs';
import { reportingAgentId } from './_agent-aliases.mjs';
import { REPORTING_PHONES } from './_reporting-roster.mjs';
const iso = value => Number.isFinite(Date.parse(value || '')) ? new Date(value).toISOString() : null;
export function normalizeTask(task, agents = [], users = []) {
  const sourceUserId = typeof task.assignedTo === 'string' ? task.assignedTo : task.assignedTo?.id || '';
  const userId = reportingAgentId(sourceUserId);
  const completed = task.completed === true;
  const exact = iso(task.completedAt || task.dateCompleted || task.completedOn);
  const updated = iso(task.dateUpdated || task.updatedAt);
  const rep = Object.values(REPORTING_PHONES).find(a => a.id === userId)?.name || agents.find(a => reportingAgentId(a.ghlUserId) === userId)?.name || users.find(u => reportingAgentId(u.id) === userId)?.name || userId || 'Unassigned';
  return { id: task.id || task._id, title: String(task.title || task.body || 'Untitled task').slice(0, 500),
    contactId: task.contactId || '', userId, sourceUserId, rep, completed,
    completedAt: completed ? exact || updated : null,
    completionDateEstimated: completed && !exact && !!updated,
    dueDate: iso(task.dueDate), createdAt: iso(task.dateAdded || task.createdAt), updatedAt: updated };
}
export async function fetchTasks({ request = ghl, deadline = Date.now() + 240000, agents = [], users = [] } = {}) {
  if (!process.env.GHL_LOCATION_ID) throw new Error('Missing GHL_LOCATION_ID.');
  const all = new Map();
  // Fetch both states explicitly: an omitted completed filter can default to pending.
  for (const completed of [false, true]) {
    const seen = new Set();
    for (let skip = 0; ; skip += 100) {
      if (Date.now() > deadline || skip > 200000) throw new Error('Task refresh exceeded its budget; retaining the last complete list.');
      const payload = await request(`/locations/${encodeURIComponent(process.env.GHL_LOCATION_ID)}/tasks/search`, {
        method: 'POST', body: { completed, limit: 100, skip },
      });
      if (!Array.isArray(payload.tasks)) throw new Error('GHL task response is incomplete.');
      let added = 0;
      for (const task of payload.tasks) {
        const row = normalizeTask(task, agents, users);
        if (!row.id) throw new Error('GHL task is missing its ID.');
        if (!seen.has(row.id)) { seen.add(row.id); added++; }
        all.set(row.id, row);
      }
      if (payload.tasks.length < 100) break;
      if (!added) throw new Error('GHL task pagination repeated; retaining the last complete list.');
    }
  }
  return [...all.values()];
}
