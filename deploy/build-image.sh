#!/usr/bin/env bash
# Run on your computer (or in CI), never on the VM. Builds the linux/amd64 image, copies it and docker-compose.yml
# to the VM over IAP like A2Z's deploy/push.sh, loads it, restarts the container and waits for /health.
# Usage: deploy/build-image.sh [instance] [zone] [remote_dir]     defaults: a2z-mcp us-west1-b lcp-jarvis
#        deploy/build-image.sh --save-only   builds and writes lcp-mcp-image.tar.gz for upload with SSH-in-browser
# Connects as ubuntu@<instance> with --ssh-key-file ~/.ssh/a2z-gcp (override with LCP_SSH_KEY). Keeps the VM's .env.
set -Eeuo pipefail
# Never die silently: print the failing line and command.
trap 'rc=$?; echo "ERROR: ${BASH_SOURCE[0]##*/} line $LINENO: $BASH_COMMAND (exit $rc)" >&2' ERR
cd "$(dirname "$0")/.."
if [ "${1:-}" = "--save-only" ]; then
  docker buildx build --platform linux/amd64 -t lcp-mcp:latest --load .
  docker save lcp-mcp:latest | gzip > lcp-mcp-image.tar.gz
  echo "Wrote lcp-mcp-image.tar.gz ($(du -h lcp-mcp-image.tar.gz | cut -f1)). Upload it, docker-compose.yml and deploy/searxng/settings.yml (to ~/lcp-jarvis/searxng/) to ~/lcp-jarvis, then: gunzip -c lcp-mcp-image.tar.gz | sudo docker load"
  exit 0
fi
INSTANCE="${1:-a2z-mcp}"; ZONE="${2:-us-west1-b}"; DIR="${3:-lcp-jarvis}"
KEY="${LCP_SSH_KEY:-$HOME/.ssh/a2z-gcp}"
[ -f "$KEY" ] || { echo "SSH key not found: $KEY"; exit 1; }
SSH=(gcloud compute ssh "ubuntu@$INSTANCE" --zone "$ZONE" --tunnel-through-iap --ssh-key-file "$KEY")

docker buildx build --platform linux/amd64 -t lcp-mcp:latest --load .
"${SSH[@]}" --command "mkdir -p '$DIR'"
tar czf - docker-compose.yml -C deploy searxng | "${SSH[@]}" --command "tar xzf - -C '$DIR'"
echo "Copying the image (about 80 MB compressed)..."
docker save lcp-mcp:latest | gzip | "${SSH[@]}" --command "gunzip | sudo docker load"
"${SSH[@]}" --command "cd '$DIR' && test -f .env || { echo 'Missing ~/$DIR/.env. Copy it first (deploy/VM-SETUP.md step 2).'; exit 1; }
  sudo docker compose up -d --remove-orphans
  for i in \$(seq 1 30); do curl -fsS http://127.0.0.1:8081/health && echo && sudo docker image prune -f >/dev/null && exit 0; sleep 2; done
  echo 'Not healthy after 60s. Recent logs:'; sudo docker compose logs --tail 40 lcp-mcp; exit 1"
