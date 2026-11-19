// Custom instructions form (like ChatGPT or Claude). Every JARVIS agent reads them on every reply.
// call(path, { method, body }) is the JARVIS panel's authenticated fetch. Text nodes only.
const el = (tag, props = {}, ...children) => {
  const result = Object.assign(document.createElement(tag), props);
  result.append(...children.filter(Boolean));
  return result;
};

export function instructionsForm({ call }) {
  const about = el('textarea', { className: 'ctl', rows: 4, maxLength: 1500, placeholder: 'e.g. I run systems, lead gen and dispositions at LocalCare Props, a direct-to-seller wholesaler in LA County. I care most about speed to lead, qualified sellers and fees.' });
  const style = el('textarea', { className: 'ctl', rows: 4, maxLength: 1500, placeholder: 'e.g. Lead with the answer. Short bullets. Numbers over adjectives. No em dashes.' });
  const enabled = el('input', { type: 'checkbox', checked: true });
  const status = el('p', { className: 'studio-status' });
  status.setAttribute('role', 'status');
  const save = el('button', { type: 'submit', className: 'btn' }, 'Save');
  const counter = area => {
    const label = el('small', { className: 'studio-status' });
    const draw = () => { label.textContent = area.value.length + ' / 1500'; };
    area.addEventListener('input', draw);
    draw();
    return { label, draw };
  };
  const aboutCount = counter(about), styleCount = counter(style);
  const form = el('form', { className: 'jarvis-instructions' },
    el('p', { className: 'studio-status' }, 'Every agent reads these on every reply: Groq, Goose, Gemini, Workers AI and custom bots. Company memory and safety rules still come first.'),
    el('label', { className: 'jarvis-field' }, el('span', {}, 'What should JARVIS know about you?'), about, aboutCount.label),
    el('label', { className: 'jarvis-field' }, el('span', {}, 'How should JARVIS respond?'), style, styleCount.label),
    el('label', { className: 'jarvis-inline' }, enabled, ' Use these instructions'),
    el('div', { className: 'studio-actions' }, save), status);
  const fill = data => {
    about.value = data.about || '';
    style.value = data.style || '';
    enabled.checked = data.enabled !== false;
    aboutCount.draw();
    styleCount.draw();
    status.textContent = data.updatedAt ? 'Last saved ' + new Date(data.updatedAt).toLocaleString() : '';
  };
  form.addEventListener('submit', async event => {
    event.preventDefault();
    save.disabled = true;
    status.textContent = 'Saving…';
    try {
      fill(await call('/api/jarvis-instructions', { method: 'POST', body: { about: about.value, style: style.value, enabled: enabled.checked } }));
      status.textContent = 'Saved. Every agent uses these from the next message.';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      save.disabled = false;
    }
  });
  form.load = async () => {
    status.textContent = 'Loading…';
    try { fill(await call('/api/jarvis-instructions')); } catch (error) { status.textContent = error.message; }
  };
  return form;
}
