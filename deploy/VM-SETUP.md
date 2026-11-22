# LCP MCP on the VM

Runs next to A2Z on the existing `a2z-mcp` e2-micro (already set up by A2Z's `bootstrap-vm.sh`: Docker, 2 GB swap, IPv6 DNS). The VM runs `/mcp` and the alerts, mail sync and Slack briefing jobs. Netlify keeps everything else. SSH used below: `S="gcloud compute ssh ubuntu@a2z-mcp --zone us-west1-b --tunnel-through-iap --ssh-key-file ~/.ssh/a2z-gcp"`.

1. **Fill `.env` on your computer.** Copy `.env.example` to `.env`. Fill the VM server, "both" and Slack sections (the same values as Netlify). Set `MCP_AUTH_TOKEN` (`openssl rand -hex 32`), `RUN_SCHEDULES_ON=vm`, `SCHEDULER_DRY_RUN=1`. Run `chmod 600 .env`.
2. **Copy it to the VM.** `$S --command 'mkdir -p lcp-jarvis'` then
   `gcloud compute scp .env ubuntu@a2z-mcp:~/lcp-jarvis/.env --zone us-west1-b --tunnel-through-iap --ssh-key-file ~/.ssh/a2z-gcp`
   then `$S --command 'chmod 600 lcp-jarvis/.env'`.
3. **Build and ship.** On your computer: `deploy/build-image.sh` (builds linux/amd64, loads it on the VM over IAP, runs `docker compose up -d`, waits for `/health`). Without local gcloud: `deploy/build-image.sh --save-only`, upload `lcp-mcp-image.tar.gz` and `docker-compose.yml` to `~/lcp-jarvis` with SSH-in-browser Upload File, then `gunzip -c lcp-mcp-image.tar.gz | sudo docker load && sudo docker compose up -d`.
4. **Check the dry run.** `$S --command 'cd lcp-jarvis && sudo docker compose logs --tail 20'` must end with `[dry-run] done. Each job fired once.` Nothing reaches Slack or Groq.
5. **Hand the jobs to the VM.** In Netlify set `RUN_SCHEDULES_ON=vm` and redeploy first (a short gap is safer than a double post). Then on the VM: `cd lcp-jarvis && sed -i 's/^SCHEDULER_DRY_RUN=.*/SCHEDULER_DRY_RUN=/' .env && sudo docker compose up -d --force-recreate`.
6. **Verify.**
   - `$S --command 'curl -s 127.0.0.1:8081/health'` shows `"schedules":"vm"`. `lastRun` fills in as jobs fire (alerts every 5 minutes from 9am to 9pm Pacific).
   - `sudo docker compose ps` shows `healthy`. Netlify function logs show `skipped on Netlify: RUN_SCHEDULES_ON=vm`.
7. **Use `/mcp` through an SSH tunnel** (the port only listens on the VM's 127.0.0.1):
   `$S -- -N -L 8081:127.0.0.1:8081`
   Then connect your MCP client to `http://127.0.0.1:8081/mcp` with `Authorization: Bearer <MCP_AUTH_TOKEN>`.

**Redeploy:** rerun `deploy/build-image.sh`. **Edit .env:** change the file on the VM, then `sudo docker compose up -d --force-recreate`.
**Roll back to Netlify:** set `RUN_SCHEDULES_ON=netlify` on Netlify and redeploy, then `sudo docker compose stop` on the VM.

Notes: the VM only reads mail; Gmail drafts are saved from Netlify, so the VM does not need `EMAIL_GEMINI_MODEL`. The container is limited to 384 MB (768 MB with swap) next to A2Z's 512 MB, logs rotate at 10 MB x 3, and it restarts unless stopped. With Supabase set on both sides, each job also takes a one-time lease per run, so a mismatched `RUN_SCHEDULES_ON` still cannot post twice. Slack bot replies stay on Netlify (`slack-worker-background`), because the VM is not reachable from the internet. A2Z does the same.

**Intel (optional):** set `DEV_RUNNER=1` and `DEV_REPOS` for the sandboxed dev runner, `INTEL_WORKER_ON=vm` to run deep research here, `INTEL_REPOS` for the daily re-index, `SLACK_APP_TOKEN` for Slack Socket Mode. SearXNG: set `SEARXNG_URL=http://searxng:8080` and `SEARXNG_SECRET` (`openssl rand -hex 32`), and put `deploy/searxng/settings.yml` at `~/lcp-jarvis/searxng/settings.yml`. `build-image.sh` copies it. Set Supabase on both sides so the VM sees tasks queued on Netlify. Without Supabase the VM uses SQLite at `/data/jarvis.sqlite`. See `INTEL.md`.
