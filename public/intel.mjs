// Intel control room for the Studio / Brain: knowledge sources, research with citations, memory, documents, tools and approvals,
// task and error history, model usage and cost, dev tasks, system health. Talks to /api/intel with the Studio key.
const SOURCE_LABEL = { live: 'Live MCP data', internal: 'Internal docs', memory: 'Memory', web: 'Web research', model: 'Model reasoning' };
const KINDS = ['decision', 'architecture', 'preference', 'instruction', 'bug', 'fix', 'deployment', 'research', 'task', 'outcome', 'todo'];

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) if (child !== null && child !== undefined && child !== false) node.append(child.nodeType ? child : String(child));
  return node;
}
const badge = (text, tone = '') => el('span', { className: 'intel-badge ' + tone }, text);
const tone = status => (['ok', 'done', 'checked', 'validated', 'connected'].includes(status) ? 'good' : ['failed', 'unavailable', 'issues', 'error', 'failed-checks'].includes(status) ? 'bad' : 'warn');
const fmt = n => (Number.isFinite(n) ? n.toLocaleString() : '—');
const when = iso => (iso ? new Date(iso).toLocaleString() : '');

export function createIntelPanel({ key }) {
  const root = el('section', { className: 'card intel' });
  const status = el('p', { className: 'studio-status', role: 'status' });
  async function api(view, body) {
    const headers = { 'x-lcp-studio-key': key() };
    if (body) headers['content-type'] = 'application/json';
    const response = await fetch('/api/intel' + (body ? '' : '?' + new URLSearchParams(view)), { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
    const data = await response.json().catch(() => ({}));
    if (!response.ok && response.status !== 202) throw Object.assign(new Error(data.error || 'Request failed (HTTP ' + response.status + ').'), { data });
    return data;
  }
  const section = (title, open = false) => { const body = el('div', { className: 'intel-body' }); const d = el('details', { open }, el('summary', {}, title), body); return { d, body }; };

  const health = section('System health and knowledge sources', true);
  const ask = section('Ask with sources');
  const mem = section('Memory');
  const docs = section('Internal documents');
  const tools = section('Tool registry and approvals');
  const history = section('Tasks, errors and audit');
  const usage = section('Model usage and estimated cost');
  const dev = section('Development tasks (sandboxed, never deployed)');

  function renderStatus(s) {
    const src = s.knowledgeSources;
    health.body.replaceChildren(
      el('div', { className: 'intel-grid' }, Object.entries(src).map(([name, info]) => el('div', { className: 'intel-tile' }, el('strong', {}, SOURCE_LABEL[name] || name), badge(info.status, tone(info.status)),
        el('small', {}, name === 'internal' ? Object.entries(info.scopes || {}).map(([sc, v]) => sc + ': ' + v.documents + ' docs, ' + v.chunks + ' chunks').join(' · ') + ' · ' + (info.embeddings?.provider ? 'semantic (' + info.embeddings.provider + ')' : 'keyword only')
          : name === 'web' ? (info.provider ? 'SearXNG ' + info.searxng : 'SearXNG not set') + ' + ' + info.keyless.join(', ') : name === 'memory' ? info.total + ' items, ' + info.open + ' open' : info.note)))),
      el('h4', {}, 'Model providers'),
      el('div', { className: 'intel-grid' }, Object.entries(s.providers).map(([name, p]) => el('div', { className: 'intel-tile' }, el('strong', {}, name), badge(p.configured ? 'configured' : 'not set', p.configured ? 'good' : 'warn'),
        s.cooling && Object.keys(s.cooling).some(id => id.startsWith(name + ':')) ? badge('cooling down', 'warn') : null))),
      el('p', { className: 'meta' }, 'Storage: ' + s.storage + ' · Schedules: ' + s.schedules + ' · Scopes: ' + s.scopes.join(', ') + ' · Tools: ' + s.tools.available + ' of ' + s.tools.total + ' available, ' + s.tools.needApproval + ' need approval'),
      s.health ? el('ul', { className: 'intel-list' }, Object.entries(s.health).map(([name, h]) => el('li', {}, badge(h.status, tone(h.status)), ' ' + name + (h.detail ? ': ' + h.detail : '')))) : null,
    );
    renderUsage(s.usage);
    history.body.replaceChildren(el('ul', { className: 'intel-list' }, (s.tasks || []).map(t => el('li', {}, badge(t.status, tone(t.status)), ' ' + t.objective, el('small', {}, ' · ' + t.taskClass + ' · ' + (t.sources || []).map(x => SOURCE_LABEL[x] || x).join(', ') + (t.errors ? ' · ' + t.errors + ' failed steps' : '') + ' · ' + when(t.createdAt))))),
      el('button', { type: 'button', className: 'btn', onclick: loadAudit }, 'Show audit log'), el('div', { id: 'intelAudit' }));
    renderDev(s.dev);
  }

  function renderUsage(u) {
    const rows = Object.entries(u.last7Days || {});
    usage.body.replaceChildren(
      el('p', { className: 'meta' }, 'Estimated: $' + (u.estimatedUsd?.today ?? 0) + ' today, $' + (u.estimatedUsd?.last7Days ?? 0) + ' last 7 days. ' + u.pricing),
      rows.length ? el('table', { className: 'intel-table' }, el('tr', {}, ['Model', 'Calls 7d', 'Errors', 'Tokens in', 'Tokens out', 'Avg ms', 'Est. $'].map(h => el('th', {}, h))),
        rows.map(([model, t]) => el('tr', {}, [model, fmt(t.calls), fmt(t.errors), fmt(t.inTokens), fmt(t.outTokens), fmt(t.avgMs), t.priced ? '$' + t.estimatedUsd : '$0 (free tier)'].map(c => el('td', {}, c)))))
        : el('p', { className: 'meta' }, 'No model calls logged yet.'));
  }

  async function loadAudit() {
    const { rows } = await api({ view: 'audit' });
    root.querySelector('#intelAudit').replaceChildren(el('ul', { className: 'intel-list' }, rows.map(r => el('li', {}, when(r.at) + ' · ' + r.actor + ' · ' + r.action + (r.target ? ' · ' + r.target : '') + ' · ', badge(r.result || '', tone(r.result)), r.detail ? el('small', {}, ' ' + r.detail) : null))));
  }

  // Ask with sources
  const objective = el('textarea', { rows: 3, maxLength: 2000, placeholder: 'Ask anything. Live data, internal docs, memory and the web are searched and cited.' });
  const webBox = el('input', { type: 'checkbox', checked: true });
  const deepBox = el('input', { type: 'checkbox' });
  const answer = el('div', { className: 'intel-answer' });
  function renderTask(t) {
    if (t.status === 'queued' || t.status === 'running') { answer.replaceChildren(el('p', { className: 'meta' }, 'Deep task ' + t.status + '. Checking again in 5 seconds.')); setTimeout(() => api({ view: 'task', id: t.id }).then(renderTask).catch(() => {}), 5000); return; }
    answer.replaceChildren(
      el('div', {}, (t.provenance?.types || ['model']).map(x => badge(SOURCE_LABEL[x] || x, x === 'model' ? 'warn' : 'good')), badge('verification: ' + (t.verification?.status || 'none'), tone(t.verification?.status)), t.model ? badge(t.model) : null),
      t.error ? el('p', { className: 'studio-status' }, t.error) : el('div', { className: 'intel-text' }, t.answer || ''),
      t.assumptions?.length ? el('p', { className: 'meta' }, 'Assumptions: ' + t.assumptions.join('; ')) : null,
      t.outstanding?.length ? el('p', { className: 'meta' }, 'Outstanding: ' + t.outstanding.join('; ')) : null,
      t.sources?.length ? el('ol', { className: 'intel-cites' }, t.sources.map(c => el('li', {}, '[' + c.id + '] ', badge(SOURCE_LABEL[c.type] || c.type), ' ',
        c.url && /^https:\/\//.test(c.url) ? el('a', { href: c.url, target: '_blank', rel: 'noopener noreferrer' }, c.title || c.url) : (c.title || c.path || '')))) : null,
      el('details', {}, el('summary', {}, 'Steps (' + (t.ms || 0) + ' ms, ' + (t.usage?.totalTokens || 0) + ' tokens)'), el('ul', { className: 'intel-list' },
        (t.steps || []).map(s => el('li', {}, badge(s.status, tone(s.status)), ' ' + s.name + ' ' + (s.ms ?? '') + ' ms' + (s.error ? ': ' + s.error : ''))),
        (t.attempts || []).map(a => el('li', {}, badge(a.ok ? 'ok' : a.skipped ? 'skipped' : 'failed', a.ok ? 'good' : 'warn'), ' ' + a.model + (a.error ? ': ' + a.error : a.skipped ? ': ' + a.skipped : ''))),
        (t.verification?.checks || []).map(c => el('li', {}, badge(c.ok === true ? 'pass' : c.ok === false ? 'fail' : 'skipped', c.ok ? 'good' : c.ok === false ? 'bad' : 'warn'), ' ' + c.check + ': ' + c.detail)))),
    );
  }
  ask.body.append(objective, el('div', { className: 'studio-row' }, el('label', {}, webBox, ' Search the web'), el('label', {}, deepBox, ' Deep (background, verified)'),
    el('button', { type: 'button', className: 'btn', async onclick() {
      answer.replaceChildren(el('p', { className: 'meta' }, 'Working...'));
      try { renderTask(await api(null, { op: 'research', objective: objective.value, web: webBox.checked ? undefined : false, deep: deepBox.checked })); }
      catch (error) { answer.replaceChildren(el('p', { className: 'studio-status' }, error.message)); }
    } }, 'Ask')), answer);

  // Memory
  const memQuery = el('input', { type: 'search', placeholder: 'Search memory' });
  const memList = el('ul', { className: 'intel-list' });
  const memKind = el('select', {}, KINDS.map(k => el('option', { value: k }, k)));
  const memScope = el('select', {}, ['lcp', 'shared', 'a2z'].map(k => el('option', { value: k }, k)));
  const memText = el('input', { type: 'text', maxLength: 1200, placeholder: 'Decision, preference, bug, fix, deployment note... never secrets' });
  async function loadMemory() {
    const { items } = await api({ view: 'memory', q: memQuery.value });
    memList.replaceChildren(...items.map(item => el('li', {}, badge(item.kind), item.status ? badge(item.status, item.status === 'open' ? 'warn' : 'good') : null, badge(item.scope), ' ' + item.text,
      el('small', {}, ' · ' + when(item.updatedAt) + (item.expiresAt ? ' · expires ' + when(item.expiresAt) : '')),
      el('button', { type: 'button', className: 'btn', async onclick() { await api(null, { op: 'memory.delete', id: item.id, scope: item.scope }); loadMemory(); } }, 'Delete'))));
    if (!items.length) memList.replaceChildren(el('li', { className: 'meta' }, 'No matching memory.'));
  }
  mem.body.append(el('div', { className: 'studio-row' }, memQuery, el('button', { type: 'button', className: 'btn', onclick: () => loadMemory().catch(e => { status.textContent = e.message; }) }, 'Search')), memList,
    el('div', { className: 'studio-row' }, memKind, memScope, memText, el('button', { type: 'button', className: 'btn', async onclick() {
      try { const r = await api(null, { op: 'memory.add', kind: memKind.value, scope: memScope.value, text: memText.value }); status.textContent = 'Memory ' + r.status + '.'; memText.value = ''; loadMemory(); }
      catch (error) { status.textContent = error.message; }
    } }, 'Save')),
    el('button', { type: 'button', className: 'btn', async onclick() { const r = await api(null, { op: 'memory.purge', scope: memScope.value }); status.textContent = r.purged + ' expired items purged.'; } }, 'Purge expired'));

  // Documents
  const docQuery = el('input', { type: 'search', placeholder: 'Search internal documents' });
  const docResults = el('div');
  const upload = el('input', { type: 'file', multiple: true, accept: '.md,.txt,.csv,.tsv,.json,.html,.htm,.pdf,.js,.mjs,.ts,.py,.sql,.yml,.yaml,.toml' });
  const docScope = el('select', {}, ['lcp', 'shared', 'a2z'].map(k => el('option', { value: k }, k)));
  const repo = el('input', { type: 'text', placeholder: 'owner/repo (must be in INTEL_REPOS)' });
  docs.body.append(el('div', { className: 'studio-row' }, docQuery, el('button', { type: 'button', className: 'btn', async onclick() {
    try {
      const r = await api({ view: 'knowledge', q: docQuery.value });
      docResults.replaceChildren(el('p', { className: 'meta' }, r.results.length + ' passages · ' + (r.mode || 'keyword') + ' · ' + r.searched + ' chunks searched'),
        el('ol', { className: 'intel-cites' }, r.results.map(x => el('li', {}, el('strong', {}, x.scope + ':' + x.path), x.heading ? ' · ' + x.heading : '', ' · score ' + x.score, el('div', { className: 'meta' }, x.text.slice(0, 400))))));
    } catch (error) { docResults.replaceChildren(el('p', { className: 'studio-status' }, error.message)); }
  } }, 'Search')), docResults,
  el('div', { className: 'studio-row' }, upload, docScope, el('button', { type: 'button', className: 'btn', async onclick() {
    const files = [...upload.files].slice(0, 20);
    if (!files.length) return;
    const documents = await Promise.all(files.map(async file => {
      if (/\.pdf$/i.test(file.name)) { const bytes = new Uint8Array(await file.arrayBuffer()); let bin = ''; for (let i = 0; i < bytes.length; i += 32768) bin += String.fromCharCode(...bytes.subarray(i, i + 32768)); return { path: file.name, content: btoa(bin), encoding: 'base64' }; }
      return { path: file.name, content: await file.text() };
    }));
    try { const r = await api(null, { op: 'knowledge.ingest', scope: docScope.value, documents }); status.textContent = r.results.map(x => x.path + ': ' + x.status + (x.error ? ' (' + x.error + ')' : '')).join(' · '); refresh(); }
    catch (error) { status.textContent = error.message; }
  } }, 'Index files')),
  el('div', { className: 'studio-row' }, repo, el('button', { type: 'button', className: 'btn', async onclick() {
    try { await api(null, { op: 'knowledge.sync', repo: repo.value.trim(), scope: docScope.value }); status.textContent = 'Indexing ' + repo.value + ' in the background. Unchanged files are skipped, removed files are pruned.'; }
    catch (error) { status.textContent = error.message; }
  } }, 'Index GitHub repo')));

  // Tools
  async function loadTools() {
    const r = await api({ view: 'tools', fresh: '1' });
    tools.body.replaceChildren(
      el('table', { className: 'intel-table' }, el('tr', {}, ['Tool', 'Source', 'Capability', 'Risk', 'Status'].map(h => el('th', {}, h))),
        r.tools.map(t => el('tr', {}, el('td', { title: t.description }, t.name), el('td', {}, t.source), el('td', {}, t.capability), el('td', {}, badge(t.risk, t.risk === 'read' ? 'good' : 'warn')),
          el('td', {}, t.available ? (t.approval === 'none' ? 'ready' : 'needs approval') : badge(t.reason || 'unavailable', 'bad'))))),
      r.servers.length ? el('ul', { className: 'intel-list' }, r.servers.map(sv => el('li', {}, badge(sv.status, tone(sv.status)), ' MCP server ' + sv.server + ' (' + sv.scope + '): ' + sv.tools.length + ' tools' + (sv.error ? ' · ' + sv.error : '')))) : el('p', { className: 'meta' }, 'No external MCP servers configured (INTEL_MCP_SERVERS).'),
      toolRunner);
  }
  const toolName = el('input', { type: 'text', placeholder: 'tool name' });
  const toolArgs = el('textarea', { rows: 2, placeholder: '{"query": "..."}' });
  const toolOut = el('pre', { className: 'intel-pre' });
  const toolRunner = el('div', {}, el('h4', {}, 'Run a tool'), el('div', { className: 'studio-row' }, toolName, toolArgs, el('button', { type: 'button', className: 'btn', async onclick() {
    let args;
    try { args = JSON.parse(toolArgs.value || '{}'); } catch { toolOut.textContent = 'Arguments must be JSON.'; return; }
    try {
      const r = await api(null, { op: 'tool.run', tool: toolName.value.trim(), args });
      if (r.status === 'approval_required') {
        toolOut.replaceChildren(el('span', {}, 'Approval required (' + r.approval.risk + ') for ' + r.approval.tool + ' with ' + JSON.stringify(r.approval.args) + '. Expires ' + when(r.approval.expiresAt) + '. '),
          el('button', { type: 'button', className: 'btn', async onclick() { toolOut.textContent = JSON.stringify(await api(null, { op: 'tool.approve', id: r.approval.id }), null, 1).slice(0, 6000); } }, 'Approve and run'),
          el('button', { type: 'button', className: 'btn', async onclick() { toolOut.textContent = JSON.stringify(await api(null, { op: 'tool.approve', id: r.approval.id, decision: 'reject' })); } }, 'Reject'));
      } else toolOut.textContent = JSON.stringify(r, null, 1).slice(0, 6000);
    } catch (error) { toolOut.textContent = error.message + (error.data?.errors ? '\n' + error.data.errors.join('\n') : ''); }
  } }, 'Run')), toolOut);

  // Dev tasks
  const devRepo = el('select');
  const devObjective = el('textarea', { rows: 2, maxLength: 2000, placeholder: 'What to change or fix. The VM runner edits an isolated copy, runs tests and returns a patch ZIP.' });
  const devList = el('ul', { className: 'intel-list' });
  async function download(id) {
    const response = await fetch('/api/intel?' + new URLSearchParams({ view: 'artifact', id, format: 'zip' }), { headers: { 'x-lcp-studio-key': key() } });
    if (!response.ok) { status.textContent = 'No artifact available.'; return; }
    const url = URL.createObjectURL(await response.blob());
    el('a', { href: url, download: 'dev-' + id.slice(0, 8) + '.zip' }).click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  function renderDev(d) {
    devRepo.replaceChildren(...(d.repos.length ? d.repos.map(r => el('option', { value: r }, r)) : [el('option', { value: '' }, 'Set DEV_REPOS')]));
    devList.replaceChildren(...d.tasks.map(t => el('li', {}, badge(t.status, tone(t.status)), ' ' + t.repo + ': ' + t.objective, el('small', {}, ' · ' + when(t.createdAt)),
      ['validated', 'failed-checks', 'unvalidated'].includes(t.status) ? el('button', { type: 'button', className: 'btn', onclick: () => download(t.id) }, 'Download patch ZIP') : null,
      ['queued', 'running'].includes(t.status) ? el('button', { type: 'button', className: 'btn', async onclick() { await api(null, { op: 'dev.cancel', id: t.id }); refresh(); } }, 'Cancel') : null)));
  }
  dev.body.append(el('div', { className: 'studio-row' }, devRepo, devObjective, el('button', { type: 'button', className: 'btn', async onclick() {
    try { const r = await api(null, { op: 'dev.create', repo: devRepo.value, objective: devObjective.value }); status.textContent = r.note; devObjective.value = ''; refresh(); }
    catch (error) { status.textContent = error.message; }
  } }, 'Queue task')), devList);
  tools.d.addEventListener('toggle', () => { if (tools.d.open) loadTools().catch(e => { status.textContent = e.message; }); });
  mem.d.addEventListener('toggle', () => { if (mem.d.open) loadMemory().catch(e => { status.textContent = e.message; }); });

  async function refresh() {
    try { renderStatus(await api({ view: 'status' })); status.textContent = 'Updated ' + new Date().toLocaleTimeString() + '.'; }
    catch (error) { status.textContent = error.message; }
  }
  root.append(el('div', { className: 'card-h' }, el('h2', {}, 'JARVIS Intel'), el('button', { type: 'button', className: 'btn', onclick: refresh }, 'Refresh')), status,
    health.d, ask.d, mem.d, docs.d, tools.d, history.d, usage.d, dev.d);
  root.refresh = refresh;
  return root;
}
