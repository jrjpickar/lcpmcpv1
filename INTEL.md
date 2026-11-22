# JARVIS Intel

Gives the JARVIS models knowledge beyond the MCP data. It runs on the setup you already have: GitHub repo, Netlify (functions + Blobs) and the Google Cloud VM container. No new paid service is needed.

## What it adds

| Area | Where | Notes |
|---|---|---|
| Live data | existing MCP tools | Unchanged. Treated as authoritative. Cited as `[L1]`. |
| Web research | `lib/intel/web.mjs`, `fetch.mjs` | Self-hosted SearXNG on the VM (no API key, no per-search cost). Wikipedia, GitHub and npm need no key. https only, public IPs only, 1 MB cap, passages only. Cited as `[W1]` with URL and retrieval time. |
| Internal documents (RAG) | `lib/intel/knowledge.mjs` | Upload md, txt, csv, json, html, code, PDF (simple text PDFs), or index a GitHub repo listed in `INTEL_REPOS`. BM25 keyword search, plus semantic search when Workers AI or Gemini embeddings are available. Versioned by content hash or Git blob sha. Stale files are pruned. Cited as `[K1]`. |
| Memory | `lib/intel/memory.mjs` | Decisions, preferences, bugs, fixes, deployments, research, open items. Deduplicated, per-kind TTL, purge, delete. Never stores secrets. Cited as `[M1]`. |
| Scopes | `INTEL_SCOPES` | `lcp`, `a2z`, `shared`. Default `lcp,shared`. Enforced on every read and write. |
| Tool registry | `lib/intel/tools.mjs` | LCP MCP tools, intel tools and tools found on other MCP servers (`INTEL_MCP_SERVERS`). Each tool has a capability and a risk level. Read tools run directly. Write, draft, communication, financial, destructive and deploy tools need operator approval: one time, expires after 10 minutes, Studio key only. |
| Shared context | `lib/intel/context.mjs` | One compact context per task. Each section has a budget. Retrieved text sits in an `<evidence>` block as untrusted data. |
| Model routing | `lib/intel/router.mjs` | Regex classes: research, coding, debugging, data, operations, planning, verification. Groq first, then Gemini, then Workers AI. 429 and 5xx put the model on a cooldown that is shared through storage. Override with `INTEL_ROUTES`. |
| Usage and cost | `lib/model-log.mjs` (from A2Z) | One row per model call. Cost estimates come only from `MODEL_PRICES`. If it is not set, calls count as free tier ($0). |
| Dev runner | `server/dev-runner.mjs` (VM only) | Downloads a `DEV_REPOS` repo into an isolated folder and runs `npm ci --ignore-scripts` and the test, build and lint scripts only (no shell). The child process gets no secrets. Retries up to 3 times, then returns a patch and a ZIP of the changed files. Never pushes or deploys. |
| JARVIS | `research` agent | The dispatcher sends "research", "look up", "docs", "what did we decide" and similar requests to it. In chat mode, every agent also gets a short summary of matching memory. Slack: `research:`. |
| UI | Studio, **JARVIS Intel** panel | Knowledge sources, providers, ask with sources, memory, documents, tools and approvals, tasks and audit, usage and cost, dev tasks. |
| MCP | `/mcp` | Scoped tokens from A2Z (`MCP_TOKENS`). `MCP_INTEL_TOOLS=1` adds knowledge, memory, web search and web fetch tools. |

Every answer lists its source types: live MCP data, internal docs, memory, web research, or model reasoning (no citations). Failed steps and model attempts are shown in the task. Nothing is invented on failure.

## Where things run

- **Netlify:** `/api/intel` (fast research, about 8 s), the Intel panel, approvals, document uploads. Deep research and repo indexing go to `intel-worker-background` (up to 15 minutes; your Netlify plan must include background functions).
- **SearXNG:** runs as a second container on the VM (`deploy/searxng/settings.yml`, 256 MB limit, no published port). Only the VM can reach it, so web search through SearXNG happens in VM jobs. Set `INTEL_WORKER_ON=vm` on Netlify and the VM so deep research runs there. Fast research on Netlify uses Wikipedia, GitHub and npm unless `SEARXNG_URL` points to an instance Netlify can reach.
- **VM container:** the dev runner (`DEV_RUNNER=1`), the queue worker (`INTEL_WORKER_ON=vm`, every minute), the daily `INTEL_REPOS` re-index at 3:10 Pacific, and Slack Socket Mode (`SLACK_APP_TOKEN`). VM storage is SQLite at `/data/jarvis.sqlite` (persistent volume) unless Supabase is set.
- **Storage:** Netlify Blobs `lcp-jarvis`, or Supabase `lcp_jarvis_kv` (same table, no new migration). Set Supabase on both Netlify and the VM so they share memory, documents, tasks and dev results. Without it, the VM dev runner cannot see tasks queued on Netlify.

## Environment variables (all optional)

| Variable | Use |
|---|---|
| `INTEL_SCOPES` | Allowed scopes, default `lcp,shared` |
| `SEARXNG_URL`, `SEARXNG_SECRET` | General web search through the SearXNG compose service (`http://searxng:8080`). Optional `SEARXNG_TOKEN`, `SEARXNG_CATEGORIES`, `SEARXNG_LANGUAGE`. Without it: Wikipedia, GitHub, npm only |
| `GITHUB_TOKEN` | Read-only token. Higher GitHub rate limits, private repos for indexing and the dev runner |
| `INTEL_WEB=off` | Turns web research off |
| `INTEL_REPOS` | `owner/repo` list allowed for indexing |
| `INTEL_EMBEDDINGS` | `auto` (default), `cloudflare`, `gemini`, `off`. Reuses the existing Workers AI or Gemini keys |
| `INTEL_MCP_SERVERS` | JSON: `[{"name":"a2z","url":"https://.../mcp","tokenEnv":"A2Z_MCP_TOKEN","scope":"a2z","allowWrite":false}]` |
| `INTEL_ROUTES`, `INTEL_GROQ_LARGE_MODEL` | Routing overrides. Large model default `openai/gpt-oss-120b` |
| `INTEL_SYNC_BUDGET_MS` | Fast research budget, default 8000 |
| `INTEL_WORKER_ON=vm` | The VM runs deep tasks instead of the Netlify background function |
| `INTEL_MEMORY_TTL_DAYS` | JSON per kind, for example `{"task":60}` |
| `MODEL_PRICES` | JSON `{"model":[inUsdPerM,outUsdPerM]}` for cost estimates |
| `MODEL_LOG=off` | Turns off the model call log |
| `MCP_TOKENS`, `MCP_INTEL_TOOLS=1` | Scoped MCP tokens (SHA-256 of the token) and the intel MCP tools |
| `DEV_RUNNER=1`, `DEV_REPOS`, `DEV_MAX_ATTEMPTS`, `DEV_TASK_MINUTES`, `DEV_COMMAND_SECONDS`, `DEV_WORKDIR` | VM dev runner |
| `SLACK_APP_TOKEN` | Slack Socket Mode on the VM. Then remove the Events API URL in Slack |

## Security

- Keys stay server-side. Tool listings show only env variable names. The dev runner's child processes get PATH, HOME and the npm cache, nothing else.
- Retrieved text is cleaned (role markers and "ignore previous instructions" phrases are removed), wrapped as evidence, and cannot trigger tools.
- Every POST needs the Studio key, a same-origin Origin header and JSON. Tool arguments are checked against their schema.
- The audit log (`intel/audit`, last 300 rows) redacts secrets, emails and phone numbers.
- Dev runner limits: one task at a time, path checks (no `..`, `.git`, `node_modules`, `.env` or symlink escapes), fixed commands, timeouts, output tails only, 256 MB child heap. It runs repo test code, so add only repos you trust to `DEV_REPOS`.

## Free-tier usage

- Fast research: 1 model call. Deep research: 1 or 2 calls (the second is verification). Memory digest for agents: no model call.
- Embeddings: one batch call per new or changed document, and one per search query (cached).
- Web: one search call per query, cached 6 hours. Keyless sources are rate limited by their providers.
- Web search through SearXNG has no API cost. It sends queries to public engines from the VM's address, so engines may rate limit heavy use.
- Paid only if you choose it: a Supabase plan beyond free, and Netlify background functions if your plan does not include them.
