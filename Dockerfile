# LCP MCP server for the Google Cloud e2-micro VM. Ported from the A2Z Dockerfile.
# Build on your computer or in CI, never on the VM: deploy/build-image.sh builds linux/amd64 and copies the image over.
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --omit=optional skips the Goose CLI binaries (about 200 MB). The VM does not run Goose.
RUN npm ci --omit=dev --omit=optional --no-audit --no-fund

FROM node:22-bookworm-slim
# Heap cap below the container limit so Node collects garbage before the kernel OOM killer acts.
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data NODE_OPTIONS=--max-old-space-size=288
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY netlify ./netlify
COPY public ./public
COPY server ./server
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8080/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.mjs"]
