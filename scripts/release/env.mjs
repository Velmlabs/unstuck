// Environments for release child processes. Builds and checks run third-party code (npm install scripts, Bun, uv,
// Playwright, the packages under test): they get no secrets at all. Publishing passes exactly one secret to the one
// command that needs it.

const SECRET = /(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|_AUTH)$|^ACTIONS_ID_TOKEN_REQUEST_|authtoken/i;

/** A copy of `env` without anything that looks like a credential, plus `extra`. */
export function scrubbedEnv(env = process.env, extra = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !SECRET.test(k)) out[k] = v;
  return { ...out, ...extra };
}

/** The scrubbed environment plus only the named variables from `env` (those that are set). */
export function withOnly(env, names) {
  const out = scrubbedEnv(env);
  for (const n of names) if (env[n] !== undefined) out[n] = env[n];
  return out;
}

const OIDC = ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL'];

/**
 * How to publish. In GitHub Actions with `id-token: write` and no stored tokens: trusted publishing (npm and PyPI
 * exchange GitHub's OIDC token; npm adds signed provenance). Otherwise long-lived tokens, each only to its own tool.
 */
export function publishCredentials(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true' && OIDC.every((k) => env[k]) && !env.NPM_TOKEN && !env.PYPI_TOKEN) {
    const ci = withOnly(env, OIDC);
    return { mode: 'trusted', npmEnv: ci, uvEnv: ci, npmArgs: ['--provenance'], uvArgs: ['--trusted-publishing', 'always'] };
  }
  if (!env.NPM_TOKEN || !env.PYPI_TOKEN) throw new Error('set NPM_TOKEN and PYPI_TOKEN, or run in GitHub Actions with id-token: write');
  return { mode: 'token', npmEnv: withOnly(env, ['NPM_TOKEN']), uvEnv: scrubbedEnv(env, { UV_PUBLISH_TOKEN: env.PYPI_TOKEN }), npmArgs: [], uvArgs: [] };
}
