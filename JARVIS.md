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
- **Build developer** generates declarative Note, KPI, and live Brain health cards for the Studio.
- **QC developer** checks valid builds in a separate model call or reviews current draft modules. Approved builds can be imported into the editor and follow the existing preview, save, and publish workflow.

Repository code editing, executing generated code, and persistent agent run history remain outside this patch.

## Local verification

Run `npm ci`, `npm test`, and `npm run build`. To use the local dashboard, export the two variables above and run `npm run sandbox`. It uses sample report data. Local tests exercise all four agent paths with fixture Groq responses. Live Groq inference and Netlify deployment require verification with your site and key.

## Brain 3D health

Ask “Show system health on Brain” to see the latest statuses available to Brain 3D. Ask “Add a live system health card on Brain” to create a draft that uses the same status data. The agents keep the preceding task for the selected role while Studio is open. A supported health card can be previewed, saved, and published through the registry.

Brain and legacy Ask default to `openai/gpt-oss-20b`. If Netlify explicitly sets `GROQ_MODEL` to a retired model, update it or clear the override. [Groq model deprecations](https://console.groq.com/docs/deprecations)
