// Type-checking test-workers (pnpm build): the edge entry and core are checked with the DOM lib, as everywhere else, so
// the workerd module that relay-cloudflare's test helpers use is declared here, only as far as they use it. relay-worker.ts
// (a one-line re-export of relay-cloudflare's test Worker, which needs @cloudflare/workers-types) is left out.
declare module 'cloudflare:workers' {
  export const exports: {
    default: { fetch(req: Request): Promise<Response & { webSocket: (WebSocket & { accept(): void }) | null }> };
  };
}
