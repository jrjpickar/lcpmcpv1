export const pages = { brain: 'Brain 3D', sales: 'Sales', workflows: 'Workflows', accounting: 'Accounting' };
export const salesWidgets = {
  kpis: 'KPIs', insights: 'Insights', signals: 'Signals', calls: 'Calls by rep',
  opportunities: 'Opportunities generated', paths: 'Conversion paths',
};
export const metrics = {
  dials: 'Dials', opportunities: 'Opportunities', smsSent: 'SMS sent',
  connectRate: 'Connect rate', talkMinutes: 'Talk minutes',
};

export const initialConfig = () => ({
  schema: 1,
  tabs: Object.entries(pages).map(([id, title]) => ({ id, title })),
  sales: Object.keys(salesWidgets).map(id => ({ id, hidden: false })),
  modules: [],
});

function check(condition, message) {
  if (!condition) throw new TypeError(message);
}

function fields(value, keys) {
  check(value && typeof value === 'object' && !Array.isArray(value), 'Expected a configuration object.');
  check(Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'Unexpected or missing configuration fields.');
}

function label(value, limit) {
  check(typeof value === 'string' && value.trim() && value.length <= limit, 'A label is empty or too long.');
}

function ordered(rows, allowed) {
  check(Array.isArray(rows) && rows.length === Object.keys(allowed).length, 'All built-in items must be present.');
  const remaining = new Set(Object.keys(allowed));
  for (const row of rows) check(remaining.delete(row?.id), 'Unknown or duplicate built-in item.');
}

export function validateConfig(config) {
  fields(config, ['schema', 'tabs', 'sales', 'modules']);
  check(config.schema === 1, 'Unsupported configuration version.');
  ordered(config.tabs, pages);
  for (const tab of config.tabs) {
    fields(tab, ['id', 'title']);
    label(tab.title, 48);
  }
  ordered(config.sales, salesWidgets);
  for (const widget of config.sales) {
    fields(widget, ['id', 'hidden']);
    check(typeof widget.hidden === 'boolean', 'Invalid widget visibility.');
  }
  check(Array.isArray(config.modules) && config.modules.length <= 20, 'A layout supports up to 20 modules.');
  const ids = new Set();
  for (const module of config.modules) {
    check(['note', 'metric', 'health'].includes(module?.type), 'Unsupported module type.');
    const valueFields = module.type === 'note' ? ['text'] : module.type === 'metric' ? ['metric'] : [];
    fields(module, ['id', 'page', 'title', 'type', ...valueFields]);
    check(typeof module.id === 'string' && /^[a-z0-9-]{1,48}$/.test(module.id) && !ids.has(module.id), 'Invalid or duplicate module ID.');
    ids.add(module.id);
    check(Object.hasOwn(pages, module.page), 'Unknown module destination.');
    label(module.title, 80);
    if (module.type === 'note') label(module.text, 1200);
    if (module.type === 'metric') check(Object.hasOwn(metrics, module.metric), 'Unknown report metric.');
    if (module.type === 'health') check(module.page === 'brain', 'System health cards belong on Brain 3D.');
  }
  return config;
}
