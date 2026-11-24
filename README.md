# LCP MCP

Simple reporting site + MCP server for LocalCare Props. Reads the Triple Line dialer, GHL and the LocalCare Ledger. Groq writes the insights. Netlify serves the static site and runs the reporting functions. Slack alert cooldowns use Netlify Blobs.

## Metrics
| Section | What it shows |
|---|---|
| Calls by rep | Same layout as the data dashboard Calls tab: dials, live connects, talk time, avg call, avg conversation, follow ups; daily activity by outcome; dispositions; rep scorecard |
| Opportunities generated | ACQ/Retail opportunities by city/ZIP, by period, weekday, hour, and by touches before creation |
| SMS to qualified | Texts sent, contacts texted, replied, qualified (last SMS touch credit), texts per qualified, per rep |
| Dials to qualified | Dials, contacts dialed, connected, qualified (last dial credit), dials per qualified, per rep |
| Workflows tab | GHL workflow enrollments, finished, skipped, failed, weekly enrollments and top skip/fail reasons, read from the v2 data dashboard workflow feed |
| Accounting tab | Cash-basis P&L from the Ledger: fees received, deal costs, lead gen, operating, net, fees pending, EMD at risk, lead gen per qualified lead, bills owed, spend by category, deals in contract |

Definitions are on the page and in every MCP response. Dates use America/Los_Angeles. Qualified = a contact's first ACQ or Retail opportunity, dated by creation. Hot temperature is not used (GHL does not date it).

## Signals (Sales tab)
One quiet card: 8 tiles with a status dot, detail on click, and today's alerts above them.

| Tile | Definition |
|---|---|
| Speed to lead | Seller reply or inbound call (9am to 9pm Pacific) to the first rep text or dial. Median and % within 5 min. Automated texts don't count. |
| Hot replies waiting | Positive replies and inbound calls with no rep text or dial yet, last 48h, oldest first, with GHL links. |
| Opt-out rate | Opt-out replies / contacts texted, plus the positive, neutral, negative, opt-out mix (same classifier as the data dashboard). |
| Leads dropped early | Sellers who engaged (connected, replied or called in) but got only 1 to 3 touches, idle 7+ days, never qualified, not DNC/wrong number/not interested. Last 60 days, by rep and list. |
| Follow-ups on time | Hot due within 24h, warm within 72h (`ALERT_HOT_SLA_HOURS`, `ALERT_WARM_SLA_HOURS`). Worked = a rep dial or text in time. Also hot follow-ups that became opportunities. |
| Stuck deals | Open ACQ/Retail opportunities with no stage change in `STUCK_DAYS` (14). Verbal to contract uses current stages of the last 90 days (GHL keeps no stage history). |
| Caller IDs | Connect rate per outbound number on the last day vs the 7 days before. Needs the dialer patch (adds `callerId` to the disposition log). |
| List decay | Wrong number + DNC share and connect rate by dialer queue, by week for 8 weeks. Decaying = last 2 weeks at least 5 points and 1.4x above the 6 before. Queue labels come from `MANUAL_ACTION_QUEUES` (same JSON as the dialer) when set. |

The rep scorecard also has **Qual / 100 conv**: qualified leads (last dial credit) per 100 calls of 60s or more.

## Alerts (server side, no Groq)
`netlify/functions/alerts-scheduled.mjs` runs every 5 minutes. The cron covers 9am to 9pm Pacific in both PDT and PST; outside those hours it exits before any request. Nothing runs in the browser and Groq is never called for alerts.

- Each run reads only today and yesterday: one dialer export request, the GHL SMS export and the GHL inbound call export.
- The 7-day caller ID rates, 7-day opt-out rate and 8-week list decay are built once a day and cached in Netlify Blobs.
- Alerts: hot replies waiting `ALERT_REPLY_WAIT_MIN`+ minutes (sent once per reply), a caller ID connect rate drop of `ALERT_CALLER_ID_DROP` (40%) or more on 20+ dials, opt-out rate `ALERT_OPT_OUT_SPIKE`x (2x) the 7-day rate, `ALERT_OVERDUE_MIN`+ hot follow-ups overdue, a decaying list (once a week).
- Each alert is posted to Slack once, then not again for `ALERT_COOLDOWN_MIN` (120). No new alerts = no Slack post.
- `GET /api/alerts` shows what would be sent right now. `POST /api/alerts` posts a test message (both need the dashboard key).
- Groq is only called when someone presses Ask on the page. Repeat questions on the same data within 10 minutes reuse the last answer. The context sent is about 900 tokens and answers are capped at `GROQ_MAX_TOKENS` (350).

## Brain 3D (A2Z city structure)
The home view. The A2Z operations city engine, ported: ten districts on a ring around the Brain (HQ), and the JARVIS agents as robots on an inner ring, in the same placement and with the same animations as A2Z.

| District | Shows | Visual |
|---|---|---|
| Dials | Dials, answered, contacts (over 65s), talk time | Desk with dial sheet stacks |
| Texts | Rep and automated texts, replies by sentiment | Envelope stack |
| Sellers worked | Worked, contacted, qualified | Parking lot |
| Qualified sellers | Qualified sellers, opportunities by pipeline | One house per seller (scaled) |
| Offers and contracts | Offers, contracts, appointments | Crane, one pennant each |
| Opportunities | Opportunities created per pipeline | One building per pipeline |
| Team | Reps; on the phones today vs not dialing | Crew figures, click one for that rep |
| Marketing | Top ZIPs by qualified per 100 worked, number of recommended moves | Billboard, searchlight, megaphone |
| Cash | Ledger fees, net, pending, EMD | Tank fill = fees vs spend |
| System health | Every connection plus the data dashboard sync | PC: fans = sync, RAM sticks = connections |

Agents (JARVIS, Systems, Market, Data, Email, Research, Build, QC, Gemini, Workers AI): idle, busy, done and error animations; a robot walks to a district with an alert it watches and raises a flag; a speech bubble shows its last answer; packets fly along the delegation trace. Click a robot to open its chat under the map (Studio key). Click a district for the detail panel. Alerts (Sales signals) put a siren on the district they belong to. Cars drive Dials to Qualified when qualified sellers go up, and Qualified to Offers when offers or contracts go up.

District numbers come from the data dashboard sync (below). Until the first sync finishes they fall back to the Sales report.

Source: `src/brain3d.mjs`. Rebuild the bundle after editing it: `npm i && node scripts/build-brain.mjs` (writes `public/brain3d.js`, Three.js included, no CDN).

## Run the sandbox (sample data)
```sh
npm run sandbox        # http://127.0.0.1:4173   MCP: POST http://127.0.0.1:4173/mcp
npm test
npm run build
node scripts/build-sandbox.mjs dist/index.html     # static preview (index.html + brain3d.js)
```

## Deploy

Apply the ZIP at the LCP MCP repository root and deploy LCP MCP. The Data Dashboard export is unnecessary for direct activity. The supplied Triple Line and Ledger archives already have their other export routes.

Set runtime variables for the appropriate site and deploy context. Include **Functions** in their scope. Set them before deploying the code so each affected site needs a single production deploy. [Netlify runtime configuration](https://docs.netlify.com/build/server/configuration/)

| Netlify site | Variables used for MCP access |
|---|---|
| **LCP MCP** | Set the variables in the table below. Set Twilio credentials here for Brain activity and the Data Dashboard pair if using the Workflows tab. |
| **Triple Line** | `DASHBOARD_EXPORT_KEY`, at least 24 characters. Copy its existing value to `DIALER_EXPORT_KEY` on MCP and retain the Data Dashboard's existing matching `DIALER_EXPORT_KEY` for signed-in call attribution. |
| **Data Dashboard** | `DASHBOARD_EMBED_KEY`, at least 32 characters. Copy it to `DATA_DASHBOARD_KEY` on MCP. Retain existing `GHL_ACCESS_TOKEN`, `GHL_LOCATION_ID`, `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` and `SYNC_SECRET` for imports. Keep `AGENT_ASSIGNMENTS` aligned with the dialer for rep attribution and `DASHBOARD_TIMEZONE=America/Los_Angeles`. `WORKFLOW_FEED_KEY` and the existing GHL collector are needed to populate workflow statistics. That feed uses `workflows.readonly` for names. |
| **LocalCare Ledger** | `MCP_EXPORT_KEY`, at least 24 characters. Copy it to `LEDGER_EXPORT_KEY` on MCP. |

### LCP MCP variables

Publish `public` and use `netlify/functions` for functions. The repository's Netlify configuration sets both.

| Variable | Needed | Value |
|---|---|---|
| `GHL_ACCESS_TOKEN` | Yes | LocalCare sub-account Private Integration token with `opportunities.readonly`, `contacts.readonly`, `conversations/message.readonly` and `users.readonly`. [HighLevel scopes](https://marketplace.gohighlevel.com/docs/Authorization/Scopes/) |
| `GHL_LOCATION_ID` | Yes | LocalCare sub-account id |
| `DASHBOARD_KEY` | Yes | 16+ random characters. Open the page as `https://<site>/#key=<DASHBOARD_KEY>` (use that URL for the GHL Custom Menu Link) |
| `TWILIO_ACCOUNT_SID` | For activity | Account or subaccount SID that holds the call and SMS logs |
| `TWILIO_API_KEY`, `TWILIO_API_SECRET` | One auth option | API key SID and secret with permission to list Calls and Messages for that account |
| `TWILIO_AUTH_TOKEN` | Alternate auth | Auth token for that account. Use this when the API key pair is unset. |
| `TWILIO_BILLING_ACCOUNT_SID`, `TWILIO_BILLING_AUTH_TOKEN` | Optional billing override | Use the main Twilio account credentials if the activity account is a subaccount or its key cannot read Balance. Set both. [Twilio subaccount billing](https://www.twilio.com/docs/iam/api/subaccounts) |
| `AGENT_ASSIGNMENTS` | For activity rep filters | Copy the dialer's JSON. Each dedicated number needs `name` and `twilioPhoneNumber` in E.164. |
| `DIALER_URL` | Yes | Dialer site URL, for example https://triplelinelcpv1.netlify.app |
| `DIALER_EXPORT_KEY` | Yes | Same value as `DASHBOARD_EXPORT_KEY` on the dialer (already used by v2datadashboard) |
| `GROQ_API_KEY` | Recommended | Groq API key. Without it the page shows rule-based insights |
| `GROQ_MODEL` | Optional | Default `openai/gpt-oss-20b`. Check Groq's model list and change if that model is retired |
| `MCP_KEY` | Recommended | Bearer token for `/mcp`. Falls back to `DASHBOARD_KEY` |
| `LEDGER_URL` | Optional | LocalCare Ledger site URL |
| `LEDGER_EXPORT_KEY` | Optional | Same value as `MCP_EXPORT_KEY` on the Ledger (24+ characters). The supplied Ledger already includes `netlify/functions/mcp-export.mts` |
| `DATA_DASHBOARD_URL` | Optional | Data Dashboard origin for the Workflows tab. |
| `DATA_DASHBOARD_KEY` | Optional | The Data Dashboard's `DASHBOARD_EMBED_KEY` for the Workflows tab. |
| `ZIP_CITY_MAP` | Optional | Brain Leads: JSON of ZIP to city name, for example `{"90221":"Compton"}`. Wins over the public ZIP lookup (api.zippopotam.us). |
| `LEADS_BUDGET_MS`, `LEADS_MAX_CONTACT_LOOKUPS` | Optional | Brain Leads read budget (8000 ms) and how many contacts without a ZIP tag are read for their tags or postal code (150). |
| `ALERT_WEBHOOK_URL` | For alerts | Slack Incoming Webhook URL. Without it the alert check stays dormant |
| `DASHBOARD_URL` | Optional | Link added to each Slack alert |
| `ALERT_REPLY_WAIT_MIN`, `ALERT_CALLER_ID_DROP`, `ALERT_OPT_OUT_SPIKE`, `ALERT_OVERDUE_MIN`, `ALERT_COOLDOWN_MIN` | Optional | Alert thresholds (15, 0.4, 2, 3, 120) |
| `ALERT_HOT_SLA_HOURS`, `ALERT_WARM_SLA_HOURS`, `STUCK_DAYS` | Optional | Follow-up and stage aging rules (24, 72, 14) |
| `ALERT_START_HOUR`, `ALERT_END_HOUR` | Optional | Pacific hours for alert checks (9, 21) |
| `ALERT_ALLOW_SAMPLE` | Optional | `1` lets the check post sample-data alerts, to test Slack before going live |
| `MANUAL_ACTION_QUEUES` | Optional | Copy of the dialer's queue JSON, for list names |
| `GROQ_MAX_TOKENS` | Optional | Ask answer cap, default 350 |
| `TOUCH_LOOKBACK_DAYS` | Optional | Default 60 |
| `CACHE_SECONDS` | Optional | Default 300 |
| `DATA_MODE` | Optional | `sample` forces sample data |

## Data dashboard data (direct from the sources)
`lib/dash-sync.mjs` reads the same sources as the v2 data dashboard, straight from the source APIs, and keeps LCP's own copy. The data dashboard keeps running unchanged; LCP only reads two settings it owns (tag visibility and batch settings) through its existing read-only `dashboard-data?settings=` GET with `DATA_DASHBOARD_KEY`. The workflow feed is still read from the dashboard, as before.

- GHL: contacts (tags, first-seen tags, address, source, qualification fields), opportunities and pipelines, SMS, tasks, calendars and appointments, users. Read only.
- Twilio: outbound calls, matched to GHL contacts by phone, reps by caller ID using the dashboard's roster (Jesse One to Seven roll up to Jesse, Kyle, Zaida and Frank excluded, flex numbers need the signed-in owner).
- Dialer: `POST /api/dashboard/call-ownership` for the signed-in rep per call SID (same as the dashboard).
- Rules: `netlify/functions/lib/dash/` holds unedited copies of the dashboard's modules (normalize, roster, aliases, Twilio, tasks, lead fields, LeadIntel, Opportunity Density, task metrics, tag visibility). When the dashboard changes one of these, copy the new file over.
- Schedule: every 30 minutes 7am to 9pm Pacific, hourly overnight, at minutes 7 and 37 (off the :00 slot). Full contact pass once a night (1am to 5am); other runs read only new contacts and the last 2 days of SMS and calls. Tasks every 2 hours. A long full pass continues in the next invocation by itself.
- LCP's first-seen tags start on its first sync. Until then the original source list is the current batch tag.

| Variable | Purpose |
|---|---|
| `DASH_SYNC_SECRET` | Required on Netlify. Random, 16+ characters. Shared by the scheduled and background sync functions |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Already set for Brain activity. Same account the dashboard reads |
| `AGENT_ASSIGNMENTS` | Optional. Same JSON as the dialer. Without it the dashboard's built-in phone roster is used |
| `DIALER_URL`, `DIALER_EXPORT_KEY` | Already set. Also used for signed-in call ownership |
| `DATA_DASHBOARD_URL`, `DATA_DASHBOARD_KEY` | Already set. Also used to read tag visibility and batch settings |
| `QUALIFICATION_FIELDS` | Optional. Same JSON as the dashboard |
| `DASH_SYNC_DAYS` | Optional. Days of calls, SMS and appointments kept. Default 120 |
| `MARKET_NEWS_TOPICS` | Optional. JSON list of topics (or `topic|topic`). `MARKET_NEWS=off` disables headlines |

VM (`RUN_SCHEDULES_ON=vm`): the server runs the same sync (job `dash-sync`), stores it under `DATA_DIR/dash`, and after each finished run posts the small snapshot to the site's `/api/dash-publish` so Brain, Marketing and Netlify MCP show it. Add to the VM `.env`: `LCP_SITE_URL=https://<your LCP site>` and the same `DASH_SYNC_SECRET` as Netlify, plus the source variables above if the VM does not have them yet (`TWILIO_*`, `DIALER_*`, `DATA_DASHBOARD_*`). The manual curl start still works in this mode: it runs one sync on Netlify and saves it straight to the site, until the VM takes over at its next :07 or :37 slot.

## Marketing tab
Where to iterate marketing to get more opportunities, for the last 30 or 90 days:

- Recommendations: ranked, each with evidence, sample size and confidence. Lists use the dashboard's Opportunity Density rules and thresholds (Increase, Retire, Investigate). ZIPs, cities, GHL tags and contact sources: Target more at 1.5x the median qualified per 100 worked or better; Spend less at 0.5x or worse with at least twice the sample floor. Call and text timing: the best hours by contact rate and 24-hour reply rate.
- Tables: lists, ZIPs, cities, tags, contact sources; contact rate by hour.
- Niche market news: LA County foreclosures, tax delinquency, code enforcement, probate, wholesaling law, rent control, prices and inventory, mortgage rates. Each topic names the marketing lever it informs. SearXNG news when `SEARXNG_URL` is set, else Google News RSS. Titles and links only.

## MCP
Endpoint `POST https://<site>/mcp` (Streamable HTTP, JSON responses, stateless). Header `Authorization: Bearer <MCP_KEY>`.

Tools come from one registry, `lib/actions.mjs` (ported from A2Z): each tool has a scope, a risk level (read, draft, write), whether it is listed on MCP and when it is enabled. Writes are never on MCP.

Date-range tools take `from` and `to` or a `preset`, plus optional `rep`:

- `activity_volume` returns outbound calls, calls over 60 seconds, outbound SMS sent, SMS deliveries, daily totals and coverage directly from Twilio.
- `calls_by_user`
- `opportunities_generated` (`group_by`: city, zip, period, weekday, hour, touches, rep, all)
- `sms_to_qualified`
- `dials_to_qualified`
- `accounting_summary`
- `workflow_stats` (`days`, 7 to 120)
- `ask_insights` (`question`, answered by Groq from the computed metrics only)

Data dashboard and marketing tools (`window`: today, wtd, mtd, 7d, 30d, 90d):

- `dashboard_kpis`: dials, answered, talk time, contacts, unique sellers dialed, texts, replies, opportunities by pipeline, seller funnel, tasks, appointments, per rep.
- `dashboard_tasks`: set, completed, overdue, longest overdue, per rep.
- `marketing_yield` (`dimension`: list, source_list, zip, city, tag, contact_source, hour, weekday, opportunity_timing).
- `marketing_recommendations`: ranked moves plus market headlines.
- `market_news` (`topics` optional).

Draft and write tools:

- `lcp_gmail_create_draft` (scope `mail:draft`): saves a Gmail draft, never sends. Listed only with `MCP_DRAFT_TOOLS=1` and Gmail configured (`gmail.compose`). Takes a UUID `draftId`; a retry with the same ID returns the first result.
- `lcp_create_opportunity` (scope `ghl:write`): not on MCP. JARVIS can request it (operator approval in the dashboard), or the dashboard calls `POST /api/jarvis/confirm` with the Studio key: preview with `dryRun: true` returns a hash, confirm with that hash and a UUID `idempotencyKey`. Refuses a contact that already has an open opportunity in the pipeline. ACQ and Retail pipelines only unless `GHL_WRITE_PIPELINES` lists others. Needs `GHL_WRITE_TOKEN` (opportunities.write); `GHL_ACCESS_TOKEN` stays read-only. A new opportunity is real GHL data, so the data dashboard counts it like one a rep created.

Scoped tokens (`MCP_TOKENS`) take scopes `report:read`, `mail:draft`, `knowledge:read`, `memory:read`, `web:read`.

## Netlify usage

- The data dashboard sync is the one scheduled import: about 40 short runs a day plus one nightly full pass, as background functions. Reads from the site (Brain, Marketing, MCP) only read the saved snapshot.
- Brain activity and billing checks run on demand with no polling. The billing and Groq model checks share a two-minute cache and do not submit a Groq completion. It returns counts without call or message contents. Warm functions reuse and coalesce Twilio reads across rep filters for the same range. Current ranges cache for up to two minutes, historical ranges for up to 30 minutes. Brain loads long ranges in chunks with two requests in flight. MCP splits upstream reads into 14-day windows, retries Twilio rate limits and transient server errors, and reports missing windows. A channel with missing windows displays as unavailable until its selected range is complete. Use Retry activity to reload unsuccessful date ranges.
- Sales keeps the existing live-report path and attribution window. It reuses common GHL and Ledger lookups. A first long-range Sales report can still be slow.
- For the lowest spend, leave `ALERT_WEBHOOK_URL` unset until Slack alerts are needed. The existing five-minute scheduled function then exits before provider reads. Groq runs on Ask. Use a Deploy Preview for checks and combine changes into one production deploy per changed site. [Netlify credit meters](https://docs.netlify.com/manage/accounts-and-billing/billing/billing-for-credit-based-plans/how-credits-work/)

## What belongs on the Brain

- Add a short action queue with positive replies waiting, overdue hot follow-ups, and stalled deals. Add conversations per 100 dials and qualified sellers per 100 conversations to connect volume to outcomes.
- Keep outbound calls, SMS attempts and delivered count, qualified sellers and fees received above the fold. Keep full dispositions and workflow skip/fail detail in their existing tabs.
- Drop the static MCP tool count, the Twilio water tower until it has a real balance feed, and the factory's detailed totals from the main view. Keep a small freshness label for data source problems.

## Limits

- Sales dials and disposition metrics use the Triple Line log. The separate Brain activity cards and `activity_volume` use Twilio directly. HighLevel traffic outside the configured Twilio account is outside those totals.
- SMS counts use Twilio send time. Unsent messages, MMS and other channels are excluded. Call duration over 60 seconds is a proxy, and each outbound phone Call SID with a start time counts once.
- If only Twilio and the dashboard key are configured, the activity cards can show live data and the Sales report uses sample data. Set the GHL credentials for the live Sales report. Remove `DATA_MODE=sample` when going live.
- For a production smoke test, compare the same Pacific day in Twilio Call and Messaging Logs and call `activity_volume`. [Twilio Call resource](https://www.twilio.com/docs/voice/api/call-resource) · [Twilio Message resource](https://www.twilio.com/docs/messaging/api/message-resource)
