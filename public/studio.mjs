import { formatBrainHealth } from './jarvis-intent.mjs';
import { agents, createJarvisPanel } from './jarvis.mjs';
import { createIntelPanel } from './intel.mjs';
import { initialConfig, metrics, pages, salesWidgets, trends, validateConfig } from './studio-schema.mjs';

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function button(title, run, disabled = false) {
  return element('button', { type: 'button', className: 'btn', onclick: run, disabled }, title);
}

function field(title, control) {
  return element('label', {}, title, control);
}

function input(value, maxLength, oninput) {
  return element('input', { className: 'ctl', value, maxLength, oninput });
}

function select(options, value, oninput) {
  const control = element('select', { className: 'ctl', oninput });
  for (const [id, title] of Object.entries(options)) control.add(new Option(title, id));
  control.value = value;
  return control;
}

function card(title, ...nodes) {
  return element('section', { className: 'card studio-card' }, element('h2', {}, title), ...nodes);
}

function hasHealth(module) {
  return module.type === 'health' || module.blocks?.some(block => block.type === 'health');
}

function metricValue(metric, report) {
  const value = report?.kpis?.[metric];
  const format = metric === 'connectRate' ? { style: 'percent', maximumFractionDigits: 1 }
    : metric === 'pipelineValue' ? { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }
    : { maximumFractionDigits: 1 };
  if (['opportunities', 'pipelineValue'].includes(metric) && report?.sources?.mode !== 'sample'
      && (!report?.sources?.ghl || report.sources.warnings?.some(warning => warning.startsWith('GHL opportunities')))) {
    return 'HighLevel report unavailable';
  }
  return Number.isFinite(value) ? value.toLocaleString(undefined, format) : '—';
}

function trendView(series, report) {
  if (series === 'opportunities' && metricValue('opportunities', report) === 'HighLevel report unavailable') {
    return element('p', {}, 'HighLevel report unavailable');
  }
  const values = (report?.trend?.[series] || []).slice(-30);
  if (!values.length) return element('p', {}, 'Trend unavailable');
  const max = Math.max(1, ...values);
  const chart = element('div', { className: 'studio-trend' });
  chart.setAttribute('aria-hidden', 'true');
  for (const number of values) {
    const bar = element('span', { title: String(number) });
    bar.style.height = Math.max(2, number / max * 100) + '%';
    chart.append(bar);
  }
  return element('div', {}, chart, element('p', { className: 'meta' }, 'Latest bucket · ' + values.at(-1).toLocaleString()));
}

function moduleCard(module, report, health) {
  let value;
  if (module.type === 'panel') {
    const grid = element('div', { className: 'studio-panel-blocks' }, ...module.blocks.map(block => element('section', {},
      element('h3', {}, block.title),
      block.type === 'trend' ? trendView(block.series, report)
        : block.type === 'metric' ? element('strong', { className: 'studio-config-metric' }, metricValue(block.metric, report))
        : element('p', { className: 'studio-config-note' }, block.type === 'health' ? formatBrainHealth(health) : block.text),
    )));
    return card(module.title, grid);
  }
  if (module.type === 'note') {
    value = element('p', { className: 'studio-config-note' }, module.text);
  } else if (module.type === 'health') {
    value = element('p', { className: 'studio-config-note' }, formatBrainHealth(health));
  } else {
    value = element('strong', { className: 'studio-config-metric' }, metricValue(module.metric, report));
  }
  return card(module.title, value);
}

export function mountStudio({ root, dashboardKey, view, report, filters, brainHealth, openBrain, openStudio, brainAgents }) {
  const studioTab = document.querySelector('[data-v="studio"]');
  const tabs = new Map(Object.keys(pages).map(id => [id, document.querySelector('[data-v="' + id + '"]')]));
  const sales = document.getElementById('v-sales');
  const widgets = new Map([...sales.children].map(node => [node.dataset.studioWidget, node]));
  // Module mounts are siblings of legacy views, which some renderers replace with innerHTML.
  const moduleHost = element('div', { hidden: true });
  root.before(moduleHost);
  const stylesheet = element('link', { rel: 'stylesheet', href: new URL('./studio.css', import.meta.url).href });
  document.head.append(stylesheet);

  let published = initialConfig();
  let adminKey = '';
  let saved = null;
  let working = null;
  let baseline = '';
  let busy = false;
  let status = '';
  let preview = false;
  let historySelection = '';
  let dragged = null;
  let moduleView = '';
  let moduleReport = null;
  let moduleConfig = null;
  let moduleHealth = '';
  const sharedAgentOptions = {
    key: () => adminKey,
    filters,
    brainHealth,
    openBrain,
    previousTasks: new Map(),
    draftModules: () => working.modules,
    importModules(modules) {
      if (busy) throw new Error('Wait for the Studio action to finish.');
      const updated = { ...working, modules: [...working.modules, ...modules] };
      validateConfig(updated);
      working = updated;
      preview = false;
      status = 'Unsaved changes.';
      render();
      if (view() === 'brain') openStudio();
    },
  };
  const jarvis = createJarvisPanel(sharedAgentOptions);
  const brainJarvis = createJarvisPanel(sharedAgentOptions);
  const intel = createIntelPanel({ key: () => adminKey });
  let intelLoaded = false;
  const brainAgentBody = element('div', { hidden: true });
  const brainUnlockStatus = element('p', { className: 'studio-status' });
  brainUnlockStatus.setAttribute('role', 'status');
  let brainRole = 'systems';

  const brainCredential = input('', 512);
  brainCredential.type = 'password';
  brainCredential.required = true;
  const brainUnlock = element('form', {
    className: 'studio-row',
    async onsubmit(event) {
      event.preventDefault();
      if (busy) return;
      const key = brainCredential.value;
      brainCredential.value = '';
      busy = true;
      brainCredential.disabled = true;
      try {
        adminKey = key;
        sync(await api(true));
        render();
        showBrainAgent();
      } catch (error) {
        adminKey = '';
        brainUnlockStatus.textContent = error.message;
      } finally {
        busy = false;
        brainCredential.disabled = false;
        render();
      }
    },
  }, field('Studio administrator key', brainCredential), element('button', { className: 'btn' }, 'Unlock JARVIS'), brainUnlockStatus);

  const avatarLabels = { systems: 'SY', market: 'MK', build: 'DEV', qc: 'QC' };
  const avatars = element('div', { className: 'brain-agent-avatars' });
  const avatarButtons = new Map();
  for (const [id, label] of Object.entries(avatarLabels)) {
    const control = element('button', {
      className: 'brain-agent-button', type: 'button',
      onclick() { brainRole = id; showBrainAgent(); },
    }, element('span', { className: 'brain-agent-avatar avatar-' + id }, label),
      id === 'build' ? 'Build developer' : agents[id]);
    control.firstElementChild.setAttribute('aria-hidden', 'true');
    control.setAttribute('aria-pressed', 'false');
    avatarButtons.set(id, control);
    avatars.append(control);
  }
  brainAgents.append(avatars, brainAgentBody);

  function showBrainAgent() {
    brainAgentBody.hidden = false;
    for (const [id, button] of avatarButtons) button.setAttribute('aria-pressed', String(id === brainRole));
    if (saved) {
      brainAgentBody.replaceChildren(brainJarvis);
      brainJarvis.selectAgent(brainRole);
    } else {
      brainAgentBody.replaceChildren(brainUnlock);
      brainCredential.focus();
    }
  }

  async function api(admin = false, command) {
    const headers = admin ? { 'x-lcp-studio-key': adminKey } : { 'x-lcp-key': dashboardKey };
    if (command) headers['content-type'] = 'application/json';
    const response = await fetch('/api/studio' + (admin ? '?admin=1' : ''), {
      method: command ? 'POST' : 'GET',
      headers,
      body: command ? JSON.stringify(command) : undefined,
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Studio request failed.');
    return data;
  }

  function refreshModules() {
    const current = view();
    const currentReport = report();
    moduleHost.hidden = current === 'studio';
    if (moduleHost.hidden) return;
    const visible = published.modules.filter(module => module.page === current);
    const health = visible.some(hasHealth) ? brainHealth() : undefined;
    const healthKey = health ? formatBrainHealth(health) : '';
    if (moduleView === current && moduleReport === currentReport && moduleConfig === published && moduleHealth === healthKey) return;
    moduleView = current;
    moduleReport = currentReport;
    moduleConfig = published;
    moduleHealth = healthKey;
    moduleHost.replaceChildren(...visible.map(module => moduleCard(module, currentReport, health)));
  }

  function apply(config) {
    validateConfig(config);
    published = config;
    config.tabs.forEach(({ id, title }, index) => {
      const tab = tabs.get(id);
      tab.textContent = title;
      const next = studioTab.parentElement.children[index];
      if (next !== tab) next.before(tab);
    });
    config.sales.forEach(({ id, hidden }, index) => {
      const widget = widgets.get(id);
      widget.hidden = hidden;
      const next = sales.children[index];
      if (next !== widget) next.before(widget);
    });
    refreshModules();
  }

  function sync(data) {
    saved = data;
    working = structuredClone(data.draft || data.published);
    baseline = JSON.stringify(working);
    preview = false;
    historySelection = data.history[1]?.version?.toString() || '';
    apply(data.published);
  }

  async function action(run, message) {
    if (busy) return;
    busy = true;
    status = '';
    render();
    try {
      await run();
      status = message;
    } catch (error) {
      status = error.message;
    } finally {
      busy = false;
      render();
    }
  }

  function move(rows, from, to) {
    rows.splice(to, 0, ...rows.splice(from, 1));
    preview = false;
    render();
  }

  function orderControls(rows, index, title) {
    return [-1, 1].map(offset => {
      const control = button(offset < 0 ? '↑' : '↓', () => move(rows, index, index + offset),
        index + offset < 0 || index + offset >= rows.length);
      control.setAttribute('aria-label', 'Move ' + title + (offset < 0 ? ' up' : ' down'));
      return control;
    });
  }

  function sortableRow(rows, index, ...controls) {
    const grip = element('span', { className: 'studio-grip', draggable: !busy, title: 'Drag to reorder' }, '⠿');
    grip.setAttribute('aria-hidden', 'true');
    grip.ondragstart = event => {
      dragged = { rows, index };
      event.dataTransfer.setData('text/plain', String(index));
      event.dataTransfer.effectAllowed = 'move';
    };
    grip.ondragend = () => { dragged = null; };
    const row = editorRow(grip, ...controls);
    row.ondragover = event => {
      if (dragged?.rows === rows && dragged.index !== index) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }
    };
    row.ondrop = event => {
      if (dragged?.rows !== rows) return;
      event.preventDefault();
      const from = dragged.index;
      dragged = null;
      if (from !== index) move(rows, from, index);
    };
    return row;
  }

  function editorRow(...nodes) {
    return element('div', { className: 'studio-row' }, ...nodes);
  }

  function render() {
    const feedback = element('p', { className: 'studio-status' }, status);
    feedback.setAttribute('role', 'status');
    if (!saved) {
      const credential = input('', 512);
      credential.type = 'password';
      credential.required = true;
      credential.autocomplete = 'off';
      const form = element('form', {
        className: 'studio-row',
        onsubmit(event) {
          event.preventDefault();
          adminKey = credential.value;
          action(async () => {
            try { sync(await api(true)); } catch (error) { adminKey = ''; throw error; }
          }, 'Administrator access granted.');
        },
      }, field('Studio administrator key', credential), element('button', { className: 'btn', disabled: busy }, 'Unlock'));
      credential.disabled = busy;
      root.replaceChildren(card('Development Studio', form, feedback));
      return;
    }

    const dirty = () => JSON.stringify(working) !== baseline;
    const save = button('Save draft', () => action(async () => {
      validateConfig(working);
      sync(await api(true, { action: 'save', revision: saved.revision, config: working }));
    }, 'Draft saved.'), busy || !dirty());
    const publish = button('Publish saved draft', () => {
      if (confirm('Publish the saved layout and modules to the dashboard?')) {
        action(async () => sync(await api(true, { action: 'publish', revision: saved.revision })), 'Draft published.');
      }
    }, busy || !saved.draft || dirty());

    function edited() {
      preview = false;
      previewHost.replaceChildren();
      save.disabled = !dirty();
      publish.disabled = !saved.draft || dirty();
      rollback.disabled = !historySelection || dirty();
      feedback.textContent = dirty() ? 'Unsaved changes.' : '';
    }

    const previewHost = element('div');
    function showPreview() {
      const layout = working.tabs.map(({ id, title }) => {
        const visibleSales = working.sales.filter(widget => !widget.hidden).map(widget => salesWidgets[widget.id]);
        return element('div', { className: 'studio-preview' },
          element('h3', {}, title),
          ...(id === 'sales' ? [element('p', {}, visibleSales.join(' · ') || 'All built-in Sales groups hidden')] : []),
          ...working.modules.filter(module => module.page === id).map(module => moduleCard(module, report(), hasHealth(module) ? brainHealth() : undefined)));
      });
      previewHost.replaceChildren(...layout);
    }
    const check = button('Preview draft', () => {
      try {
        validateConfig(working);
        preview = true;
        showPreview();
        feedback.textContent = 'Configuration passed validation. Preview uses the current dashboard report.';
      } catch (error) {
        feedback.textContent = error.message;
      }
    }, busy);

    const releasePicker = element('select', { className: 'ctl', disabled: busy, onchange() {
      historySelection = releasePicker.value;
      rollback.disabled = !historySelection || dirty();
    } });
    releasePicker.add(new Option('Select a release', ''));
    for (const release of saved.history.slice(1)) {
      const date = release.at ? ' · ' + new Date(release.at).toLocaleString() : '';
      releasePicker.add(new Option('Version ' + release.version + ' · ' + release.action + date, String(release.version)));
    }
    releasePicker.value = historySelection;
    const rollback = button('Restore release', () => {
      if (confirm('Restore this release on the dashboard?')) {
        action(async () => sync(await api(true, {
          action: 'rollback', revision: saved.revision, version: Number(historySelection),
        })), 'Release restored.');
      }
    }, busy || !historySelection || dirty());

    const navigation = card('Navigation', ...working.tabs.map((tab, index) => sortableRow(working.tabs, index,
      field(pages[tab.id], input(tab.title, 48, event => { tab.title = event.target.value; edited(); })),
      ...orderControls(working.tabs, index, pages[tab.id]),
    )));
    const salesLayout = card('Sales widgets', ...working.sales.map((widget, index) => {
      const visible = element('input', { type: 'checkbox', checked: !widget.hidden, onchange() {
        widget.hidden = !visible.checked;
        edited();
      } });
      return sortableRow(working.sales, index, field(salesWidgets[widget.id] + ' ', visible), ...orderControls(working.sales, index, salesWidgets[widget.id]));
    }));

    const modules = card('Modules', ...working.modules.map((module, index) => {
      const text = module.type === 'note' ? element('textarea', {
        className: 'ctl', value: module.text, maxLength: 1200, oninput(event) { module.text = event.target.value; edited(); },
      }) : select(metrics, module.metric, event => { module.metric = event.target.value; edited(); });
      return sortableRow(working.modules, index,
        field('Title', input(module.title, 80, event => { module.title = event.target.value; edited(); })),
        ...(module.type === 'panel' ? [element('span', {}, module.blocks.map(block => block.title).join(' · ')),
          ...(!hasHealth(module) ? [field('Page', select(pages, module.page, event => { module.page = event.target.value; edited(); }))] : [])]
          : hasHealth(module) ? [element('span', {}, 'Brain 3D · Live system health')] : [
          field('Page', select(pages, module.page, event => { module.page = event.target.value; edited(); })),
          field(module.type === 'note' ? 'Note' : 'Report KPI', text),
        ]),
        ...orderControls(working.modules, index, module.title),
        button('Remove', () => { working.modules.splice(index, 1); preview = false; render(); }),
      );
    }));
    function addModule(type) {
      const id = crypto.randomUUID();
      const data = type === 'note' ? { title: 'New note', text: 'Add your note here.' } : { title: 'New KPI', metric: 'dials' };
      if (type === 'health') working.modules.push({ id, type, page: 'brain', title: 'System health' });
      else working.modules.push({ id, type, page: 'sales', ...data });
      preview = false;
      render();
    }
    modules.append(element('div', { className: 'studio-actions' },
      button('Add note', () => addModule('note'), working.modules.length >= 20),
      button('Add system health', () => addModule('health'), working.modules.length >= 20),
      button('Add KPI', () => addModule('metric'), working.modules.length >= 20),
    ));

    const reload = button('Reload', () => {
      if (!dirty() || confirm('Discard unsaved changes and reload?')) {
        action(async () => sync(await api(true)), 'Studio reloaded.');
      }
    }, busy);
    if (preview) showPreview();
    root.replaceChildren(
      card('Development Studio', feedback, element('div', { className: 'studio-actions' }, save, check, publish, reload),
        element('div', { className: 'studio-actions' }, field('Release history', releasePicker), rollback), previewHost),
      element('div', { className: 'studio-grid' }, navigation, salesLayout),
      modules,
      jarvis,
      intel,
    );
    if (adminKey && saved && !intelLoaded) { intelLoaded = true; intel.refresh(); }
    if (busy) root.querySelectorAll('input,button,textarea,select').forEach(control => {
      if (!jarvis.contains(control) && !intel.contains(control)) control.disabled = true;
    });
  }

  render();
  // Keep the source layout when Studio storage is unavailable.
  api().then(data => { if (!saved) apply(data.published); }).catch(() => {});
  return { refreshModules };
}
