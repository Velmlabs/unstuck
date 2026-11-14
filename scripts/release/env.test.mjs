// Release builds run third-party code (npm install scripts, Bun, uv, Playwright): none of it may see publishing tokens.
import { describe, it, expect } from 'vitest';
import { publishCredentials, scrubbedEnv, withOnly } from './env.mjs';

const base = {
  PATH: '/usr/bin',
  HOME: '/home/x',
  NPM_TOKEN: 'npm_x',
  PYPI_TOKEN: 'pypi-x',
  UV_PUBLISH_TOKEN: 'pypi-y',
  NODE_AUTH_TOKEN: 'n',
  GITHUB_TOKEN: 'g',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc',
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc',
  CLOUDFLARE_API_TOKEN: 'cf',
  POLAR_WEBHOOK_SECRET: 's',
  UNSTUCK_API_KEY: 'k',
  AWS_SECRET_ACCESS_KEY: 'a',
  npm_config__authToken: 'c',
  NPM_CONFIG__AUTH: 'd',
  TWINE_PASSWORD: 'p',
  PLAYWRIGHT_BROWSERS_PATH: '/opt/pw',
};

describe('scrubbedEnv', () => {
  it('drops every token, secret, password, API key and OIDC request variable; keeps the rest', () => {
    expect(scrubbedEnv(base)).toEqual({ PATH: '/usr/bin', HOME: '/home/x', PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' });
  });
  it('also drops credentials named in other common ways', () => {
    const more = { PATH: '/b', GOOGLE_APPLICATION_CREDENTIALS: 'x', AWS_CREDENTIALS: 'x', GH_PAT: 'x', GPG_PASSPHRASE: 'x', DB_PASSWD: 'x', SSH_PRIVATE_KEY: 'x', COSIGN_SIGNING_KEY: 'x', DATABASE_URL: 'x', SSH_AUTH_SOCK: 'x' };
    expect(scrubbedEnv(more)).toEqual({ PATH: '/b' });
  });
  it('adds extra variables after scrubbing', () => {
    expect(scrubbedEnv(base, { PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' })).toMatchObject({ PATH: '/usr/bin', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });
  });
  it('defaults to process.env and never mutates its input', () => {
    const copy = { ...base };
    scrubbedEnv(copy);
    expect(copy).toEqual(base);
    expect(scrubbedEnv()).not.toHaveProperty('NPM_TOKEN');
  });
});

describe('withOnly', () => {
  it('passes one named secret through to the one command that needs it', () => {
    const env = withOnly(base, ['NPM_TOKEN']);
    expect(env.NPM_TOKEN).toBe('npm_x');
    expect(env).not.toHaveProperty('PYPI_TOKEN');
    expect(env.PATH).toBe('/usr/bin');
  });
  it('keeps the GitHub OIDC variables when asked (trusted publishing), and skips names that are unset', () => {
    const env = withOnly({ PATH: '/b', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'o', ACTIONS_ID_TOKEN_REQUEST_URL: 'u' }, ['ACTIONS_ID_TOKEN_REQUEST_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_URL', 'NPM_TOKEN']);
    expect(env).toEqual({ PATH: '/b', ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'o', ACTIONS_ID_TOKEN_REQUEST_URL: 'u' });
  });
});

describe('publishCredentials', () => {
  const oidc = { ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'o', ACTIONS_ID_TOKEN_REQUEST_URL: 'u' };
  it('in GitHub Actions with id-token permission and no stored tokens: trusted publishing, with provenance', () => {
    const c = publishCredentials({ PATH: '/b', GITHUB_ACTIONS: 'true', ...oidc });
    expect(c.mode).toBe('trusted');
    expect(c.npmArgs).toEqual(['--provenance']);
    expect(c.uvArgs).toEqual(['--trusted-publishing', 'always']);
    expect(c.npmEnv).toEqual({ PATH: '/b', GITHUB_ACTIONS: 'true', ...oidc });
    expect(c.uvEnv).toEqual({ PATH: '/b', GITHUB_ACTIONS: 'true', ...oidc });
  });
  it('on a developer machine: each tool gets only its own token', () => {
    const c = publishCredentials({ PATH: '/b', NPM_TOKEN: 'n', PYPI_TOKEN: 'p', GITHUB_TOKEN: 'g' });
    expect(c.mode).toBe('token');
    expect(c.npmArgs).toEqual([]);
    expect(c.uvArgs).toEqual([]);
    expect(c.npmEnv).toEqual({ PATH: '/b', NPM_TOKEN: 'n' });
    expect(c.uvEnv).toEqual({ PATH: '/b', UV_PUBLISH_TOKEN: 'p' });
  });
  it('refuses when there is neither (no tokens, no OIDC)', () => {
    expect(() => publishCredentials({ PATH: '/b', NPM_TOKEN: 'n' })).toThrow('set NPM_TOKEN and PYPI_TOKEN, or run in GitHub Actions with id-token: write');
    expect(() => publishCredentials({ PATH: '/b', GITHUB_ACTIONS: 'true' })).toThrow('set NPM_TOKEN and PYPI_TOKEN, or run in GitHub Actions with id-token: write');
  });
});
