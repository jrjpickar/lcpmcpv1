# JARVIS agent patch

Apply this ZIP at the repository root **after** the LocalCare Props MCP V3 starter ZIP. The JavaScript gateway, Python worker, and Studio panel are separate from the existing MCP route. The supplied LangGraph archive identifies version 1.2.22. The worker uses that published package and does not bundle the upstream repository.

| Agent | Capability |
| --- | --- |
| Systems and KPIs | Reads the dashboard's selected date and rep filters. Reports aggregate KPI changes, source coverage, Twilio billing and Groq check status, and priorities. The model receives no rep names, contact records, message bodies, or connector credentials. |
| Market news and improvement | Reads public Federal Reserve and Census housing feeds. Returns linked headlines and suggests measurable acquisition, financing, or outreach experiments. The feeds cover national data. City, county, and property research remains open. |
| Build developer | Creates up to four supported Studio Note and KPI modules from a request. |
| QC developer | Reviews each valid build in a separate model call. Administrators can also request a review of current draft modules. Schema checks reject unsupported fields and invalid KPI bindings. |

A successful build and QC review lets an administrator import the proposal into the editor. The normal Studio preview, save, and explicit publication steps still apply. The developer roles cover declarative modules. Source-code editing, code execution, automated deployment, and durable agent run history remain open.

## Local start

1. Install Node 22 or later, Python 3.10 or later, and Ollama. Run `npm ci`, `python3 -m venv .venv`, and `.venv/bin/python -m pip install -r jarvis/requirements.txt`.
2. Start Ollama in local-only mode with `OLLAMA_NO_CLOUD=1 ollama serve`. In another terminal run `ollama pull qwen2.5:1.5b`. This is the default model. Use `LCP_JARVIS_OLLAMA_MODEL` to select another installed local model. [Ollama model card](https://ollama.com/library/qwen2.5:1.5b)
3. Set `LCP_JARVIS_TOKEN` to a random secret of at least 32 characters. In the worker terminal, export it and run `.venv/bin/python -m jarvis.server`. The worker binds to `127.0.0.1:4180`.
4. In the dashboard terminal, export the same `LCP_JARVIS_TOKEN` and a distinct `LCP_STUDIO_KEY` of at least 24 characters. Run `npm run sandbox`. Open the printed address, unlock Studio, and select an agent in JARVIS. Use the sandbox to test with sample KPI data.
5. For the optional cloud provider, set `LCP_JARVIS_PROVIDER=groq` and `LCP_JARVIS_GROQ_KEY` from a Groq **Free** project in the worker terminal, then restart the worker. It uses `openai/gpt-oss-20b`, allows one task at a time, and surfaces quota errors. Keep the project on the Free plan. The gateway has no paid fallback. Groq receives the task and selected context only when you select this provider. [Groq Free plan limits](https://console.groq.com/docs/rate-limits)

## Netlify test setup

Run the Python worker on a machine or service you control. Keep it bound to loopback. Reverse proxy only `POST /run` over HTTPS and pass its Authorization header. Set `LCP_JARVIS_URL=https://<worker-host>/run`, `LCP_JARVIS_TOKEN`, and `LCP_STUDIO_KEY` on the Netlify Functions test deployment. Set the provider variables only on the worker. A hosted worker or its infrastructure can have costs. The default local setup requires no hosting or model subscription. Keep the existing MCP configuration and follow the starter instructions for the module registry.

## Verification

- Node suite, dashboard build, and Python graph tests run locally from the terminal. The Python tests also ran against the core source extracted from the supplied LangGraph archive.
- A local HTTP check exercised all four roles through the Node gateway, the Python worker, and controlled Ollama-format responses. Both Federal Reserve feeds and the Census feed returned live entries during that check.
- Live Ollama and Groq inference, Netlify deployment, and live private connectors remain unverified. Start one model provider to test response quality on actual tasks.

Feed references. [Federal Reserve RSS](https://www.federalreserve.gov/feeds/feeds.htm) · [U.S. Census Bureau RSS](https://www.census.gov/about/contact-us/feeds.html)
