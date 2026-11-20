import { brainEditMessage, brainHealthIntent, formatBrainHealth } from './jarvis-intent.mjs';
import { instructionsForm } from './jarvis-instructions.mjs';

export const agents = {
  systems: 'Systems and KPIs',
  market: 'Market news and improvement',
  build: 'Build developer → QC developer',
  qc: 'QC developer',
};
// Main dispatcher, Data sandbox, Email, optional agents on other providers, plus custom bots created in the Learning panel.
const leadAgents = { main: 'Main (delegates)' };
const extraAgents = { data: 'Data sandbox → QC', email: 'Email', gemini: 'Gemini (second opinion)', cloudflare: 'Workers AI (Llama)' };
const names = { ...agents, main: 'Main', build: 'Build developer', data: 'Data sandbox', email: 'Email', gemini: 'Gemini', cloudflare: 'Workers AI', execute: 'Execute (validation only)' };

const greetings = {
  systems: 'Systems and KPIs online. Ask about coverage, KPI changes, or what to fix first.',
  market: 'Market desk online. Ask how current Fed and Census news affects acquisitions and seller outreach.',
  build: 'Build developer online. Describe a dashboard card or panel and QC will check it before you import it.',
  qc: 'QC developer online. Ask me to review the current Studio draft modules, or paste a plan with /execute first.',
  main: 'JARVIS online. Ask anything. I hand it to Systems, Market, Build, Data, Email, Gemini, Workers AI or one of your bots.',
  data: 'Data sandbox online. Describe a view or query over LCP numbers. I draft a plan, QC checks it, and you can run it on a throwaway copy.',
  email: 'Email agent online. Ask about unread mail, seller replies, escrow and title deadlines.',
  gemini: 'Gemini online. Second opinions, longer writing and general questions, with the selected report as context.',
  cloudflare: 'Workers AI online (Cloudflare, Llama). Fast drafts, rewrites, brainstorming and a third opinion.',
};

const suggestions = {
  systems: ['Review KPI changes and identify the top three actions.', 'Which source has the weakest coverage right now?', 'Compare this period to the previous one.'],
  market: ['Summarize the implications for seller outreach in my market.', 'What do the latest Fed releases mean for buyer financing?'],
  build: ['Build a Brain panel with HighLevel opportunities, a trend, and live system health.', 'Add a Dials KPI to Sales.'],
  qc: ['Check whether the current modules display the intended KPIs and contain clear instructions.'],
  main: ['What needs my attention today?', 'Any seller replies in the inbox?'],
  data: ['Build a view of qualified sellers per 100 dials by rep.', 'Which cities have the most opportunities per touch?'],
  email: ['Summarize unread mail and flag deadlines.', 'Which emails are waiting on a reply?'],
  gemini: ['Give me a second opinion on this period\'s numbers.', 'Draft a follow-up text for a seller who went quiet.'],
  cloudflare: ['Brainstorm 5 ways to lift connect rate.', 'Rewrite this seller text to sound friendlier.'],
};
const pct = value => (value === null || value === undefined ? 'n/a' : Math.round(value * 100) + '%');

const sourceLabels = { manual: 'Instruction', correction: 'Correction', praise: 'Keep doing' };

function table(rows) {
  if (!rows?.length) return null;
  const cols = Object.keys(rows[0]);
  return node('div', { className: 'jarvis-table' }, node('table', {},
    node('thead', {}, node('tr', {}, ...cols.map(c => node('th', {}, c)))),
    node('tbody', {}, ...rows.map(row => node('tr', {}, ...cols.map(c => node('td', {}, row[c] === null ? '' : String(row[c]))))))));
}

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
  let shared = [];
  let bots = [];
  let query = '';
  let busy = false;
  let loadToken = 0;
  const nameOf = id => names[id] || bots.find(bot => bot.id === id)?.name || id;

  async function call(path, options = {}) {
    const headers = { 'x-lcp-studio-key': key() };
    if (options.body) headers['content-type'] = 'application/json';
    const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(result.error || 'JARVIS request failed.'), { status: response.status });
    return result;
  }
  const memoryCall = (body, target = role) => call('/api/jarvis-memory', { method: 'POST', body: { role: target, ...body } });

  const roleSelect = node('select', { className: 'ctl', ariaLabel: 'Agent' });
  function renderRoles() {
    roleSelect.replaceChildren(...Object.entries({ ...leadAgents, ...agents, ...extraAgents }).map(([id, label]) => new Option(label, id)),
      ...bots.map(bot => new Option('Bot: ' + bot.name, bot.id)), new Option('+ New bot...', '__new'));
    roleSelect.value = role;
  }
  renderRoles();
  const engine = node('select', { className: 'ctl', ariaLabel: 'Build engine' });
  engine.add(new Option('Groq', 'groq'));
  engine.add(new Option('Goose', 'goose'));
  const engineField = node('label', { className: 'jarvis-inline', hidden: true }, 'Engine ', engine);
  const badge = node('span', { className: 'pill jarvis-badge' }, 'Learning');
  const exportButton = node('button', { className: 'jarvis-link jarvis-export', type: 'button', title: 'Download this chat as Markdown' }, 'Export');
  const status = node('p', { className: 'studio-status' });
  status.setAttribute('role', 'status');

  const newChat = node('button', { className: 'btn jarvis-new', type: 'button', onclick: () => openThread(null) }, '+ New chat');
  const threadList = node('ul', { className: 'jarvis-threads-list' });
  const search = node('input', { className: 'ctl', type: 'search', placeholder: 'Search chats', maxLength: 80, ariaLabel: 'Search chats' });
  const topic = node('select', { className: 'ctl', ariaLabel: 'Chat topic', onchange: () => renderThreads() });
  const sidebar = node('aside', { className: 'jarvis-threads' }, newChat, search, topic, threadList);

  const log = node('div', { className: 'jarvis-log' });
  log.setAttribute('aria-live', 'polite');
  const chips = node('div', { className: 'jarvis-chips' });
  const prompt = node('textarea', { className: 'ctl', required: true, maxLength: 12000, rows: 2, placeholder: 'Message JARVIS. Start with "remember:" to teach this agent a standing rule.' });
  const send = node('button', { className: 'btn', type: 'submit' }, 'Send');
  const composer = node('form', { className: 'jarvis-composer' }, prompt, send);
  const chat = node('div', { className: 'jarvis-chat' }, log, chips, composer);

  function dataPanel(title, view, render) {
    const output = node('div', { className: 'jarvis-text', role: 'status' });
    const refresh = node('button', { type: 'button', className: 'btn' }, 'Refresh');
    async function load() {
      refresh.disabled = true;
      output.textContent = 'Loading…';
      try {
        const data = await call('/api/jarvis?view=' + view);
        if (details.open) render(output, data);
      } catch (error) {
        if (details.open) output.textContent = error.message;
      } finally {
        refresh.disabled = false;
      }
    }
    refresh.onclick = load;
    const details = node('details', { className: 'jarvis-learning', ontoggle: () => {
      if (details.open && !refresh.disabled) void load();
      if (!details.open) output.replaceChildren();
    } }, node('summary', {}, title), refresh, output);
    return details;
  }

  const mailbox = dataPanel('Mailbox snapshot', 'mail', (output, snapshot) => {
    if (!snapshot.configured) {
      output.textContent = 'Connect an email source to view the mailbox.';
      return;
    }
    const messages = snapshot.messages || [];
    const filter = node('input', { className: 'ctl', type: 'search', placeholder: 'Filter sender, subject or text', ariaLabel: 'Filter mailbox snapshot' });
    const unread = node('input', { type: 'checkbox' });
    const list = node('ul', {});
    function render() {
      const query = filter.value.trim().toLowerCase();
      const matches = messages.filter(message => (!unread.checked || message.unread === true)
        && [message.from, message.subject, message.text].some(value => String(value || '').toLowerCase().includes(query)));
      list.replaceChildren(...matches.map(message => node('li', {},
        node('details', {}, node('summary', {}, (message.unread ? 'Unread · ' : '') + message.subject),
          node('p', {}, [message.from, message.receivedAt && new Date(message.receivedAt).toLocaleString()].filter(Boolean).join(' · ')),
          node('p', {}, message.text)))));
      if (!matches.length) list.append(node('li', {}, 'No messages match.'));
    }
    filter.oninput = unread.onchange = render;
    render();
    const asOf = snapshot.asOf || snapshot.syncedAt;
    const summary = node('button', { type: 'button', className: 'btn', onclick: () => {
      if (busy) return;
      roleSelect.value = 'email';
      roleSelect.onchange();
      prompt.value = 'Summarize the mailbox snapshot and flag replies and deadlines.';
      prompt.focus();
    } }, 'Prepare summary request');
    output.replaceChildren(node('p', {}, [
      snapshot.source === 'sample' ? 'Sample mailbox' : 'Mailbox snapshot',
      asOf && new Date(asOf).toLocaleString(),
      snapshot.stats?.unreadIncoming != null && snapshot.stats.unreadIncoming + ' unread in inbox',
      snapshot.stale && 'Stale snapshot',
      snapshot.messagesAvailable === false && 'Some messages unavailable',
    ].filter(Boolean).join(' · ')), filter,
    messages.some(message => typeof message.unread === 'boolean') && node('label', { className: 'jarvis-inline' }, unread, 'Unread only'),
    summary, list);
  });

  const modelStatus = dataPanel('Groq model status', 'models', (output, models) => {
    if (!models.configured) {
      output.textContent = 'Groq is not configured.';
      return;
    }
    output.replaceChildren(
      node('p', {}, 'Primary ' + models.primary + ' · Backup ' + models.backup),
      node('p', {}, models.active ? 'Last successful model in this instance: ' + models.active : 'No successful request recorded in this instance.'),
      models.lastFailure && node('p', {}, (models.lastFailure.status ? 'HTTP ' + models.lastFailure.status : 'Connection failure') + ' · ' + new Date(models.lastFailure.at).toLocaleString()),
      models.retryAt && node('p', {}, 'Primary retry after ' + new Date(models.retryAt).toLocaleString()));
  });

  const learning = node('details', { className: 'jarvis-learning' });
  const instructions = instructionsForm({ call });
  const instructionsBox = node('details', { className: 'jarvis-learning', ontoggle: () => { if (instructionsBox.open) instructions.load(); } },
    node('summary', {}, 'Custom instructions (all agents)'), instructions);
  const panel = node('section', { className: 'card studio-card jarvis' },
    node('div', { className: 'jarvis-head' }, node('h2', {}, 'JARVIS'), node('label', { className: 'jarvis-inline' }, roleSelect), engineField, badge, exportButton),
    node('div', { className: 'jarvis-layout' }, sidebar, chat), status, mailbox, modelStatus, instructionsBox, learning);

  prompt.onkeydown = event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      composer.requestSubmit();
    }
  };
  roleSelect.onchange = () => {
    if (roleSelect.value === '__new') {
      roleSelect.value = role;
      learning.open = true;
      renderLearning(true);
      return;
    }
    if (roleSelect.value === role) return;
    role = roleSelect.value;
    engineField.hidden = role !== 'build';
    threadId = null;
    messages = [];
    query = '';
    search.value = '';
    threads = [];
    renderThreads();
    renderLog();
    refresh(true);
  };
  let searchTimer;
  search.oninput = () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      query = search.value.trim();
      if (query.length < 2) { query = ''; renderThreads(); return; }
      try {
        const { results } = await call('/api/jarvis-memory?role=' + encodeURIComponent(role) + '&q=' + encodeURIComponent(query));
        renderThreads(results);
      } catch (error) { status.textContent = error.message; }
    }, 300);
  };
  exportButton.onclick = () => {
    if (!messages.length) { status.textContent = 'Nothing to export yet.'; return; }
    const title = threads.find(item => item.id === threadId)?.title || 'JARVIS chat';
    const lines = ['# ' + title, '', 'Agent: ' + nameOf(role) + '  ', 'Exported: ' + new Date().toLocaleString(), ''];
    for (const message of messages) {
      lines.push('## ' + (message.role === 'user' ? 'You' : 'JARVIS' + (message.meta?.trace ? ' (' + message.meta.trace.map(nameOf).join(' > ') + ')' : '')), '');
      if (message.meta?.buildSummary) lines.push(message.meta.buildSummary, '');
      lines.push(message.content || '', '');
      if (message.meta?.modules?.length) lines.push(...message.meta.modules.map(module => '- ' + module.title + ' (' + module.type + ', ' + module.page + ')'), '');
    }
    const url = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/markdown' }));
    const link = node('a', { href: url, download: title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase().slice(0, 60) + '.md' });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    status.textContent = 'Chat exported as Markdown.';
  };

  function setBusy(value) {
    busy = value;
    for (const control of [roleSelect, engine, prompt, send, newChat, search]) control.disabled = value;
    topic.disabled = value || Boolean(query) || topic.options.length < 2;
  }

  function renderBadge() {
    if (!learned) { badge.textContent = 'Learning'; return; }
    const { stats, playbook, lessons } = learned;
    const rate = stats.helpfulRate === null ? '' : ' · ' + pct(stats.helpfulRate) + ' helpful';
    badge.textContent = stats.runs + ' runs' + rate + ' · ' + (playbook.length + lessons.filter(item => !item.consolidated).length) + ' learned';
    badge.title = 'Rate replies and add corrections. Every ' + 5 + ' ratings the agent rewrites its playbook.';
  }

  function renderThreads(results = null) {
    const selected = topic.value;
    const topics = [...new Set(threads.map(entry => entry.topic || 'General'))].sort();
    topic.replaceChildren(new Option('All topics', ''), ...topics.map(name => new Option(name, name)));
    topic.value = topics.includes(selected) ? selected : '';
    topic.disabled = Boolean(results) || busy || !topics.length;
    const list = results || threads.filter(entry => !topic.value || (entry.topic || 'General') === topic.value);
    const act = (label, title, handler) => node('button', { type: 'button', className: 'jarvis-icon', title, ariaLabel: title, onclick: handler }, label);
    threadList.replaceChildren(...list.map(entry => {
      const open = node('button', { type: 'button', className: 'jarvis-thread' + (entry.id === threadId ? ' active' : ''), onclick: () => openThread(entry.id) },
        node('span', {}, (entry.pinned ? '📌 ' : '') + entry.title),
        node('small', {}, results ? entry.snippet || 'Title match' : new Date(entry.updatedAt).toLocaleDateString()));
      return node('li', {}, open,
        act(entry.pinned ? '◉' : '○', entry.pinned ? 'Unpin chat' : 'Pin chat', () => threadAction({ action: 'pin', threadId: entry.id, pinned: !entry.pinned })),
        act('✎', 'Rename chat', () => {
          const title = window.prompt('Chat title', entry.title);
          if (title?.trim()) threadAction({ action: 'rename', threadId: entry.id, text: title.trim().slice(0, 60) });
        }),
        act('×', 'Delete chat', async () => {
          if (!confirm('Delete this chat? Learned lessons stay.')) return;
          if (await threadAction({ action: 'delete', threadId: entry.id }) && entry.id === threadId) { threadId = null; messages = []; renderLog(); }
        }));
    }));
    if (!list.length) threadList.append(node('li', { className: 'jarvis-empty' }, results ? 'No matching chats.' : 'No saved chats yet.'));
  }

  async function threadAction(body) {
    try {
      await memoryCall(body);
      if (query) search.dispatchEvent(new Event('input'));
      await refresh();
      return true;
    } catch (error) {
      status.textContent = error.message;
      return false;
    }
  }

  function inlineForm(placeholder, max, label, submit) {
    const input = node('input', { className: 'ctl', maxLength: max, placeholder });
    return node('form', { className: 'jarvis-composer', onsubmit: event => {
      event.preventDefault();
      if (input.value.trim()) submit(input.value.trim());
    } }, input, node('button', { className: 'btn', type: 'submit' }, label));
  }

  function botForm(bot = null) {
    const name = node('input', { className: 'ctl', maxLength: 40, required: true, placeholder: 'Bot name, e.g. Offer Coach', value: bot?.name || '' });
    const description = node('input', { className: 'ctl', maxLength: 200, placeholder: 'What it is for (optional)', value: bot?.description || '' });
    const text = node('textarea', { className: 'ctl', maxLength: 1500, required: true, rows: 3, placeholder: 'Instructions for this bot', value: bot?.instructions || '' });
    const context = node('select', { className: 'ctl' }, new Option('No data', 'none'), new Option('LCP report (selected filters)', 'metrics'), new Option('Mailbox snapshot', 'mail'));
    context.value = bot?.context || 'none';
    return node('form', { className: 'jarvis-bot-form', onsubmit: async event => {
      event.preventDefault();
      const body = { bot: { name: name.value.trim(), description: description.value.trim(), instructions: text.value.trim(), context: context.value } };
      const result = bot ? await learn({ action: 'bot-update', ...body }, 'Bot updated.', bot.id) : await learn({ action: 'bot-create', ...body }, 'Bot created.', 'systems');
      if (result?.bot && !bot) { roleSelect.value = result.bot.id; roleSelect.onchange(); }
    } }, name, description, text, node('label', { className: 'jarvis-inline' }, 'Data source ', context),
    node('div', { className: 'studio-actions' }, node('button', { className: 'btn', type: 'submit' }, bot ? 'Save bot' : 'Create bot'),
      bot ? node('button', { className: 'jarvis-link', type: 'button', onclick: async () => {
        if (!confirm('Delete ' + bot.name + ' with its chats and memory?')) return;
        if (await learn({ action: 'bot-delete' }, 'Bot deleted.', bot.id)) { renderRoles(); roleSelect.value = 'systems'; roleSelect.onchange(); }
      } }, 'Delete bot') : null));
  }

  function renderLearning(newBot = false) {
    const open = learning.open;
    learning.replaceChildren(node('summary', {}, 'What ' + nameOf(role) + ' has learned'));
    if (!learned) { learning.append(node('p', { className: 'studio-status' }, 'Unlock JARVIS to load memory.')); learning.open = open; return; }
    const { stats, playbook, playbookVersion: pv = { version: 0, ratings: 0, helpfulRate: null }, versions = [], rollbacks = [], lessons, qcFindings } = learned;
    learning.append(node('p', { className: 'studio-status' },
      stats.runs + ' runs · ' + stats.up + ' helpful · ' + stats.down + ' needs work · ' + stats.exemplars + ' approved examples · ' +
      stats.reflections + ' reflections' + (stats.qcPass + stats.qcFail ? ' · QC pass ' + pct(stats.qcPass / (stats.qcPass + stats.qcFail)) : '') +
      (stats.lastReflectAt ? ' · last reflection ' + new Date(stats.lastReflectAt).toLocaleString() : '')));
    learning.append(node('h3', {}, 'Playbook v' + pv.version + ' · ' + pv.ratings + ' ratings · ' + pct(pv.helpfulRate) + ' helpful' + (pv.restored ? ' · restored' : '')), playbook.length
      ? node('ol', {}, ...playbook.map(rule => node('li', {}, rule)))
      : node('p', { className: 'studio-status' }, 'No playbook yet. Rate replies, then select Reflect now or wait for automatic reflection.'));
    if (versions.length) learning.append(node('h3', {}, 'Earlier versions'), node('ul', {}, ...versions.map(item => node('li', {},
      'v' + item.version + ' · ' + item.rules + ' rules · ' + item.ratings + ' ratings · ' + pct(item.helpfulRate) + ' helpful ',
      node('button', { type: 'button', className: 'jarvis-link', onclick: () => {
        if (confirm('Restore playbook v' + item.version + '?')) learn({ action: 'playbook-restore', version: item.version }, 'Playbook v' + item.version + ' restored.');
      } }, 'Restore')))));
    if (rollbacks.length) learning.append(node('h3', {}, 'Rollback log'), node('ul', {}, ...rollbacks.slice(0, 5).map(item => node('li', { className: 'studio-status' },
      new Date(item.at).toLocaleString() + ': v' + item.from + ' (' + pct(item.fromRate) + ') to v' + item.to + ' (' + pct(item.toRate) + ')' + (item.manual ? ', manual' : ', automatic')))));
    const active = lessons.filter(item => !item.consolidated || item.source === 'manual');
    learning.append(node('h3', {}, 'Instructions and corrections'), active.length
      ? node('ul', { className: 'jarvis-lessons' }, ...active.map(item => node('li', {},
        node('span', { className: 'jarvis-tag' }, sourceLabels[item.source] || item.source), ' ' + item.text + ' ',
        node('button', { type: 'button', className: 'jarvis-icon', title: 'Forget', ariaLabel: 'Forget lesson', onclick: () => learn({ action: 'lesson-delete', lessonId: item.id }, 'Lesson removed.') }, '×'))))
      : node('p', { className: 'studio-status' }, 'None. Type "remember: ..." in chat or add one below.'));
    if (role === 'build' && qcFindings.length) learning.append(node('h3', {}, 'Recent QC rejections it avoids'),
      node('ul', {}, ...qcFindings.slice(0, 3).map(item => node('li', {}, item.text))));
    learning.append(inlineForm('Add a standing instruction for this agent', 300, 'Add', text => learn({ action: 'lesson-add', text }, 'Instruction saved.')),
      node('div', { className: 'studio-actions' },
        node('button', { className: 'btn', type: 'button', onclick: () => learn({ action: 'reflect' }, 'Playbook rewritten from feedback.') }, 'Reflect now'),
        node('button', { className: 'jarvis-link', type: 'button', onclick: () => {
          if (confirm('Erase everything this agent has learned? Chats stay.')) learn({ action: 'reset' }, 'Memory reset.');
        } }, 'Reset memory')));
    learning.append(node('h3', {}, 'Company memory (all agents) · ' + shared.length + ' of 20'), shared.length
      ? node('ul', { className: 'jarvis-lessons' }, ...shared.map(item => node('li', {}, item.text + ' ',
        node('button', { type: 'button', className: 'jarvis-icon', title: 'Delete', ariaLabel: 'Delete company fact', onclick: () => learn({ action: 'shared-delete', id: item.id }, 'Company fact removed.') }, '×'))))
      : node('p', { className: 'studio-status' }, 'Add buy box rules, target ZIPs or offer terms. Or type "remember for all agents: ..." in chat.'),
    inlineForm('Company fact or rule for every agent', 300, 'Add', text => learn({ action: 'shared-add', text }, 'Saved to company memory.')));
    const bot = bots.find(item => item.id === role);
    learning.append(node('h3', {}, bot && !newBot ? 'Edit ' + bot.name : 'Create a bot'), botForm(bot && !newBot ? bot : null));
    learning.open = open || newBot;
  }

  async function learn(body, done, target = role) {
    status.textContent = body.action === 'reflect' ? 'Reflecting on feedback…' : 'Saving…';
    try {
      const result = await memoryCall(body, target);
      if (result.memory && target === role) learned = result.memory;
      if (result.shared) shared = result.shared;
      if (result.bots) { bots = result.bots; renderRoles(); }
      status.textContent = done;
      renderBadge();
      renderLearning();
      return result;
    } catch (error) {
      status.textContent = error.message;
      return null;
    }
  }

  // Email drafts: shown for review, saved to Gmail only when the operator clicks. Nothing here can send mail.
  function draftView(meta) {
    const draft = meta.draft;
    if (!draft) return null;
    const output = node('p', { className: 'studio-status' });
    const save = node('button', { type: 'button', className: 'btn', onclick: async () => {
      save.disabled = true;
      output.textContent = 'Saving to Gmail drafts…';
      try {
        const result = await call('/api/jarvis-email-draft', { method: 'POST', body: draft });
        output.replaceChildren('Saved as a Gmail draft' + (result.sample ? ' (sample mode, nothing saved)' : '') + '. Review and send it from ',
          node('a', { href: result.link, target: '_blank', rel: 'noopener noreferrer' }, 'Gmail drafts'), '.');
      } catch (error) {
        output.textContent = error.message;
        save.disabled = false;
      }
    } }, 'Save as Gmail draft');
    return node('div', { className: 'jarvis-plan jarvis-draft' },
      node('p', { className: 'jarvis-heading' }, 'Draft email' + (draft.replyToId ? ' (reply in thread)' : '')),
      node('p', {}, 'To: ' + (draft.to?.length ? draft.to.join(', ') : 'add a recipient in Gmail') + (draft.cc?.length ? ' · Cc: ' + draft.cc.join(', ') : '')),
      node('p', {}, 'Subject: ' + draft.subject),
      node('pre', { className: 'jarvis-draft-body' }, draft.body),
      save, output);
  }

  function planView(meta) {
    if (!meta.plan || (meta.validation && !meta.validation.ok)) return null;
    const box = node('div', { className: 'jarvis-plan' },
      node('p', { className: 'jarvis-heading' }, 'Plan: ' + meta.plan.task),
      node('ol', {}, ...meta.plan.steps.map(step => node('li', {}, step.action + (step.sql ? ': ' + step.sql
        : step.module ? ': ' + step.module + (step.source ? ' from ' + step.source + '.' + step.fieldName : '') : step.schedule ? ': ' + step.schedule : '')))));
    const warnings = meta.validation?.warnings || meta.warnings || [];
    if (warnings.length) box.append(node('ul', { className: 'studio-status' }, ...warnings.map(item => node('li', {}, item))));
    if (!meta.planHash) return box;
    const output = node('div', { className: 'jarvis-run' });
    const runButton = node('button', { type: 'button', className: 'btn', onclick: async () => {
      if (!confirm('Run this plan in the sandbox? It uses a throwaway copy of LCP aggregates. Nothing is applied to production.')) return;
      runButton.disabled = true;
      output.replaceChildren(node('p', { className: 'studio-status' }, 'Running in the sandbox…'));
      try {
        const result = await call('/api/jarvis-execute', { method: 'POST', body: { action: 'run', plan: meta.plan, planHash: meta.planHash, filters: filters() } });
        output.replaceChildren(node('p', { className: 'jarvis-heading' }, 'Sandbox ' + result.outcome + '. Applied to production: no.'),
          ...(result.error ? [node('p', {}, result.error)] : []),
          ...result.steps.map(step => node('div', {}, node('p', {}, (step.ok ? '✓ ' : '✗ ') + step.action + ': ' + step.detail), table(step.rows))),
          ...result.checks.map(check => node('div', {}, node('p', {}, (check.ok ? '✓ ' : '✗ ') + 'Check ' + check.check + ': ' + check.detail), table(check.rows))));
      } catch (error) {
        output.replaceChildren(node('p', {}, error.message));
      } finally {
        runButton.disabled = false;
      }
    } }, 'Run in sandbox');
    box.append(runButton, output);
    return box;
  }

  function feedbackBar(message) {
    if (!message.id || !threadId || !message.meta?.trace || message.meta.execute) return null;
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
          status.textContent = result.rolledBack ? 'Feedback saved. The new playbook rated worse, so the previous version was restored.'
            : result.reflection === 'updated' ? 'Feedback saved. The agent rewrote its playbook.' : 'Feedback saved. The agent will use it next time.';
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
    if (message.role === 'user') return node('div', { className: 'jarvis-msg user' }, formatted(/^\s*\/execute\b/i.test(message.content) ? '/execute (plan JSON, ' + message.content.length + ' characters)' : message.content));
    const meta = message.meta || {};
    const box = node('div', { className: 'jarvis-msg assistant' + (message.error ? ' error' : '') });
    if (meta.trace?.length || typeof meta.approved === 'boolean') {
      box.append(node('div', { className: 'jarvis-trace' }, [meta.engine === 'goose' ? 'Goose' : null,
        (meta.trace || []).map(nameOf).join(' → '),
        typeof meta.approved === 'boolean' ? (meta.approved ? 'QC passed' : 'Changes needed') : null,
        meta.provider ? 'on ' + (meta.provider === 'gemini' ? 'Gemini' : 'Groq') : null,
        meta.usage ? meta.usage.totalTokens + ' tokens' : null].filter(Boolean).join(' · ')));
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
    box.append(...[planView(meta), draftView(meta), feedbackBar(message)].filter(Boolean));
    return box;
  }

  function renderLog(thinking = false) {
    const intro = greetings[role] || 'Custom bot online. ' + (bots.find(bot => bot.id === role)?.description || '');
    log.replaceChildren(node('div', { className: 'jarvis-msg assistant intro' }, intro), ...messages.map(bubble));
    if (thinking) log.append(node('div', { className: 'jarvis-msg assistant thinking' }, node('span'), node('span'), node('span')));
    chips.replaceChildren(...(messages.length ? [] : (suggestions[role] || []).map(text =>
      node('button', { type: 'button', className: 'jarvis-chip', onclick: () => { prompt.value = text; prompt.focus(); } }, text))));
    prompt.placeholder = messages.length ? 'Follow up. "remember:" teaches this agent, "remember for all agents:" teaches every agent.' : (suggestions[role]?.[0] || 'Message JARVIS');
    log.scrollTop = log.scrollHeight;
  }

  async function refresh(openLatest = false) {
    const token = ++loadToken;
    try {
      const data = await call('/api/jarvis-memory?role=' + encodeURIComponent(role));
      if (token !== loadToken) return;
      ({ threads, shared = [], bots = [] } = data);
      learned = data.memory;
      renderRoles();
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
      const { thread } = await call('/api/jarvis-memory?role=' + encodeURIComponent(role) + '&thread=' + encodeURIComponent(id));
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
    if (task.length > 1000 && !/^\s*\/execute\b/i.test(task)) { status.textContent = 'Keep messages under 1000 characters.'; return; }
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
      if (!['market', 'qc', 'email', 'data'].includes(command.role)) command.filters = filters();
      if (command.role === 'build') command.engine = engine.value;
      if (['qc', 'main'].includes(command.role) && !/^\s*\/execute\b/i.test(task)) command.modules = draftModules();
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
      for (const name of ['trace', 'approved', 'buildSummary', 'engine', 'unavailable', 'sources', 'modules', 'usage', 'agent', 'plan', 'planHash', 'warnings', 'validation', 'execute', 'draft', 'provider']) if (result[name] !== undefined) meta[name] = result[name];
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

  panel.load = () => { if (key() && !learned && !busy) refresh(true); };
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
