# Unstuck relay (AGPL-3.0). Build from the repository root:
#   docker build -f relay-node/Dockerfile -t unstuck-relay .
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY protocol ./protocol
COPY core ./core
COPY relay-core ./relay-core
COPY relay-node ./relay-node
COPY viewer ./viewer
# The workspace file lists every package; only the relay's (and core, a test-only dependency pnpm still resolves) are present here.
RUN printf 'packages:\n  - protocol\n  - core\n  - relay-core\n  - relay-node\n  - viewer\n' > pnpm-workspace.yaml \
 && pnpm install --frozen-lockfile=false --filter @velmlabs/unstuck-relay... --filter @velmlabs/unstuck-viewer... \
 && pnpm --filter @velmlabs/unstuck-viewer exec vite build \
 && pnpm --filter @velmlabs/unstuck-relay bundle

# The relay is one bundled file plus the viewer's static files: no node_modules, nothing compiled at start.
FROM node:22-alpine
WORKDIR /app
COPY --from=build /src/relay-node/dist/relay.mjs ./relay.mjs
COPY --from=build /src/viewer/dist ./viewer-dist
COPY relay-node/LICENSE ./LICENSE
RUN addgroup -S relay && adduser -S relay -G relay
USER relay
ENV NODE_ENV=production UNSTUCK_VIEWER_DIR=/app/viewer-dist PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "relay.mjs"]
