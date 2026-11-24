// Tool registry: built-in LCP MCP tools, intel tools, and tools discovered on other MCP servers (INTEL_MCP_SERVERS).
// Every tool has a capability, a risk level and the env names it needs. Credentials stay server-side: only env NAMES are listed,
// and tokens are read at call time. Read tools run directly. Every other risk (write, draft, communication, financial,
// destructive, deploy) returns an approval request; only the operator can approve it, from the dashboard, with the Studio key.
// Model output can request a tool, never approve one.
import { randomUUID } from 'node:crypto';
import { TOOLS as LCP_TOOLS, callTool as callLcpTool } from '../../mcp.mjs';
import { readJson } from './fetch.mjs';
import { clip, sha256 } from './text.mjs';
import { allowedScopes } from './knowledge.mjs';
import { redact } from './safety.mjs';
import { createOpportunity, kv } from '../ghl-write.mjs';

export const RISKS = ['read', 'draft', 'write', 'communication', 'financial', 'destructive', 'deploy'];
export const CAPABILITIES = ['operational', 'web', 'knowledge', 'memory', 'development', 'communication', 'finance', 'other'];

// Small JSON Schema subset validator for tool arguments: type, properties, required, enum, additionalProperties,
// minimum, maximum, minLength, maxLength, items, format uuid.
export function validateArgs(schema, value, path = 'args') {
  const errors = [];
  const check = (s, v, p) => {
    if (!s || typeof s !== 'object') return;
    const type = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v;
    if (s.type) {
      const ok = s.type === 'integer' ? Number.isInteger(v) : s.type === 'number' ? typeof v === 'number' && Number.isFinite(v) : s.type === type;
      if (!ok) { errors.push(p + ' must be ' + s.type); return; }
    }
    if (s.enum && !s.enum.includes(v)) errors.push(p + ' must be one of ' + s.enum.join(', '));
    if (typeof v === 'string') {
      if (s.maxLength !== undefined && v.length > s.maxLength) errors.push(p + ' is longer than ' + s.maxLength);
      if (s.minLength !== undefined && v.length < s.minLength) errors.push(p + ' is shorter than ' + s.minLength);
      if (s.format === 'uuid' && !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(v)) errors.push(p + ' must be a UUID');
    }
    if (typeof v === 'number') {
      if (s.minimum !== undefined && v < s.minimum) errors.push(p + ' is below ' + s.minimum);
      if (s.maximum !== undefined && v > s.maximum) errors.push(p + ' is above ' + s.maximum);
    }
    if (type === 'array' && s.items) v.slice(0, 100).forEach((item, i) => check(s.items, item, p + '[' + i + ']'));
    if (type === 'object') {
      for (const name of s.required || []) if (v[name] === undefined) errors.push(p + '.' + name + ' is required');
      for (const [name, item] of Object.entries(v)) {
        if (s.properties?.[name]) check(s.properties[name], item, p + '.' + name);
        else if (s.additionalProperties === false) errors.push(p + '.' + name + ' is not allowed');
      }
    }
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['args must be an object'];
  check(schema || { type: 'object' }, value, path);
  return errors.slice(0, 10);
}

// Risk from MCP annotations first, then the tool name. Unknown non-read tools default to write (approval required).
export function classifyTool({ name = '', description = '', annotations = {} }) {
  const text = (name.replace(/_/g, ' ') + ' ' + description).toLowerCase();
  let risk = 'read';
  if (/\b(?:deploy|publish|release|rollback|promote)\b|_deploy|deploy_/.test(text)) risk = 'deploy';
  else if (/\b(?:pay|payment|charge|refund|invoice|transfer|payout|purchase|billing)\b/.test(text)) risk = 'financial';
  else if (/\b(?:send|post|reply|sms|text message|email|call|notify|message|tweet|dm)\b/.test(name.toLowerCase().replace(/_/g, ' '))) risk = 'communication';
  else if (annotations.destructiveHint === true || /\b(?:delete|remove|drop|purge|destroy|archive|cancel)\b/.test(name.toLowerCase().replace(/_/g, ' '))) risk = 'destructive';
  else if (annotations.readOnlyHint === true) risk = 'read';
  else if (/\b(?:draft)\b/.test(name.toLowerCase().replace(/_/g, ' '))) risk = 'draft';
  else if (annotations.readOnlyHint === false || /\b(?:create|update|set|write|add|edit|upsert|patch|insert|enroll|assign|move|tag)\b/.test(name.toLowerCase().replace(/_/g, ' '))) risk = 'write';
  if (annotations.readOnlyHint === true && risk !== 'read' && !/deploy|financial/.test(risk)) risk = 'read';
  const capability = /web|search|fetch|github|research/.test(text) ? 'web' : /knowledge|document|index/.test(text) ? 'knowledge' : /memory|remember/.test(text) ? 'memory'
    : risk === 'financial' || /accounting|ledger|fees|p&l/.test(text) ? 'finance' : risk === 'communication' ? 'communication' : /repo|code|test|build|dev/.test(text) ? 'development' : 'operational';
  return { risk, capability };
}

export function mcpServers(env = process.env) {
  let list = [];
  try { list = JSON.parse(env.INTEL_MCP_SERVERS || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  const scopes = allowedScopes(env);
  return list.filter(s => s && /^[a-z][a-z0-9-]{1,30}$/.test(s.name) && typeof s.url === 'string' && (/^https:\/\//.test(s.url) || /^http:\/\/127\.0\.0\.1(?::\d+)?\//.test(s.url))
    && (!s.tokenEnv || /^[A-Z][A-Z0-9_]{2,60}$/.test(s.tokenEnv)) && scopes.includes(s.scope || 'shared'))
    .slice(0, 8).map(s => ({ name: s.name, url: s.url, tokenEnv: s.tokenEnv || null, scope: s.scope || 'shared', allowWrite: s.allowWrite === true }));
}

const discovery = new Map();

export function createRegistry({ env = process.env, fetchImpl = fetch, store = null, services = {}, now = Date.now } = {}) {
  // services: { web, knowledge, facts, dev } supplied by the caller (keeps this module free of storage wiring).
  const builtin = [
    ...LCP_TOOLS.map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema,
      source: 'lcp', capability: tool.name === 'accounting_summary' ? 'finance' : 'operational', risk: 'read', requires: [], authoritative: true,
      run: args => callLcpTool(tool.name, args) })),
    { name: 'web_search', title: 'Web search', description: 'Search the public web (self-hosted SearXNG), GitHub, npm or Wikipedia. Returns titles, URLs, snippets and retrieval times.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 300 }, kinds: { type: 'array', items: { type: 'string', enum: ['searxng', 'github', 'npm', 'wikipedia'] } } }, required: ['query'], additionalProperties: false },
      source: 'intel', capability: 'web', risk: 'read', requires: [], optional: ['SEARXNG_URL', 'GITHUB_TOKEN'], run: args => services.web.search(args.query, { kinds: args.kinds }) },
    { name: 'web_fetch', title: 'Read a web page', description: 'Fetch one public https page and return the passages relevant to a question, with the final URL and retrieval time.',
      inputSchema: { type: 'object', properties: { url: { type: 'string', maxLength: 2000 }, question: { type: 'string', maxLength: 500 } }, required: ['url'], additionalProperties: false },
      source: 'intel', capability: 'web', risk: 'read', requires: [], run: args => services.web.read(args.url, args.question) },
    { name: 'github_read', title: 'Read GitHub', description: 'Read a GitHub repository README, a directory listing or one file (owner/repo[/path] or a github.com URL).',
      inputSchema: { type: 'object', properties: { target: { type: 'string', maxLength: 400 } }, required: ['target'], additionalProperties: false },
      source: 'intel', capability: 'web', risk: 'read', requires: [], optional: ['GITHUB_TOKEN'], run: args => services.web.github(args.target) },
    { name: 'knowledge_search', title: 'Search internal documents', description: 'Search indexed repository files, SOPs, PDFs and CSVs (keyword plus semantic when embeddings are configured).',
      inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 500 }, limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['query'], additionalProperties: false },
      source: 'intel', capability: 'knowledge', risk: 'read', requires: [], run: args => services.knowledge.search(args.query, { limit: args.limit }) },
    { name: 'memory_search', title: 'Search memory', description: 'Search durable memory: decisions, preferences, bugs and fixes, deployments, research and open items.',
      inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 300 }, kinds: { type: 'array', items: { type: 'string' } } }, additionalProperties: false },
      source: 'intel', capability: 'memory', risk: 'read', requires: [], run: args => services.facts.search(args.query || '', { kinds: args.kinds }) },
    { name: 'memory_write', title: 'Save to memory', description: 'Save a decision, preference, bug, fix, deployment note, research finding or open item. Never secrets.',
      inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 1200 }, kind: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, scope: { type: 'string', enum: ['lcp', 'a2z', 'shared'] } }, required: ['text'], additionalProperties: false },
      source: 'intel', capability: 'memory', risk: 'write', requires: [], run: args => services.facts.add(args, { scope: args.scope || 'lcp', by: 'approved tool call' }) },
    // GHL write (ported A2Z rule): JARVIS can only request it; it runs after the operator approves in the dashboard.
    // On approval it rebuilds the preview live, refuses duplicates and writes once. Never on MCP.
    { name: 'lcp_create_opportunity', title: 'Create a GHL opportunity', description: 'Create an ACQ or Retail opportunity for a GHL contact after operator approval. Refuses when the contact already has an open opportunity in that pipeline.',
      inputSchema: { type: 'object', properties: { contactId: { type: 'string', maxLength: 64 }, pipeline: { type: 'string', maxLength: 80 }, stage: { type: 'string', maxLength: 80 }, name: { type: 'string', maxLength: 120 }, assignedTo: { type: 'string', maxLength: 80 }, monetaryValue: { type: 'number', minimum: 0 } }, required: ['contactId'], additionalProperties: false },
      source: 'lcp', capability: 'operational', risk: 'write', requires: ['GHL_WRITE_TOKEN'], authoritative: true,
      run: async args => {
        const writeStore = kv(store);
        const preview = await createOpportunity({ dryRun: true, args }, { env, fetchImpl, store: writeStore });
        return createOpportunity({ dryRun: false, args, hash: preview.hash, idempotencyKey: randomUUID(), actor: 'JARVIS (operator approved)' }, { env, fetchImpl, store: writeStore });
      } },
    { name: 'dev_task', title: 'Start a sandboxed development task', description: 'Queue a code change on an allowlisted repository. Runs on the VM in an isolated workspace, runs tests, returns a patch ZIP. Never deploys.',
      inputSchema: { type: 'object', properties: { repo: { type: 'string', maxLength: 120 }, objective: { type: 'string', maxLength: 2000 }, ref: { type: 'string', maxLength: 100 } }, required: ['repo', 'objective'], additionalProperties: false },
      source: 'intel', capability: 'development', risk: 'write', requires: ['DEV_REPOS'], run: args => services.dev.create(args) },
  ];

  async function discover({ fresh = false } = {}) {
    const out = [];
    await Promise.all(mcpServers(env).map(async server => {
      const cached = discovery.get(server.name);
      if (!fresh && cached && now() - cached.at < 600000) { out.push(cached.value); return; }
      const token = server.tokenEnv ? env[server.tokenEnv]?.trim() : '';
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: 'Bearer ' + token } : {}) };
      const rpc = (id, method, params = {}) => readJson(server.url, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(5000) }, { fetchImpl });
      let value;
      try {
        if (server.tokenEnv && !token) throw new Error(server.tokenEnv + ' is not set');
        await rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'lcp-jarvis', version: '1.0.0' } });
        const list = await rpc(2, 'tools/list');
        const tools = (list.result?.tools || []).slice(0, 100).map(tool => {
          const { risk, capability } = classifyTool(tool);
          return { name: server.name + '__' + String(tool.name).replace(/[^\w-]/g, '_').slice(0, 64), remoteName: tool.name, title: tool.title || tool.name,
            description: clip(tool.description || '', 400), inputSchema: tool.inputSchema || { type: 'object' }, annotations: tool.annotations || {},
            source: 'mcp:' + server.name, scope: server.scope, capability, risk, requires: server.tokenEnv ? [server.tokenEnv] : [], authoritative: true };
        });
        value = { server: server.name, scope: server.scope, status: 'ok', tools, at: new Date(now()).toISOString() };
      } catch (error) {
        value = { server: server.name, scope: server.scope, status: 'unavailable', error: clip(redact(error.message), 160), tools: [], at: new Date(now()).toISOString() };
      }
      discovery.set(server.name, { at: now(), value });
      out.push(value);
    }));
    return out;
  }

  function availability(tool) {
    const missing = (tool.requires || []).filter(name => !env[name]?.trim());
    if (tool.name === 'web_search' && env.INTEL_WEB === 'off') return { available: false, reason: 'INTEL_WEB=off' };
    return missing.length ? { available: false, reason: 'Missing ' + missing.join(', ') } : { available: true };
  }

  async function list({ fresh = false } = {}) {
    const remote = await discover({ fresh });
    const tools = [...builtin, ...remote.flatMap(server => server.tools)].map(({ run, ...tool }) => ({ ...tool, ...availability(tool), approval: tool.risk === 'read' ? 'none' : 'operator' }));
    return { tools, servers: remote };
  }

  // Deterministic tool selection for a task: capabilities wanted -> available read tools. Never selects non-read tools.
  async function select(capabilities) {
    const { tools } = await list();
    return tools.filter(tool => tool.available && tool.risk === 'read' && capabilities.includes(tool.capability));
  }

  async function find(name) {
    const local = builtin.find(tool => tool.name === name);
    if (local) return local;
    const remote = (await discover()).flatMap(server => server.tools).find(tool => tool.name === name);
    if (!remote) return null;
    const server = mcpServers(env).find(s => 'mcp:' + s.name === remote.source);
    return { ...remote, run: async args => {
      if (remote.risk !== 'read' && !server.allowWrite) throw Object.assign(new Error('Writes to ' + server.name + ' are disabled. Set allowWrite in INTEL_MCP_SERVERS.'), { status: 403 });
      const token = server.tokenEnv ? env[server.tokenEnv]?.trim() : '';
      const data = await readJson(server.url, { method: 'POST', signal: AbortSignal.timeout(15000),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name: remote.remoteName, arguments: args } }) }, { fetchImpl });
      if (data.error) throw new Error('MCP error ' + data.error.code + ': ' + clip(data.error.message, 160));
      if (data.result?.isError) throw new Error(clip(data.result.content?.[0]?.text || 'Tool returned an error.', 200));
      return data.result?.structuredContent ?? data.result?.content;
    } };
  }

  // Run a tool. Read tools run now. Others store an approval request (10 minutes) and return it without running.
  async function execute(name, args = {}, { by = 'operator' } = {}) {
    const tool = await find(name);
    if (!tool) return { status: 'error', error: 'Unknown or unavailable tool: ' + name };
    const { available, reason } = availability(tool);
    if (!available) return { status: 'unavailable', tool: name, error: reason };
    const errors = validateArgs(tool.inputSchema, args);
    if (errors.length) return { status: 'invalid', tool: name, errors };
    if (tool.risk !== 'read') {
      if (!store) return { status: 'error', error: 'Approvals need storage.' };
      const id = randomUUID();
      const request = { id, tool: name, args, risk: tool.risk, by, hash: sha256(name + JSON.stringify(args)), createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 600000).toISOString() };
      await store.setJSON('approvals/' + id, request);
      return { status: 'approval_required', approval: { id, tool: name, risk: tool.risk, args: JSON.parse(redact(args)), expiresAt: request.expiresAt } };
    }
    const started = now();
    try {
      const data = await tool.run(args);
      return { status: 'ok', tool: name, source: tool.source, authoritative: Boolean(tool.authoritative), ms: now() - started, data, retrievedAt: new Date(now()).toISOString() };
    } catch (error) {
      return { status: 'error', tool: name, ms: now() - started, error: clip(redact(error.message || 'Tool failed.'), 240) };
    }
  }

  // Operator approval. Runs exactly the stored tool and arguments once, then deletes the request.
  async function approve(id, { decision = 'approve', by = 'operator' } = {}) {
    if (!store || !/^[\da-f-]{36}$/i.test(String(id))) return { status: 'error', error: 'Invalid approval id.' };
    const entry = await store.getWithMetadata('approvals/' + id, { type: 'json' });
    const request = entry?.data;
    if (!request || request.used) return { status: 'error', error: 'Approval not found or already used.' };
    // Claim it with a conditional write so two clicks cannot run it twice.
    const claimed = await store.setJSON('approvals/' + id, { ...request, used: true }, { onlyIfMatch: entry.etag });
    if (!claimed?.modified) return { status: 'error', error: 'Approval already used.' };
    store.delete('approvals/' + id).catch(() => {});
    if (Date.parse(request.expiresAt) < now()) return { status: 'expired', tool: request.tool };
    if (decision !== 'approve') return { status: 'rejected', tool: request.tool };
    const tool = await find(request.tool);
    if (!tool || sha256(request.tool + JSON.stringify(request.args)) !== request.hash) return { status: 'error', error: 'The approved request changed. Nothing ran.' };
    const started = now();
    try {
      const data = await tool.run(request.args);
      return { status: 'ok', tool: request.tool, approvedBy: by, ms: now() - started, data };
    } catch (error) {
      return { status: 'error', tool: request.tool, ms: now() - started, error: clip(redact(error.message || 'Tool failed.'), 240) };
    }
  }

  return { list, select, execute, approve, discover, availability };
}
