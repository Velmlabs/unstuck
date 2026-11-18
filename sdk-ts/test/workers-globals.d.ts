// examples/cloudflare-worker/src/session-store.ts (tested here under Node) names the Workers global DurableObjectStorage.
// The importable form of the Workers types gives just that type, without the Workers globals that clash with Node's.
declare global {
  type DurableObjectStorage = import('@cloudflare/workers-types/index').DurableObjectStorage;
}
export {};
