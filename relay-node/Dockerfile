# Unstuck relay (AGPL-3.0). Build from the repository root:
#   docker build -f relay-node/Dockerfile -t unstuck-relay .
FROM node:22-alpine AS build
WORKDIR /src
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY protocol ./protocol
COPY relay-core ./relay-core
COPY relay-node ./relay-node
COPY viewer ./viewer
# The workspace file lists every package; only the relay's are present here.
RUN printf 'packages:\n  - protocol\n  - relay-core\n  - relay-node\n  - viewer\n' > pnpm-workspace.yaml \
 && pnpm install --frozen-lockfile=false --filter @unstuck/relay... --filter @unstuck/viewer... \
 && pnpm --filter @unstuck/viewer exec vite build \
 && pnpm --filter @unstuck/relay deploy --prod --legacy /out \
 && cp -r viewer/dist /out/viewer-dist

FROM node:22-alpine
WORKDIR /app
COPY --from=build /out /app
RUN npm install --no-save tsx@4 && addgroup -S relay && adduser -S relay -G relay
USER relay
ENV NODE_ENV=production UNSTUCK_VIEWER_DIR=/app/viewer-dist PORT=8787
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["npx", "tsx", "src/bin.ts"]
