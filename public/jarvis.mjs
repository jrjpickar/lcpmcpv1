import { brainEditMessage, brainHealthIntent, formatBrainHealth } from './jarvis-intent.mjs';

const agents = {
  systems: 'Systems and KPIs',
  market: 'Market news and improvement',
  build: 'Build developer → QC developer',
  qc: 'QC developer',
};

const examples = {
  systems: 'Review KPI changes and identify the top three actions.',
  market: 'Summarize the implications for seller outreach in my market. Specify the market here.',
  build: 'Add an Opportunities KPI to Sales and a short follow-up checklist.',
  qc: 'Check whether the current modules display the intended KPIs and contain clear instructions.',
};

function node(tag, properties, ...children) {
  const result = Object.assign(document.createElement(tag), properties);
  result.append(...children);
  return result;
}

export function createJarvisPanel({ key, filters, brainHealth, openBrain, draftModules, importModules }) {
  const role = node('select', { className: 'ctl' });
  for (const [id, label] of Object.entries(agents)) role.add(new Option(label, id));
  const prompt = node('textarea', { className: 'ctl', required: true, maxLength: 1000, placeholder: examples.systems });
  const previousTasks = new Map();
  role.onchange = () => { prompt.placeholder = examples[role.value]; };
  const run = node('button', { className: 'btn', type: 'submit' }, 'Run agent');
  const status = node('p', { className: 'studio-status' });
  status.setAttribute('role', 'status');
  const output = node('div', {});
  const form = node('form', { className: 'studio-row' },
    node('label', {}, 'Agent', role), node('label', {}, 'Task', prompt), run);
  const panel = node('section', { className: 'card studio-card' }, node('h2', {}, 'JARVIS'), form, status, output);

  form.onsubmit = async event => {
    event.preventDefault();
    if (run.disabled) return;
    const task = prompt.value.trim();
    if (!task) return;
    const previousTask = previousTasks.get(role.value) || '';
    const intent = ['build', 'systems'].includes(role.value) ? brainHealthIntent(task, previousTask) : null;
    output.replaceChildren();
    if (intent === 'read' || intent === 'edit') {
      previousTasks.set(role.value, task);
      status.textContent = 'Brain 3D · System health';
      const answer = intent === 'read' ? formatBrainHealth(brainHealth()) : brainEditMessage;
      output.append(node('p', { className: 'studio-config-note' }, answer),
        node('button', { className: 'btn', type: 'button', onclick: openBrain }, 'Open Brain 3D'));
      return;
    }
    role.disabled = prompt.disabled = run.disabled = true;
    status.textContent = 'Running agent…';
    try {
      const command = { role: role.value, prompt: task, previousTask };
      if (command.role === 'systems') command.filters = filters();
      if (command.role === 'qc') command.modules = draftModules();
      const response = await fetch('/api/jarvis', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lcp-studio-key': key() },
        body: JSON.stringify(command),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'JARVIS request failed.');
      previousTasks.set(role.value, task);
      status.textContent = [result.trace.map(id => id === 'build' ? 'Build developer' : agents[id] || id).join(' → '),
        typeof result.approved === 'boolean' ? (result.approved ? 'QC passed' : 'Changes needed') : 'Complete'].join(' · ');
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
      role.disabled = prompt.disabled = run.disabled = false;
    }
  };
  return panel;
}
