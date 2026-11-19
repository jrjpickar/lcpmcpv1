# JARVIS on Netlify

Apply this ZIP at the repository root. It includes both the Studio and the four agents. The existing `/api/jarvis` Netlify function runs JavaScript LangGraph. The Studio uses Netlify Blobs for drafts and releases.

## Configure

1. Run `openssl rand -hex 32` and copy the 64-character result.
2. In the Netlify site's environment variables, set `LCP_STUDIO_KEY` to that result for your deployment context. Include the Functions scope if enabled.
3. Set `GROQ_API_KEY` to an API key from a Groq Free project. Reuse the existing value if it already meets that condition. The agents use `openai/gpt-oss-20b` and surface quota errors. [Groq API keys](https://console.groq.com/keys) · [Groq free limits](https://console.groq.com/docs/rate-limits)
4. Commit the extracted files, including `package.json` and `package-lock.json`, then deploy through the site's existing workflow. Select Studio, enter the Studio key, and select a JARVIS agent.

The worker-based release's `LCP_JARVIS_URL`, `LCP_JARVIS_TOKEN`, and provider settings are obsolete. Netlify Functions and Netlify Blobs cover execution and persistence. Groq supplies inference.

## Agents

- **Systems and KPIs** reads the selected report and comparison period and sends aggregate metrics and status to the model.
- **Market news** reads Federal Reserve and Census housing feeds and proposes measurable improvements. The sources cover national information.
- **Build developer** generates declarative Note, KPI, live Brain health cards, and multi-block panels for the Studio.
- **QC developer** checks valid builds in a separate model call or reviews current draft modules. Approved builds can be imported into the editor and follow the existing preview, save, and publish workflow.

Repository code editing and executing generated code remain outside this patch.

## Chat history and learning

Each agent has its own saved chats, like ChatGPT. Select **New chat** to start one, or select a saved chat to continue it. Follow-ups send the last 6 turns to the model. Chats, feedback and learned memory are stored in the `lcp-jarvis` Netlify Blob store through `/api/jarvis-memory` and need the Studio key. The sandbox writes them to `.lcp-jarvis-local` (override with `LCP_JARVIS_LOCAL_DIR`).

Agents improve from use in four ways:

1. **Standing instructions.** Start a message with `remember:` or add one under **What this agent has learned**. The agent applies it to every later request.
2. **Ratings.** Select **Helpful** to save the reply as an approved example. The agent reuses the closest 2 approved examples (keyword match) as style guides for similar requests. Select **Needs work** and add a correction to teach it what to change.
3. **Reflection.** After every 5 ratings, or when you select **Reflect now**, one Groq call rewrites the agent's playbook (up to 10 rules) from its lessons and rated replies. Delete a lesson or select **Reset memory** to undo learning.
4. **QC feedback.** Build developer receives the 3 most recent QC rejections and is told not to repeat them. Automatic QC sees the chat but not the Build playbook, so its review stays independent.

The badge shows runs, the helpful rate and the count of active rules. Reflection needs `GROQ_API_KEY`.

## Local verification

Run `npm ci`, `npm test`, and `npm run build`. To use the local dashboard, export the two variables above and run `npm run sandbox`. It uses sample report data. Local tests exercise all four agent paths with fixture Groq responses. Live Groq inference and Netlify deployment require verification with your site and key.

## Brain 3D health

Ask “Show system health on Brain” to see the latest statuses available to Brain 3D. Ask “Add a live system health card on Brain” to create a draft that uses the same status data. The agents keep the preceding task for the selected role while Studio is open. A supported health card can be previewed, saved, and published through the registry.

Brain and legacy Ask default to `openai/gpt-oss-20b`. If Netlify explicitly sets `GROQ_MODEL` to a retired model, update it or clear the override. [Groq model deprecations](https://console.groq.com/docs/deprecations)

## Build from Brain

Choose one of the four avatars on Brain 3D to open a prompt for that agent. The Studio administrator key unlocks the same session on both tabs. For example, ask Build to “Build a Brain panel with opportunity count, opportunity trend, and live system health.” Build can request the filtered aggregate report before binding the blocks. QC checks the proposal, then you can import it into Studio, preview it, save the draft, and publish. Supported modules publish through Netlify Blobs without a repository edit or new deploy.

Panels can combine notes, report KPIs, report trends, and Brain status. Opportunity bindings use the existing HighLevel opportunity count and show a missing-source message when that read fails. The build service adds modules to the runtime catalog. Changes to the dashboard shell and new integrations need a platform update.

## Goose build engine

Select Build developer, then choose **Goose** under Build engine. Netlify runs the official Goose CLI headlessly with the existing Groq Free key. Report inspection and module validation run through the same site capabilities. Independent QC uses a direct Groq call. Each CLI run uses a temporary profile and a time limit. Shell and filesystem extensions are disabled.

The deployment packages the native Linux binary. The official CLI starts locally, and terminal tests cover the engine selection, subprocess boundary, and draft handoff with controlled responses. The Linux deployment and live inference still need a test deploy.

## JARVIS v2 (ported from A2Z)

Existing agents, Studio import, Goose and Brain avatars are unchanged. Added:

- **Chats.** Pin up to 10 chats per agent (pinned chats are never trimmed), search titles and messages, and export a chat as Markdown.
- **Company memory.** Type `remember for all agents: ...` or use the Company memory list in the Learning panel. Up to 20 entries of 300 characters. Every agent receives them, including automatic QC.
- **Custom instructions.** Open **Custom instructions (all agents)** under the chat. Saved at `settings/instructions` in JARVIS storage and added to every prompt (Groq, Goose, Gemini, Workers AI, custom bots).
- **Playbook versions.** Each reflection keeps the previous 3 playbooks. A new playbook is scored over its next 6 ratings. If its helpful rate falls 20 or more points below the previous version (which needs at least 3 ratings), the previous version is restored and logged. Restore any kept version by hand.
- **Custom bots.** Pick **+ New bot...** in the agent list. Each bot has its own instructions, chats and memory, and either no data or the LCP report for the selected filters. Up to 12 bots.
- **Gemini and Workers AI agents.** Optional second and third opinions with the selected report as context.
- **Token usage** shows on each reply. Groq `json_validate_failed` retries once without JSON mode, and other Groq errors show the error code.
- **History budget.** The last 6 messages, trimmed to `JARVIS_HISTORY_CHARS` (default 6000).

| Variable | Needed | Purpose |
|---|---|---|
| `JARVIS_GROQ_MODEL` | Optional | Overrides `openai/gpt-oss-20b` for the agents |
| `JARVIS_HISTORY_CHARS` | Optional | Chat history budget sent to the model, 1000 to 20000 |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | For Gemini | Default model `gemini-3.1-flash-lite` (stable ID, checked 2026-11-19) |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_AI_TOKEN`, `CLOUDFLARE_AI_MODEL` | For Workers AI | Token needs Workers AI permission. Default model `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Optional | Moves JARVIS storage from the Netlify Blobs store `lcp-jarvis` to the Supabase table `lcp_jarvis_kv`. Run `supabase/migrations/20261118000000_lcp_jarvis_kv.sql` in the Supabase SQL editor first. Keep the service key in Netlify Functions only. Existing Blobs chats are not copied |

Groq is still called only when you send a message or a reflection runs. Each JARVIS request now reads custom instructions once from storage.

## JARVIS v3 (second A2Z port)

Everything below is off until its variables are set. Existing tabs, Studio, Brain avatars, the `#key=` link and the Slack alert webhook are unchanged. HighLevel Marketplace sign-in is not included.

- **Main dispatcher.** Pick **Main (delegates)** in the agent list, or DM the Slack bot without a prefix. Keywords route most requests with no extra Groq call. Ambiguous requests use one short classifier call. The agent that answered learns from your rating.
- **Email agent (Gmail).** Reads your Google Workspace inbox: unread counts plus the 10 newest messages matching `JARVIS_GMAIL_QUERY` (default `in:inbox newer_than:7d`), up to 700 bytes of text each. `jarvis-mail-sync` refreshes the snapshot every 30 minutes with no model calls. Ask it to write or reply to an email and it shows the draft in chat with **Save as Gmail draft**, which calls Gmail `drafts.create` (replies stay in the original thread). You review and send from Gmail. JARVIS has no send code path; `test/gmail-drafts.test.mjs` fails if one is added. Runs on Gemini (`EMAIL_GEMINI_MODEL`, else `GEMINI_MODEL`, else `gemini-3.1-flash-lite`) when `GEMINI_API_KEY` is set and falls back to Groq if Gemini fails; without the Gemini key it uses Groq. A command-center email app (`JARVIS_EMAIL_URL`, `MCP_COMMAND_CENTER_TOKEN`) still works for reading if Gmail is not set.
- **Data sandbox and execution.** **Data sandbox** writes SQL views and queries over LCP aggregates (KPIs, reps, call outcomes, opportunities by city, ZIP, period, weekday and touches, SMS and dial channels, accounting, sources). QC reviews the plan. **Run in sandbox** runs it on a throwaway in-memory SQLite copy in a worker with a 3 second limit. Only `SELECT` and `CREATE VIEW` run. Module bindings and schedules are recorded, never applied. You can also paste `/execute {plan JSON}` in any chat. Every run is logged at `exec/log`. Seller names, phones, addresses and message text never enter the sandbox.
- **Slack bot.** One JARVIS bot user. DM it or @mention it. Prefixes: `systems:`, `market:`, `email:`, `dev:`, `data:`, `qc:`, `gemini:`, `workers:` or a bot name. `remember:`, `remember for all agents:`, :+1: / :-1: reactions, `run plan`, `new chat`, `help`. Weekday briefing on yesterday at 7:05 AM Pacific standard time (8:05 AM during daylight saving time).
- **Call Brain (voice).** **Call Brain** in the header opens a voice call that answers from the current report. Also launchable from Slack with `/call-lcp`. Daily session and turn caps.

### Setup

1. **Slack.** At api.slack.com/apps, create an app from `deploy/slack-manifest.yml` (replace the domain), install it, then set the Slack variables. For `/call-lcp`, add a slash command with request URL `https://<site>/api/slack/voice`.
2. **Gmail.** In Google Cloud (a project under your Workspace organization): enable the Gmail API. Under Google Auth Platform, set the audience to **Internal** and add the scopes `https://www.googleapis.com/auth/gmail.readonly` and `https://www.googleapis.com/auth/gmail.compose` (compose is needed for drafts; Google has no drafts-only scope, so JARVIS limits itself to `drafts.create` in code). Create an OAuth client of type **Desktop app**. On your computer, in this repo, run `GMAIL_CLIENT_ID=... GMAIL_CLIENT_SECRET=... node scripts/gmail-token.mjs`, open the printed link, sign in as the mailbox JARVIS should read and allow access. Copy the printed `GMAIL_REFRESH_TOKEN`. If you made a token before v6, run the script again so the token includes `gmail.compose`. Internal apps keep the token until you revoke it or change the password; if Gmail starts failing with `invalid_grant`, run the script again.
3. **Supabase (optional).** If you use it, run `supabase/migrations/20261118000000_lcp_jarvis_kv.sql` first.
4. Deploy once after setting the variables.

### Variables (Netlify, Functions scope)

| Variable | Feature | Value |
|---|---|---|
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | Email agent | Desktop OAuth client from Google Cloud |
| `GMAIL_REFRESH_TOKEN` | Email agent | Printed by `scripts/gmail-token.mjs`. Mark it secret |
| `EMAIL_GEMINI_MODEL` | Email agent, optional | Gemini model for the Email agent. Default `GEMINI_MODEL`, else `gemini-3.1-flash-lite` |
| `JARVIS_GMAIL_QUERY` | Email agent, optional | Gmail search for the snapshot. Default `in:inbox newer_than:7d` |
| `JARVIS_EMAIL_PAGES`, `JARVIS_EMAIL_SYNC` | Email agent, optional | Messages per snapshot in fives (1 to 4, default 2, so 10). `off` stops the 30 minute sync |
| `JARVIS_EMAIL_URL`, `MCP_COMMAND_CENTER_TOKEN` | Email agent, alternative | Only for a command-center email app instead of Gmail |
| `JARVIS_EXECUTE` | Sandbox, optional | `off` disables execution |
| `SLACK_BOT_TOKEN` | Slack bot | `xoxb-` bot token |
| `SLACK_SIGNING_SECRET` | Slack bot, `/call-lcp` | App signing secret |
| `SLACK_ALLOWED_USERS` | Slack bot | Your Slack member IDs, comma separated. Everyone else is ignored |
| `SLACK_BRIEFING_CHANNEL` | Slack bot, optional | Channel ID for the weekday briefing. Invite JARVIS to it |
| `LCP_STUDIO_KEY` | Slack bot | Already set. The bot calls JARVIS with it |
| `VOICE_ENABLED` | Call Brain | `1` turns it on |
| `VOICE_ORIGIN` | Call Brain | The site origin, for example `https://<site>` |
| `VOICE_APPROVED_REASONING` | Call Brain | `groq`, and optionally `gemini` or `openrouter`, comma separated, in priority order |
| `GEMINI_API_KEY` | Call Brain with `gemini` | Same key as the Gemini agent. Gemini answers when Groq is rate limited or down. Optional `VOICE_GEMINI_MODEL` (default `GEMINI_MODEL`, else `gemini-3.1-flash-lite`) |
| `OPENROUTER_API_KEY`, `VOICE_OPENROUTER_MODEL` | Call Brain, optional | Only with `openrouter` |
| `VOICE_GROQ_STT_APPROVED` | Call Brain, optional | `1` lets Groq Whisper transcribe speech. Optional `VOICE_GROQ_STT_MODEL` |
| `VOICE_BROWSER_STT_APPROVED` | Call Brain, optional | `1` allows the browser's own speech recognition |
| `VOICE_WHISPER_URL`, `VOICE_WHISPER_MODEL`, `VOICE_WHISPER_KEY` | Call Brain, optional | Your own Whisper-compatible endpoint |
| `VOICE_TTS_URL`, `VOICE_TTS_KEY` | Call Brain, optional | Server speech. Without it the browser speaks |
| `VOICE_DAILY_SESSIONS`, `VOICE_DAILY_TURNS`, `VOICE_SESSION_MINUTES`, `VOICE_SESSION_TURNS`, `VOICE_PROVIDER_TIMEOUT_MS`, `VOICE_MAX_OUTPUT_TOKENS` | Call Brain, optional | Caps: 50, 100, 10, 20, 4500, 256 |
| `VOICE_SLACK_APP_ID`, `VOICE_SLACK_USERS` | `/call-lcp`, optional | Slack app ID, and the Slack users allowed to launch calls as `<team ID>:<user ID>`, comma separated |

Netlify usage: `jarvis-mail-sync` runs every 30 minutes and exits at once without the email variables. `slack-briefing` runs once per weekday. Slack replies run in `slack-worker-background`, a background function. Groq runs only on a message, a reflection, a non-keyword Main request or a voice turn.

Not ported: the Docker VM, the A2Z city and its Mail district.
