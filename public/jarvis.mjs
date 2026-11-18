import { brainEditMessage, brainHealthIntent, formatBrainHealth } from './jarvis-intent.mjs';

export const agents = {
  systems: 'Systems and KPIs',
  market: 'Market news and improvement',
  build: 'Build developer → QC developer',
  qc: 'QC developer',
};

const examples = {
  systems: 'Review KPI changes and identify the top three actions.',
  market: 'Summarize the implications for seller outreach in my market. Specify the market here.',
  build: 'Build a Brain panel with HighLevel opportunities, a trend, and live system health.',
  qc: 'Check whether the current modules display the intended KPIs and contain clear instructions.',
};

function node(tag, properties, ...children) {
  const result = Object.assign(document.createElement(tag), properties);
  result.append(...children);
  return result;
}

export function createJarvisPanel({ key, filters, brainHealth, openBrain, draftModules, importModules, previousTasks = new Map() }) {
  const role = node('select', { className: 'ctl' });
  for (const [id, label] of Object.entries(agents)) role.add(new Option(label, id));
  const prompt = node('textarea', { className: 'ctl', required: true, maxLength: 1000, placeholder: examples.systems });
  const engine = node('select', { className: 'ctl' });
  engine.add(new Option('Groq', 'groq'));
  engine.add(new Option('Goose', 'goose'));
  const engineField = node('label', { hidden: true }, 'Build engine', engine);
  role.onchange = () => {
    prompt.placeholder = examples[role.value];
    engineField.hidden = role.value !== 'build';
  };
  const run = node('button', { className: 'btn', type: 'submit' }, 'Run agent');
  const status = node('p', { className: 'studio-status' });
  status.setAttribute('role', 'status');
  const output = node('div', {});
  const form = node('form', { className: 'studio-row' },
    node('label', {}, 'Agent', role), engineField, node('label', {}, 'Task', prompt), run);
  const panel = node('section', { className: 'card studio-card' }, node('h2', {}, 'JARVIS'), form, status, output);

  form.onsubmit = async event => {
    event.preventDefault();
    if (run.disabled) return;
    const task = prompt.value.trim();
    if (!task) return;
    const requestedRole = role.value;
    const previousTask = previousTasks.get(requestedRole) || '';
    const intent = ['build', 'systems'].includes(role.value) ? brainHealthIntent(task, previousTask) : null;
    output.replaceChildren();
    if (intent === 'read' || intent === 'edit') {
      previousTasks.set(requestedRole, task);
      status.textContent = 'Brain 3D · System health';
      const answer = intent === 'read' ? formatBrainHealth(brainHealth()) : brainEditMessage;
      output.append(node('p', { className: 'studio-config-note' }, answer),
        node('button', { className: 'btn', type: 'button', onclick: openBrain }, 'Open Brain 3D'));
      return;
    }
    role.disabled = engine.disabled = prompt.disabled = run.disabled = true;
    status.textContent = 'Running agent…';
    try {
      const command = { role: requestedRole, prompt: task, previousTask };
      if (command.role === 'systems' || command.role === 'build') command.filters = filters();
      if (command.role === 'build') command.engine = engine.value;
      if (command.role === 'qc') command.modules = draftModules();
      const response = await fetch('/api/jarvis', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lcp-studio-key': key() },
        body: JSON.stringify(command),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'JARVIS request failed.');
      previousTasks.set(requestedRole, task);
      status.textContent = [result.engine === 'goose' ? 'Goose' : null, result.trace.map(id => id === 'build' ? 'Build developer' : agents[id] || id).join(' → '),
        typeof result.approved === 'boolean' ? (result.approved ? 'QC passed' : 'Changes needed') : 'Complete'].filter(Boolean).join(' · ');
      if (result.buildSummary) output.append(node('p', { className: 'studio-config-note' }, result.buildSummary));
      output.append(node('p', { className: 'studio-config-note' }, result.answer));
      if (result.unavailable?.length) output.append(node('p', {}, 'Unavailable sources: ' + result.unavailable.join(', ')));
      if (result.sources?.length) {
        const sources = node('ol', {});
        for (const source of result.sources) {
          const url = new URL(source.url);
          if (!['https://www.federalreserve.gov', 'https://www.census.gov'].includes(url.origin)) continue;
          sources.append(node('li', {}, node('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer' }, source.title),
            source.date ? ' · ' + source.date : ''));
        }
        output.append(sources);
      }
      if (result.modules?.length) {
        output.append(node('ul', {}, ...result.modules.map(module => node('li', {}, module.title + ' · ' + module.page))));
        const add = node('button', { type: 'button', className: 'btn' }, 'Add to Studio draft');
        add.onclick = () => {
          try {
            importModules(result.modules);
            add.disabled = true;
            status.textContent = 'Added to the editor. Preview and save the draft in Studio.';
          } catch (error) {
            status.textContent = error.message;
          }
        };
        output.append(add);
      }
    } catch (error) {
      status.textContent = error.message;
    } finally {
      role.disabled = engine.disabled = prompt.disabled = run.disabled = false;
    }
  };
  panel.selectAgent = id => {
    role.value = id;
    role.onchange();
    prompt.focus();
  };
  return panel;
}
