declare namespace Cloudflare {
  interface Env {
    RELAY_SESSION: DurableObjectNamespace;
    ASSETS: Fetcher;
    AGENT_KEYS?: string;
    RELAY_OPEN?: string;
    VIEWER_LIMIT?: RateLimit;
    AGENT_LIMIT?: RateLimit;
  }
}
