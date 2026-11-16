# LCP MCP

Simple reporting site + MCP server for LocalCare Props. Reads the Triple Line dialer, GHL and the LocalCare Ledger. Groq writes the insights. No dependencies, no build step, no Blobs.

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

## Brain 3D (sandbox only)
A clickable 3D city built with Three.js. The LCP Brain (Groq core) sits in the middle; data packets flow into it from each structure:

| Structure | Shows | Driven by |
|---|---|---|
| Dialer tower | Dials, live connect rate, talk time | Height = dials, lit windows = connect rate |
| Post office + mast | Texts sent, replies, texts per qualified | Mast height and signal speed = texts |
| Neighborhood | Opportunities by city | One house per city, height = opps |
| Factory | Workflows, enrolled, finished, failed | Gear, conveyor and smoke speed = enrollments; red beacon = failed steps |
| Bank | Fees received, net, pending, EMD | Coin stacks: received, pending (glass), net |
| Control room | Data source health | One light per source |
| Water tower | Twilio balance, spend per day, days left | Fill level; amber under 2x the alert, red under it |

Drag to rotate, scroll to zoom, click a building or its label for details and a link to the matching tab. The tab only appears in sample mode. Twilio balance and source health are sample values; nothing live is wired yet.

Source: `src/brain3d.mjs`. Rebuild the bundle after editing it: `npm i && node scripts/build-brain.mjs` (writes `public/brain3d.js`, Three.js included, no CDN).

## Run the sandbox (sample data)
```sh
npm run sandbox        # http://127.0.0.1:4173   MCP: POST http://127.0.0.1:4173/mcp
npm test
npm run build
node scripts/build-sandbox.mjs dist/index.html     # static preview (index.html + brain3d.js)
```

## Deploy (new Netlify site)
Publish `public`, functions `netlify/functions` (set in netlify.toml). Then set env vars and redeploy.

| Variable | Needed | Value |
|---|---|---|
| `GHL_ACCESS_TOKEN` | Yes | LocalCare Private Integration token. Scopes: opportunities.readonly, contacts.readonly, conversations/message.readonly, users.readonly |
| `GHL_LOCATION_ID` | Yes | LocalCare sub-account id |
| `DASHBOARD_KEY` | Yes | 16+ random characters. Open the page as `https://<site>/#key=<DASHBOARD_KEY>` (use that URL for the GHL Custom Menu Link) |
| `DIALER_URL` | Yes | Dialer site URL, for example https://triplelinelcpv1.netlify.app |
| `DIALER_EXPORT_KEY` | Yes | Same value as `DASHBOARD_EXPORT_KEY` on the dialer (already used by v2datadashboard) |
| `GROQ_API_KEY` | Recommended | Groq API key. Without it the page shows rule-based insights |
| `GROQ_MODEL` | Optional | Default `llama-3.3-70b-versatile`. Check Groq's model list and change if that model is retired |
| `MCP_KEY` | Recommended | Bearer token for `/mcp`. Falls back to `DASHBOARD_KEY` |
| `LEDGER_URL` | Optional | LocalCare Ledger site URL |
| `LEDGER_EXPORT_KEY` | Optional | Same value as `MCP_EXPORT_KEY` on the Ledger (24+ characters). Needs `netlify/functions/mcp-export.mts` added to the Ledger repo |
| `DATA_DASHBOARD_URL` | Optional | v2 data dashboard URL, for example https://v2datadashboard.netlify.app (Workflows tab) |
| `DATA_DASHBOARD_KEY` | Optional | The data dashboard's `DASHBOARD_EMBED_KEY` |
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

## MCP
Endpoint `POST https://<site>/mcp` (Streamable HTTP, JSON responses, stateless). Header `Authorization: Bearer <MCP_KEY>`.

Tools (all read-only, all take `from`/`to` or `preset`, plus optional `rep`):
- `calls_by_user`
- `opportunities_generated` (`group_by`: city, zip, period, weekday, hour, touches, rep, all)
- `sms_to_qualified`
- `dials_to_qualified`
- `accounting_summary`
- `workflow_stats` (`days`, 7 to 120)
- `ask_insights` (`question`, answered by Groq from the computed metrics only)

Signals are included in the existing tool outputs and in the Ask context.

## Limits
- Dials come from the dialer disposition log. Calls with no saved disposition are not counted. Twilio legs are not read.
- Reps are matched by name: dialer agent name and GHL user name must match.
- City/ZIP is read only for contacts behind opportunities in range (max `GHL_MAX_CONTACTS`, default 400).
- Data loads on request and is cached per function instance. Long ranges (YTD) can be slow on the first load. Netlify synchronous functions time out at 10 s by default (26 s max).
- Not tested against live credentials.
