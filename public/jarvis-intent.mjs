// Keep the common Brain health lookup tied to the dashboard's measured status.
export function brainHealthIntent(prompt, previousTask = '') {
  const topic = /\b(?:system|integration|connector) health\b|\bhealth (?:check|status|panel)\b/i;
  const brain = /\bbrain\b/i;
  const correction = /^\s*(?:i mean|actually|instead|for the|on the)\b/i;
  const currentTask = correction.test(prompt) ? previousTask + '\n' + prompt : prompt;
  if (!topic.test(currentTask) || !brain.test(currentTask)) return null;
  if (/^\s*(?:(?:actually|please)[,\s]+)?(?:show|check|read|report|summarize|how|what|is|are)\b/i.test(prompt)) return 'read';
  if (/\b(?:add|create|build|change|modify|replace|redesign|edit|move|rename|remove|duplicate)\b/i.test(currentTask)) {
    if (/\b(?:static|plain[- ]text) note\b/i.test(currentTask)) return null;
    if (/^\s*(?:(?:actually|please)[,\s]+)?(?:show|check|read|report|summarize|how|what|is|are)\b/i.test(prompt)) return 'read';
  if (/\b(?:add|create|build)\b/i.test(currentTask) && /\b(?:card|module|widget|panel)\b/i.test(currentTask)
        && !/\b(?:edit|replace|modify|redesign|remove|rename|move)\b/i.test(currentTask)) return 'build';
    return 'edit';
  }
  return 'read';
}

export const brainEditMessage = 'Brain 3D already has a live System health panel. Ask for a new live health card to add one to Brain 3D. Editing the built-in panel requires a code change.';

export function formatBrainHealth({ sources = [], sample = false } = {}) {
  if (!sources.length) return 'Open Brain 3D to load its System health checks.';
  return [
    sample ? 'Brain 3D system health (sample data)' : 'Latest status available to Brain 3D',
    ...sources.map(({ name, status, detail }) => name + ' · ' + ({ ok: 'OK', warn: 'Warning', down: 'Unavailable', off: 'Not checked' }[status] || 'Unknown') + ' · ' + detail),
  ].join('\n');
}
