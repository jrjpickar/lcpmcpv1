// JARVIS execution sandbox (ported from A2Z). Plans run against a throwaway in-memory SQLite copy of LCP aggregate data,
// inside a worker thread with a time and memory limit. Only SELECT queries and CREATE VIEW are executed.
// Module, schedule and refresh steps are recorded as staged changes for review. Nothing reaches production.
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

export const modules = ['kpis', 'calls', 'opportunities', 'sms', 'dials', 'signals', 'accounting', 'workflows', 'brain'];
export const actions = ['Create View', 'Run Query', 'Update Module', 'Schedule Refresh', 'Trigger Immediate Update'];
export const tableColumns = {
  kpis: ['metric', 'value', 'previous'],
  reps: ['rep', 'dials', 'connected', 'connect_rate', 'talk_minutes', 'calls_60s', 'hot', 'warm', 'qualified', 'qual_per_100_conv'],
  call_outcomes: ['outcome', 'count'],
  opps_by_city: ['city', 'count', 'value', 'avg_touches'],
  opps_by_zip: ['zip', 'count', 'value'],
  opps_by_period: ['period', 'count', 'value'],
  opps_by_weekday: ['weekday', 'count'],
  opps_by_touches: ['touches', 'count'],
  channels: ['channel', 'touches', 'contacts', 'engaged', 'qualified', 'per_qualified', 'contact_rate'],
  channel_reps: ['channel', 'rep', 'touches', 'contacts', 'qualified', 'per_qualified'],
  accounting: ['metric', 'value'],
  sources: ['source', 'status'],
};
const sandboxLimits = { steps: 8, checks: 5, sql: 2000, rows: 50, checkRows: 10, timeoutMs: 3000, planBytes: 12000 };
const ident = /^[a-z_][a-z0-9_]{0,40}$/i;
const forbidden = /\b(?:attach|detach|pragma|insert|update|delete|drop|alter|vacuum|reindex|analyze|trigger|recursive|load_extension|readfile|writefile|randomblob|zeroblob|fts\d?|virtual|sqlite_\w*|begin|commit|rollback|savepoint|release)\b/i;

export function catalogText() {
  return 'Sandbox tables (LCP aggregates, no seller names, phones or message text): ' + Object.entries(tableColumns).map(([name, cols]) => name + '(' + cols.join(', ') + ')').join('; ') + '. ' +
    'Step actions: "Create View" with sql "CREATE VIEW name AS SELECT ..."; "Run Query" with a SELECT sql; "Update Module" with module, field, source (table or view) and fieldName (a column of source); ' +
    '"Schedule Refresh" with a 5 field cron schedule (minute must be a fixed number, so at most hourly) and optional view; "Trigger Immediate Update" with module. ' +
    'Modules: ' + modules.join(', ') + '.';
}

// Removes string literals so keyword checks only see SQL. Rejects comments.
function scrub(sql) {
  if (/--|\/\*/.test(sql)) throw new Error('SQL comments are not allowed.');
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

export function checkSql(sql, kind) {
  if (typeof sql !== 'string' || !sql.trim() || sql.length > sandboxLimits.sql) throw new Error('SQL must be 1 to ' + sandboxLimits.sql + ' characters.');
  const body = scrub(sql).trim().replace(/;\s*$/, '');
  if (body.includes(';')) throw new Error('Only one SQL statement per step.');
  if (kind === 'view') {
    const match = /^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([a-z_][a-z0-9_]{0,40})\s+AS\s+((?:SELECT|WITH)\b[\s\S]*)$/i.exec(body);
    if (!match) throw new Error('Create View needs "CREATE VIEW name AS SELECT ...".');
    if (Object.hasOwn(tableColumns, match[1].toLowerCase())) throw new Error('A view cannot replace the base table ' + match[1] + '.');
    if (forbidden.test(match[2]) || /\b(?:create|replace)\b/i.test(match[2])) throw new Error('The view query uses a blocked keyword.');
    const original = sql.trim().replace(/;\s*$/, '');
    const select = original.slice(/^CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+[a-z_][a-z0-9_]{0,40}\s+AS\s+/i.exec(original)[0].length);
    return { view: match[1].toLowerCase(), sql: 'CREATE VIEW ' + match[1].toLowerCase() + ' AS ' + select };
  }
  if (!/^(?:SELECT|WITH)\b/i.test(body)) throw new Error('Queries must start with SELECT.');
  if (forbidden.test(body) || /\b(?:create|replace)\b/i.test(body)) throw new Error('The query uses a blocked keyword.');
  return { sql: sql.trim().replace(/;\s*$/, '') };
}

const str = (value, max) => typeof value === 'string' && value.trim() && value.length <= max;

function cron(value) {
  const fields = typeof value === 'string' ? value.trim().split(/\s+/) : [];
  if (fields.length !== 5 || !fields.every(field => /^[\d*,/-]+$/.test(field))) throw new Error('Schedule must be a 5 field cron expression.');
  if (!/^\d{1,2}$/.test(fields[0]) || Number(fields[0]) > 59) throw new Error('Schedule minute must be one fixed number, so refreshes run at most hourly.');
  return fields.join(' ');
}

// Static validation. Returns { ok, errors, warnings, plan, hash }. No SQL runs here.
export function validatePlan(input) {
  const errors = [], warnings = [];
  const plan = { task: '', description: '', steps: [], validation: [] };
  const done = () => {
    const ok = !errors.length;
    return { ok, errors, warnings, plan, hash: ok ? createHash('sha256').update(JSON.stringify(plan)).digest('hex') : null };
  };
  if (!input || typeof input !== 'object' || Array.isArray(input)) { errors.push('The plan must be a JSON object.'); return done(); }
  if (Buffer.byteLength(JSON.stringify(input)) > sandboxLimits.planBytes) { errors.push('The plan exceeds 12 KB.'); return done(); }
  for (const key of Object.keys(input)) {
    if (key === 'report') warnings.push('The report field was ignored. The sandbox reads current LCP data itself.');
    else if (!['task', 'description', 'steps', 'validation'].includes(key)) warnings.push('Unknown field "' + key + '" was ignored.');
  }
  if (str(input.task, 120)) plan.task = input.task.trim();
  else errors.push('task must be 1 to 120 characters.');
  if (input.description !== undefined) {
    if (typeof input.description === 'string' && input.description.length <= 1000) plan.description = input.description.trim();
    else errors.push('description must be up to 1000 characters.');
  }
  if (!Array.isArray(input.steps) || !input.steps.length || input.steps.length > sandboxLimits.steps) {
    errors.push('steps must contain 1 to ' + sandboxLimits.steps + ' actions.');
    return done();
  }
  const views = new Set();
  const bound = new Set();
  input.steps.forEach((step, index) => {
    const label = 'Step ' + (index + 1) + ': ';
    const action = actions.find(name => name.toLowerCase() === String(step?.action || '').trim().toLowerCase());
    if (!action) { errors.push(label + 'unsupported action "' + String(step?.action ?? '').slice(0, 40) + '". Allowed: ' + actions.join(', ') + '.'); return; }
    try {
      if (action === 'Create View') {
        const { view, sql } = checkSql(step.sql, 'view');
        views.add(view);
        plan.steps.push({ action, view, sql });
      } else if (action === 'Run Query') {
        plan.steps.push({ action, sql: checkSql(step.sql, 'select').sql });
      } else if (action === 'Update Module') {
        const module = String(step.module || '').trim().toLowerCase();
        if (!modules.includes(module)) throw new Error('unknown module "' + String(step.module ?? '').slice(0, 40) + '". Modules: ' + modules.join(', ') + '.');
        if (!ident.test(step.field || '') || !ident.test(step.fieldName || '') || !ident.test(step.source || '')) throw new Error('field, source and fieldName must be simple names.');
        const source = step.source.toLowerCase();
        if (!views.has(source) && !Object.hasOwn(tableColumns, source)) throw new Error('source "' + step.source + '" is not a sandbox table or a view created earlier in this plan.');
        if (Object.hasOwn(tableColumns, source) && !tableColumns[source].includes(step.fieldName.toLowerCase())) throw new Error('column "' + step.fieldName + '" is not in ' + source + '.');
        bound.add(module);
        plan.steps.push({ action, module, field: step.field, source, fieldName: step.fieldName.toLowerCase() });
      } else if (action === 'Schedule Refresh') {
        const schedule = cron(step.schedule);
        const view = step.view === undefined ? (views.size === 1 ? [...views][0] : null) : String(step.view).toLowerCase();
        if (!view || !views.has(view)) throw new Error('name the view to refresh (a view created earlier in this plan).');
        if (step.description !== undefined && !str(step.description, 200)) throw new Error('description must be up to 200 characters.');
        plan.steps.push({ action, schedule, view, ...(step.description ? { description: step.description.trim() } : {}) });
      } else {
        const module = String(step.module || '').trim().toLowerCase();
        if (!modules.includes(module)) throw new Error('unknown module "' + String(step.module ?? '').slice(0, 40) + '".');
        if (!bound.has(module)) warnings.push(label + 'module ' + module + ' has no binding in this plan. The update shows its current definition.');
        plan.steps.push({ action, module });
      }
    } catch (error) {
      errors.push(label + error.message);
    }
  });
  const checks = input.validation ?? [];
  if (!Array.isArray(checks) || checks.length > sandboxLimits.checks) errors.push('validation must have up to ' + sandboxLimits.checks + ' checks.');
  else checks.forEach((check, index) => {
    try {
      if (!str(check?.check, 120)) throw new Error('check name must be 1 to 120 characters.');
      plan.validation.push({ check: check.check.trim(), query: checkSql(check.query, 'select').sql });
    } catch (error) {
      errors.push('Check ' + (index + 1) + ': ' + error.message);
    }
  });
  return done();
}

// Aggregate tables only. Seller names, phones, addresses and message bodies never enter the sandbox.
const num = value => (typeof value === 'number' && Number.isFinite(value) ? value : null);
export function sandboxTables(report) {
  const r = report || {};
  const previous = r.previous?.kpis || {};
  const channel = (name, c) => (c ? [[name, num(c.touches), num(c.contactsTouched), num(c.engaged), num(c.qualified), num(c.perQualified), num(c.contactRate)]] : []);
  const channelReps = (name, c) => (c?.byRep || []).map(x => [name, String(x.rep), num(x.touches), num(x.contacts), num(x.qualified), num(x.perQualified)]);
  const acc = r.accounting?.connected ? r.accounting : null;
  return {
    kpis: Object.entries(r.kpis || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => [k, v, num(previous[k])]),
    reps: (r.callsByUser?.rows || []).map(x => [String(x.rep), num(x.dials), num(x.connected), num(x.connectRate), num(x.talkMinutes), num(x.over60), num(x.hot), num(x.warm), num(x.qualified), num(x.qualPer100Conv)]),
    call_outcomes: (r.callsByUser?.totals?.outcomes || []).map(x => [String(x.label || x.key), num(x.count)]),
    opps_by_city: (r.opportunities?.byCity || []).map(x => [String(x.key), num(x.count), num(x.value), num(x.avgTouches)]),
    opps_by_zip: (r.opportunities?.byZip || []).map(x => [String(x.key), num(x.count), num(x.value)]),
    opps_by_period: (r.opportunities?.byPeriod || []).map(x => [String(x.key), num(x.count), num(x.value)]),
    opps_by_weekday: (r.opportunities?.byWeekday || []).map(x => [String(x.key), num(x.count)]),
    opps_by_touches: (r.opportunities?.byTouches || []).map(x => [String(x.key), num(x.count)]),
    channels: [...channel('sms', r.smsToQualified), ...channel('dials', r.dialsToQualified)],
    channel_reps: [...channelReps('sms', r.smsToQualified), ...channelReps('dials', r.dialsToQualified)],
    accounting: acc ? ['revenue', 'net', 'leadGen', 'dealCosts', 'opex', 'feesPending', 'emdAtRisk', 'apOwed', 'leadGenPerQualified', 'avgDaysToClose'].map(k => [k, num(acc[k])]) : [],
    sources: Object.entries(r.sources || {}).filter(([k, v]) => typeof v === 'boolean' || typeof v === 'string').filter(([k]) => !['label', 'loadedAt'].includes(k)).map(([k, v]) => [k, String(v)]),
  };
}

// Runs inside the worker. CommonJS because eval workers are not modules.
const workerSource = `
const { parentPort, workerData } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const { plan, tables, columns, limits } = workerData;
const db = new DatabaseSync(':memory:');
const safe = v => typeof v === 'bigint' ? Number(v) : v;
const rows = (sql, max) => db.prepare(sql).all().slice(0, max).map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, safe(v)])));
const out = { steps: [], checks: [], staged: [] };
try {
  for (const [name, cols] of Object.entries(columns)) {
    db.exec('CREATE TABLE ' + name + ' (' + cols.join(', ') + ')');
    const insert = db.prepare('INSERT INTO ' + name + ' VALUES (' + cols.map(() => '?').join(', ') + ')');
    for (const row of tables[name] || []) insert.run(...row);
  }
  const bindings = {};
  for (const step of plan.steps) {
    try {
      if (step.action === 'Create View') {
        db.exec('DROP VIEW IF EXISTS ' + step.view);
        db.exec(step.sql);
        out.steps.push({ action: step.action, ok: true, detail: 'View ' + step.view + ' created with ' + db.prepare('SELECT COUNT(*) AS n FROM ' + step.view).get().n + ' rows.', rows: rows('SELECT * FROM ' + step.view, 10) });
      } else if (step.action === 'Run Query') {
        const result = rows(step.sql, limits.rows);
        out.steps.push({ action: step.action, ok: true, detail: result.length + ' rows (max ' + limits.rows + ').', rows: result });
      } else if (step.action === 'Update Module') {
        const cols = db.prepare('SELECT * FROM ' + step.source + ' LIMIT 1').columns().map(c => c.name.toLowerCase());
        if (!cols.includes(step.fieldName)) throw new Error('Column ' + step.fieldName + ' is not in ' + step.source + '.');
        bindings[step.module] = step;
        out.staged.push({ type: 'module-binding', module: step.module, field: step.field, source: step.source, fieldName: step.fieldName });
        out.steps.push({ action: step.action, ok: true, detail: 'Staged: ' + step.module + '.' + step.field + ' would read ' + step.source + '.' + step.fieldName + '. Not applied.' });
      } else if (step.action === 'Schedule Refresh') {
        out.staged.push({ type: 'refresh-schedule', view: step.view, schedule: step.schedule });
        out.steps.push({ action: step.action, ok: true, detail: 'Staged: refresh ' + step.view + ' on "' + step.schedule + '". No job was scheduled.' });
      } else {
        const b = bindings[step.module];
        const preview = b ? rows('SELECT * FROM ' + b.source, 10) : [];
        out.steps.push({ action: step.action, ok: true, detail: b ? 'Preview of ' + step.module + ' with the staged binding. The live dashboard is unchanged.' : 'No staged binding for ' + step.module + '. Nothing to preview.', rows: preview });
      }
    } catch (error) {
      out.steps.push({ action: step.action, ok: false, detail: String(error.message).slice(0, 300) });
      break;
    }
  }
  if (out.steps.every(s => s.ok)) for (const check of plan.validation) {
    try {
      const result = rows(check.query, limits.checkRows);
      out.checks.push({ check: check.check, ok: result.length > 0, detail: result.length ? result.length + ' rows returned.' : 'No rows returned.', rows: result });
    } catch (error) {
      out.checks.push({ check: check.check, ok: false, detail: String(error.message).slice(0, 300) });
    }
  }
} catch (error) {
  out.error = String(error.message).slice(0, 300);
} finally {
  db.close();
}
parentPort.postMessage(out);
`;

export function runPlan(plan, tables, { timeoutMs = sandboxLimits.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerSource, {
      eval: true,
      workerData: { plan, tables, columns: tableColumns, limits: sandboxLimits },
      resourceLimits: { maxOldGenerationSizeMb: 64, maxYoungGenerationSizeMb: 16 },
      env: {}, stdout: true, stderr: true,
    });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(Object.assign(new Error('Sandbox time limit reached (' + timeoutMs / 1000 + ' s). Simplify the SQL.'), { agentStatus: 422 }));
    }, timeoutMs);
    worker.once('message', out => {
      clearTimeout(timer);
      worker.terminate();
      const passed = !out.error && out.steps.every(step => step.ok) && out.checks.every(check => check.ok);
      resolve({ ...out, outcome: passed ? 'passed' : 'failed', applied: false });
    });
    worker.once('error', error => {
      clearTimeout(timer);
      reject(Object.assign(new Error('Sandbox stopped: ' + String(error.message).slice(0, 200)), { agentStatus: 422 }));
    });
  });
}

export function summarize(checked) {
  if (!checked.ok) return 'The plan was not accepted:\n' + checked.errors.map(item => '- ' + item).join('\n');
  return 'Plan "' + checked.plan.task + '" passed validation with ' + checked.plan.steps.length + ' steps and ' + checked.plan.validation.length +
    ' checks. Select Run in sandbox to execute it on a throwaway copy of LCP data. Nothing is applied to production.' +
    (checked.warnings.length ? '\n' + checked.warnings.map(item => '- ' + item).join('\n') : '');
}
