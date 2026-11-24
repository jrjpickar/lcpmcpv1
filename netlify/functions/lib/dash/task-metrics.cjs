(function(root) {
  function summarize(tasks, { rep = '', include = () => true, inPeriod = () => true, now = Date.now() } = {}) {
    const rows = tasks.filter(t => (!rep || t.rep === rep) && include(t));
    const done = rows.filter(t => t.completed && t.completedAt && inPeriod(Date.parse(t.completedAt)));
    const overdue = rows.filter(t => !t.completed && t.dueDate && Date.parse(t.dueDate) < now).sort((a,b) => Date.parse(a.dueDate) - Date.parse(b.dueDate));
    // Set / edited: each task once. Set = created in the period. Edited = an
    // open task last updated in the period that was created earlier.
    // Completed tasks never count as edited (their last update is the
    // completion, already in Tasks completed).
    let set = 0, edited = 0;
    for (const t of rows) {
      const created = Date.parse(t.createdAt || '');
      if (Number.isFinite(created) && inPeriod(created)) { set++; continue; }
      const updated = Date.parse(t.updatedAt || '');
      if (!t.completed && Number.isFinite(updated) && inPeriod(updated) && (!Number.isFinite(created) || updated - created > 60000)) edited++;
    }
    return { set, edited, setEdited: set + edited, completed: done.length, estimated: done.filter(t => t.completionDateEstimated).length,
      undated: rows.filter(t => t.completed && !t.completedAt).length, overdue: overdue.length,
      oldest: overdue[0] || null, oldestMs: overdue.length ? now - Date.parse(overdue[0].dueDate) : 0 };
  }
  const api = { summarize };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.TaskMetrics = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
