declare namespace Cloudflare {
  interface Env {
    RELAY_SESSION: DurableObjectNamespace;
    ASSETS: Fetcher;
    AGENT_KEYS?: string;
    RELAY_OPEN?: string;
    VIEWER_LIMIT?: RateLimit;
    AGENT_LIMIT?: RateLimit;
    AGENT_IP_LIMIT?: RateLimit;
  }
  // The test Worker (wrangler.test.toml `main`): types `exports` from cloudflare:workers.
  interface GlobalProps {
    mainModule: typeof import('./fixtures/worker');
    durableNamespaces: 'RelaySessionDO';
  }
}
