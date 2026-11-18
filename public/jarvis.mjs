import { brainEditMessage, brainHealthIntent, formatBrainHealth } from './jarvis-intent.mjs';

export const agents = {
  systems: 'Systems and KPIs',
  market: 'Market news and improvement',
  build: 'Build developer → QC developer',
  qc: 'QC developer',
};

const greetings = {
  systems: 'Systems and KPIs online. Ask about coverage, KPI changes, or what to fix first.',
  market: 'Market desk online. Ask how current Fed and Census news affects acquisitions and seller outreach.',
  build: 'Build developer online. Describe a dashboard card or panel and QC will check it before you import it.',
  qc: 'QC developer online. Ask me to review the current Studio draft modules.',
};

const suggestions = {
  systems: ['Review KPI changes and identify the top three actions.', 'Which source has the weakest coverage right now?', 'Compare this period to the previous one.'],
  market: ['Summarize the implications for seller outreach in my market.', 'What do the latest Fed releases mean for buyer financing?'],
  build: ['Build a Brain panel with HighLevel opportunities, a trend, and live system health.', 'Add a Dials KPI to Sales.'],
  qc: ['Check whether the current modules display the intended KPIs and contain clear instructions.'],
};

const sourceLabels = { manual: 'Instruction', correction: 'Correction', praise: 'Keep doing' };

function node(tag, properties, ...children) {
  const result = Object.assign(document.createElement(tag), properties);
  result.append(...children.filter(child => child !== null && child !== undefined && child !== false));
  return result;
}

// Safe light formatting: bullets, numbered lists and **bold**. Text nodes only.
function inline(text) {
  const parts = [];
  const pattern = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (let match; (match = pattern.exec(text));) {
    parts.push(text.slice(last, match.index), node('strong', {}, match[1]));
    last = pattern.lastIndex;
  }
  parts.push(text.slice(last));
  return parts.filter(part => part !== '');
}

function formatted(text) {
  const box = node('div', { className: 'jarvis-text' });
  let list = null;
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const bullet = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      const ordered = /^\s*\d/.test(line);
      if (!list || (list.tagName === 'OL') !== ordered) box.append(list = node(ordered ? 'ol' : 'ul', {}));
      list.append(node('li', {}, ...inline(bullet[1])));
      continue;
    }
    list = null;
    if (!line.trim()) continue;
    const heading = /^#{1,4}\s+(.*)$/.exec(line);
    box.append(heading ? node('p', { className: 'jarvis-heading' }, ...inline(heading[1])) : node('p', {}, ...inline(line)));
  }
  return box;
}

export function createJarvisPanel({ key, filters, brainHealth, openBrain, draftModules, importModules, previousTasks = new Map() }) {
  let role = 'systems';
  let threadId = null;
  let messages = [];
  let threads = [];
  let learned = null;
  let busy = false;
  let loadToken = 0;

  async function call(path, options = {}) {
    const headers = { 'x-lcp-studio-key': key() };
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'JARVIS request failed.'), { status: response.status });
    return result;
  }
  const memoryCall = body => call('/api/jarvis-memory', { method: 'POST', body: { role, ...body } });

  const roleSelect = node('select', { className: 'ctl', ariaLabel: 'Agent' });
  for (const [id, label] of Object.entries(agents)) roleSelect.add(new Option(label, id));
  const engine = node('select', { className: 'ctl', ariaLabel: 'Build engine' });
  engine.add(new Option('Groq', 'groq'));
  engine.add(new Option('Goose', 'goose'));
  const engineField = node('label', { className: 'jarvis-inline', hidden: true }, 'Engine ', engine);
  const badge = node('span', { className: 'pill jarvis-badge' }, 'Learning');
  const status = node('p', { className: 'studio-status' });
  status.setAttribute('role', 'status');

  const newChat = node('button', { className: 'btn jarvis-new', type: 'button', onclick: () => openThread(null) }, '+ New chat');
  const threadList = node('ul', { className: 'jarvis-threads-list' });
  const sidebar = node('aside', { className: 'jarvis-threads' }, newChat, threadList);

  const log = node('div', { className: 'jarvis-log' });
  log.setAttribute('aria-live', 'polite');
  const chips = node('div', { className: 'jarvis-chips' });
  const prompt = node('textarea', { className: 'ctl', required: true, maxLength: 1000, rows: 2, placeholder: 'Message JARVIS. Start with "remember:" to teach this agent a standing rule.' });
  const send = node('button', { className: 'btn', type: 'submit' }, 'Send');
  const composer = node('form', { className: 'jarvis-composer' }, prompt, send);
  const chat = node('div', { className: 'jarvis-chat' }, log, chips, composer);

  const learning = node('details', { className: 'jarvis-learning' });
  const panel = node('section', { className: 'card studio-card jarvis' },
    node('div', { className: 'jarvis-head' }, node('h2', {}, 'JARVIS'), node('label', { className: 'jarvis-inline' }, roleSelect), engineField, badge),
    node('div', { className: 'jarvis-layout' }, sidebar, chat), status, learning);

  prompt.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  };
  roleSelect.onchange = () => {
    role = roleSelect.value;
    engineField.hidden = role !== 'build';
    threadId = null;
    messages = [];
    renderLog();
    refresh(true);
  };

  function setBusy(value) {
    busy = value;
    for (const control of [roleSelect, engine, prompt, send, newChat]) control.disabled = value;
  }

  function renderBadge() {
    if (!learned) { badge.textContent = 'Learning'; return; }
    const { stats, playbook, lessons } = learned;
    const rate = stats.helpfulRate === null ? '' : ' · ' + Math.round(stats.helpfulRate * 100) + '% helpful';
    badge.textContent = stats.runs + ' runs' + rate + ' · ' + (playbook.length + lessons.filter(item => !item.consolidated).length) + ' learned';
    badge.title = 'Rate replies and add corrections. Every ' + 5 + ' ratings the agent rewrites its playbook.';
  }

  function renderThreads() {
    threadList.replaceChildren(...threads.map(entry => {
      const open = node('button', { type: 'button', className: 'jarvis-thread' + (entry.id === threadId ? ' active' : ''), onclick: () => openThread(entry.id) },
        node('span', {}, entry.title), node('small', {}, new Date(entry.updatedAt).toLocaleDateString()));
      const rename = node('button', { type: 'button', className: 'jarvis-icon', title: 'Rename chat', ariaLabel: 'Rename chat', onclick: async () => {
        const title = window.prompt('Chat title', entry.title);
        if (!title?.trim()) return;
        try { await memoryCall({ action: 'rename', threadId: entry.id, text: title.trim() }); await refresh(); } catch (error) { status.textContent = error.message; }
      } }, '✎');
      const remove = node('button', { type: 'button', className: 'jarvis-icon', title: 'Delete chat', ariaLabel: 'Delete chat', onclick: async () => {
        if (!confirm('Delete this chat? Learned lessons stay.')) return;
        try {
          await memoryCall({ action: 'delete', threadId: entry.id });
          if (entry.id === threadId) { threadId = null; messages = []; renderLog(); }
          await refresh();
        } catch (error) { status.textContent = error.message; }
      } }, '×');
      return node('li', {}, open, rename, remove);
    }));
    if (!threads.length) threadList.append(node('li', { className: 'jarvis-empty' }, 'No saved chats yet.'));
  }

  function renderLearning() {
    const open = learning.open;
    learning.replaceChildren();
    const summary = node('summary', {}, 'What this agent has learned');
    learning.append(summary);
    if (!learned) { learning.append(node('p', { className: 'studio-status' }, 'Unlock JARVIS to load memory.')); return; }
    const { stats, playbook, lessons, qcFindings } = learned;
    learning.append(node('p', { className: 'studio-status' },
      stats.runs + ' runs · ' + stats.up + ' helpful · ' + stats.down + ' needs work · ' + stats.exemplars + ' approved examples · ' +
      stats.reflections + ' reflections' + (stats.qcPass + stats.qcFail ? ' · QC pass ' + Math.round(100 * stats.qcPass / (stats.qcPass + stats.qcFail)) + '%' : '') +
      (stats.lastReflectAt ? ' · last reflection ' + new Date(stats.lastReflectAt).toLocaleString() : '')));
    learning.append(node('h3', {}, 'Playbook'), playbook.length
      ? node('ol', {}, ...playbook.map(rule => node('li', {}, rule)))
      : node('p', { className: 'studio-status' }, 'No playbook yet. Rate replies, then select Reflect now or wait for automatic reflection.'));
    const active = lessons.filter(item => !item.consolidated || item.source === 'manual');
    learning.append(node('h3', {}, 'Instructions and corrections'), active.length
      ? node('ul', { className: 'jarvis-lessons' }, ...active.map(item => node('li', {},
        node('span', { className: 'jarvis-tag' }, sourceLabels[item.source] || item.source), ' ' + item.text + ' ',
        node('button', { type: 'button', className: 'jarvis-icon', title: 'Forget', ariaLabel: 'Forget lesson', onclick: () => learn({ action: 'lesson-delete', lessonId: item.id }, 'Lesson removed.') }, '×'))))
      : node('p', { className: 'studio-status' }, 'None. Type "remember: ..." in chat or add one below.'));
    if (role === 'build' && qcFindings.length) learning.append(node('h3', {}, 'Recent QC rejections it avoids'),
      node('ul', {}, ...qcFindings.slice(0, 3).map(item => node('li', {}, item.text))));
    const lesson = node('input', { className: 'ctl', maxLength: 300, placeholder: 'Add a standing instruction for this agent' });
    const addForm = node('form', { className: 'jarvis-composer', onsubmit: event => {
      event.preventDefault();
      if (lesson.value.trim()) learn({ action: 'lesson-add', text: lesson.value.trim() }, 'Instruction saved.');
    } }, lesson, node('button', { className: 'btn', type: 'submit' }, 'Add'));
    learning.append(addForm, node('div', { className: 'studio-actions' },
      node('button', { className: 'btn', type: 'button', onclick: () => learn({ action: 'reflect' }, 'Playbook rewritten from feedback.') }, 'Reflect now'),
      node('button', { className: 'jarvis-link', type: 'button', onclick: () => {
        if (confirm('Erase everything this agent has learned? Chats stay.')) learn({ action: 'reset' }, 'Memory reset.');
      } }, 'Reset memory')));
    learning.open = open;
  }

  async function learn(body, done) {
    status.textContent = body.action === 'reflect' ? 'Reflecting on feedback…' : 'Saving…';
    try {
      learned = (await memoryCall(body)).memory;
      status.textContent = done;
      renderBadge();
      renderLearning();
    } catch (error) {
      status.textContent = error.message;
    }
  }

  function feedbackBar(message) {
    if (!message.id || !threadId || !message.meta?.trace) return null;
    const bar = node('div', { className: 'jarvis-feedback' });
    const draw = () => {
      bar.replaceChildren();
      const rate = async (rating, note) => {
        try {
          const result = await memoryCall({ action: 'feedback', threadId, messageId: message.id, rating, ...(note ? { note } : {}) });
          message.rating = rating;
          if (note) message.note = note;
          learned = result.memory;
          renderBadge();
          renderLearning();
          status.textContent = result.reflection === 'updated' ? 'Feedback saved. The agent rewrote its playbook.' : 'Feedback saved. The agent will use it next time.';
          draw();
        } catch (error) {
          status.textContent = error.message;
        }
      };
      const good = node('button', { type: 'button', className: 'jarvis-rate' + (message.rating === 1 ? ' on' : ''), onclick: () => rate(1) }, '▲ Helpful');
      const bad = node('button', { type: 'button', className: 'jarvis-rate' + (message.rating === -1 ? ' on' : ''), onclick: () => {
        const note = node('input', { className: 'ctl', maxLength: 300, placeholder: 'What should it do differently? (optional)' });
        const form = node('form', { className: 'jarvis-composer', onsubmit: event => { event.preventDefault(); rate(-1, note.value.trim()); } },
          note, node('button', { className: 'btn', type: 'submit' }, 'Teach'));
        bar.replaceChildren(form);
        note.focus();
      } }, '▼ Needs work');
      bar.append(good, bad);
      if (message.note) bar.append(node('small', { className: 'studio-status' }, 'Correction: ' + message.note));
    };
    draw();
    return bar;
  }

  function bubble(message) {
    if (message.role === 'user') return node('div', { className: 'jarvis-msg user' }, formatted(message.content));
    const meta = message.meta || {};
    const box = node('div', { className: 'jarvis-msg assistant' + (message.error ? ' error' : '') });
    if (meta.trace?.length || typeof meta.approved === 'boolean') {
      box.append(node('div', { className: 'jarvis-trace' }, [meta.engine === 'goose' ? 'Goose' : null,
        (meta.trace || []).map(id => id === 'build' ? 'Build developer' : agents[id] || id).join(' → '),
        typeof meta.approved === 'boolean' ? (meta.approved ? 'QC passed' : 'Changes needed') : null].filter(Boolean).join(' · ')));
    }
    if (meta.buildSummary) box.append(formatted(meta.buildSummary));
    box.append(formatted(message.content));
    if (meta.unavailable?.length) box.append(node('p', { className: 'studio-status' }, 'Unavailable sources: ' + meta.unavailable.join(', ')));
    if (meta.sources?.length) {
      const list = node('ol', { className: 'jarvis-sources' });
      for (const source of meta.sources) {
        const url = URL.parse(source.url);
        if (!url || !['https://www.federalreserve.gov', 'https://www.census.gov'].includes(url.origin)) continue;
        list.append(node('li', {}, node('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, source.title), source.date ? ' · ' + source.date : ''));
      }
      box.append(list);
    }
    if (meta.modules?.length) {
      box.append(node('ul', {}, ...meta.modules.map(module => node('li', {}, module.title + ' · ' + module.page))));
      const add = node('button', { type: 'button', className: 'btn' }, 'Add to Studio draft');
      add.onclick = () => {
        try {
          importModules(meta.modules);
          add.disabled = true;
          status.textContent = 'Added to the editor. Preview and save the draft in Studio.';
        } catch (error) {
          status.textContent = error.message;
        }
      };
      box.append(add);
    }
    if (message.actions) box.append(message.actions);
    box.append(feedbackBar(message));
    return box;
  }

  function renderLog(thinking = false) {
    log.replaceChildren(node('div', { className: 'jarvis-msg assistant intro' }, greetings[role]), ...messages.map(bubble));
    if (thinking) log.append(node('div', { className: 'jarvis-msg assistant thinking' }, node('span'), node('span'), node('span')));
    chips.replaceChildren(...(messages.length ? [] : suggestions[role].map(text =>
      node('button', { type: 'button', className: 'jarvis-chip', onclick: () => { prompt.value = text; prompt.focus(); } }, text))));
    prompt.placeholder = messages.length ? 'Follow up, or start with "remember:" to teach a standing rule.' : (suggestions[role][0] || '');
    log.scrollTop = log.scrollHeight;
  }

  async function refresh(openLatest = false) {
    const token = ++loadToken;
    try {
      const data = await call('/api/jarvis-memory?role=' + role);
      if (token !== loadToken) return;
      threads = data.threads;
      learned = data.memory;
      renderThreads();
      renderBadge();
      renderLearning();
      if (openLatest && threads[0] && !threadId) await openThread(threads[0].id);
    } catch (error) {
      if (token !== loadToken) return;
      learned = null;
      renderBadge();
      renderLearning();
      status.textContent = error.status === 503 ? 'Chat history is unavailable. Replies still work but are not saved.' : error.message;
    }
  }

  async function openThread(id) {
    if (busy) return;
    threadId = id;
    messages = [];
    status.textContent = '';
    renderThreads();
    if (!id) { renderLog(); prompt.focus(); return; }
    const token = ++loadToken;
    try {
      const { thread } = await call('/api/jarvis-memory?role=' + role + '&thread=' + encodeURIComponent(id));
      if (token !== loadToken) return;
      messages = thread.messages;
      renderLog();
    } catch (error) {
      status.textContent = error.message;
      threadId = null;
      renderLog();
    }
  }

  composer.onsubmit = async event => {
    event.preventDefault();
    if (busy) return;
    const task = prompt.value.trim();
    if (!task) return;
    const requestedRole = role;
    const previousTask = messages.findLast(message => message.role === 'user')?.content || previousTasks.get(requestedRole) || '';
    const intent = ['build', 'systems'].includes(role) ? brainHealthIntent(task, previousTask) : null;
    prompt.value = '';
    status.textContent = '';
    if (intent === 'read' || intent === 'edit') {
      // Live status comes from this page, so the answer stays local to the session.
      previousTasks.set(requestedRole, task);
      messages.push({ role: 'user', content: task }, {
        role: 'assistant', content: intent === 'read' ? formatBrainHealth(brainHealth()) : brainEditMessage,
        meta: { trace: ['systems'] }, actions: node('button', { className: 'btn', type: 'button', onclick: openBrain }, 'Open Brain 3D'),
      });
      renderLog();
      return;
    }
    messages.push({ role: 'user', content: task });
    setBusy(true);
    renderLog(true);
    try {
      const command = { role: requestedRole, prompt: task, previousTask };
      if (threadId) command.threadId = threadId;
      else command.newThread = true;
      if (command.role === 'systems' || command.role === 'build') command.filters = filters();
      if (command.role === 'build') command.engine = engine.value;
      if (command.role === 'qc') command.modules = draftModules();
      let result;
      try {
        result = await call('/api/jarvis', { method: 'POST', body: command });
      } catch (error) {
        if (error.status !== 404 || !command.threadId) throw error;
        // The chat was removed elsewhere. Continue in a new chat.
        delete command.threadId;
        command.newThread = true;
        result = await call('/api/jarvis', { method: 'POST', body: command });
      }
      if (role !== requestedRole) return;
      previousTasks.set(requestedRole, task);
      const meta = {};
      for (const name of ['trace', 'approved', 'buildSummary', 'engine', 'unavailable', 'sources', 'modules']) if (result[name] !== undefined) meta[name] = result[name];
      messages.push({ id: result.messageId, role: 'assistant', content: result.answer, meta });
      if (result.threadId) threadId = result.threadId;
      if (result.memoryError) status.textContent = result.memoryError;
      refresh();
    } catch (error) {
      if (role !== requestedRole) return;
      messages.push({ role: 'assistant', content: error.message, error: true });
      prompt.value ||= task;
    } finally {
      setBusy(false);
      if (role === requestedRole) renderLog();
    }
  };

  panel.selectAgent = id => {
    if (roleSelect.value !== id || !learned) {
      roleSelect.value = id;
      roleSelect.onchange();
    }
    prompt.focus();
  };
  // Load chats the first time the panel is visible with a key.
  new IntersectionObserver(entries => {
    if (entries.some(entry => entry.isIntersecting) && key() && !learned && !busy) refresh(true);
  }).observe(panel);
  renderLog();
  renderThreads();
  renderLearning();
  return panel;
}
