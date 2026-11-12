# Unstuck Cloud C1: Foundation, design spec

- **Date:** 2026-11-12
- **Status:** Draft for review
- **Scope:** Cloud sub-project C1 of 5
- **Parent spec:** `2026-11-12-unstuck-mvp-design.md` (Cloud v1 = its sub-project 2)
- **Code location:** a **private** repo (e.g. `velmlabs/unstuck-cloud`, to be created by the owner) that depends on the public `@unstuck/*` packages. This spec lives in the public repo until that repo exists, then moves there.

## 1. Cloud v1 decisions (all sub-projects)

| Topic | Decision |
|---|---|
| Hosting | Cloudflare (owner's account), `*.workers.dev` until a domain is bought; then a Workers custom domain |
| Sign-in | Email magic link only (no OAuth, no passwords) |
| Accounts | Single user per account (no teams in v1) |
| Email | Cloudflare Email Service (`send_email` binding). Requires the sending domain on **Cloudflare DNS**: buy the domain via Cloudflare Registrar or move its DNS there |
| Billing | Polar (merchant of record, usage-based meters) |
| v1 features | Hosted relay, accounts and API keys, Polar billing with a free tier quota, landing page, live demo, managed notifications, session history, hosted browsers (Browser Rendering), AI watch |
| Code | Private repo; open-source parts stay in the public repo |

### Sub-project order

| # | Sub-project | Usable result |
|---|---|---|
| **C1** | **Foundation (this spec):** Worker app, D1, magic-link sign-in, API keys, dashboard shell, landing page, deploys | People sign up and get an API key |
| C2 | Hosted relay (Durable Objects, end-to-end encryption), SDK relay mode, metering, free tier quota, Polar checkout and plans | Agents use Unstuck from anywhere; paid plans |
| C3 | Live demo and hosted browsers (Browser Rendering; spike: `docs/spikes/cloudflare-browser-rendering.md`) | Shareable "Try it" demo; hosted-browser product |
| C4 | Managed notifications and session history | Links delivered for you; takeover log |
| C5 | AI watch (after open-source Plan 2b `watch()`) | Paid auto-detection |

## 2. Goals and success criteria (C1)

1. A visitor reads the landing page, signs up with their email, and lands in the dashboard. In staging this works with the dev-mode link and no domain.
2. A signed-in user creates a named API key (shown once), sees it listed by prefix and last use, and revokes it.
3. Production runs on `unstuck-cloud.<account>.workers.dev`. Switching to a custom domain is a config change only.
4. Coverage stays above 90% in the cloud packages; the end-to-end sign-up flow passes against `wrangler dev` and against staging after deploy.

## 3. Architecture

One Worker (Hono router) serves API, auth and static assets. D1 holds data. C2 adds Durable Objects to the same Worker.

```
unstuck-cloud/  (private repo)
├─ worker/            Hono app
│   ├─ routes/        /, /login, /auth/verify, /logout, /dashboard/*, /api/v1/*
│   ├─ auth/          magic links, sessions, CSRF
│   ├─ keys/          API keys
│   └─ email/         EmailSender: CloudflareEmailSender | DevEmailSender
├─ web/               Vite build → Workers static assets
│   ├─ landing/       prerendered HTML (SEO), no JS required
│   └─ dashboard/     Preact SPA, design tokens shared with the public viewer
├─ migrations/        D1 SQL
└─ wrangler.toml      env.staging / env.production; bindings: DB (D1), EMAIL (send_email), LOGIN_LIMITER (rate limit), ASSETS
```

## 4. Data (D1)

| Table | Columns | Notes |
|---|---|---|
| `users` | `id` (text, random), `email` (unique, lowercased), `created_at`, `last_login_at` | C2 adds `plan`, `polar_customer_id` |
| `login_tokens` | `token_hash` (PK), `email`, `expires_at`, `used_at` | SHA-256 of the token; rows older than 1 day are purged on each login request |
| `sessions` | `id_hash` (PK), `user_id`, `created_at`, `expires_at`, `user_agent` | |
| `api_keys` | `id`, `user_id`, `name`, `prefix` (first 12 chars), `key_hash` (unique), `created_at`, `last_used_at`, `revoked_at` | |

## 5. Security

- **Magic link:** 32 random bytes (base64url), stored as SHA-256 only, valid **15 min**, single use (`used_at` set atomically). `POST /login` always answers "Check your email", whether or not the address has an account. Rate limited to **5 per 10 min per email** and **20 per 10 min per IP** (`429` with a friendly page).
- **Verify:** `GET /auth/verify?t=` shows a confirmation page with a button (`POST /auth/verify`). Email link scanners that pre-fetch URLs therefore can't consume the token. The first successful verify creates the user.
- **Session:** cookie `__Host-unstuck_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`, 30 days, stored hashed. Logout deletes the row.
- **CSRF:** state-changing `/api/v1/*` and form posts require a same-origin `Origin` header plus a per-session CSRF token (double submit).
- **API keys:** `uk_live_` + 32 base62 chars. Shown once, stored as SHA-256, listed by `prefix`. Revocation is immediate. Maximum 20 active keys per user.
- **Headers:** strict CSP (no third-party scripts), `Referrer-Policy: no-referrer` on auth pages, HSTS once on a custom domain.
- **Logs:** never contain emails, tokens or keys (hashed IDs only).
- **Dev mode:** `ENV=dev` (local and staging) uses `DevEmailSender`, which shows the link on the "Check your email" page. Production refuses to start with `DevEmailSender`.

## 6. Pages and flows

**Landing (`/`):**
1. Hero: "Your agent got stuck. A human gets it unstuck." Demo video slot, Sign up and Star on GitHub buttons.
2. How it works: agent calls `takeover()` → human gets a link → solves it on their phone → agent continues. Code tabs for TypeScript, Python and MCP.
3. Live demo: "Coming soon" until C3.
4. Open source + Cloud: the self-hosting story and what Cloud adds.
5. Pricing: "Free during early access" until C2 sets plans.
6. Footer: docs, GitHub, privacy and terms placeholders.

Designed with the `ui-ux-pro-max` skill; the dark slate and green tokens match the viewer.

**Sign-in:** `/login` (email) → "Check your email" → link → confirm → `/dashboard`.

**Dashboard (`/dashboard`):**
- **Overview:** getting-started checklist (create key → install SDK → first takeover).
- **API keys:** create (named, shown once, copy button), list, revoke with confirmation.
- **Account:** email, sign out, delete account (type your email to confirm; deletes keys and sessions).
- **Navigation placeholders:** Billing (C2), Browsers (C3), Notifications and History (C4), AI watch (C5).

**API:** `GET /api/v1/me`, `GET/POST /api/v1/keys`, `DELETE /api/v1/keys/:id`. All session-authenticated and CSRF-protected.

## 7. Environments and deploy

| Env | URL | Email | Data |
|---|---|---|---|
| dev | `wrangler dev` | Dev (link on page) | local D1 |
| staging | `unstuck-cloud-staging.<account>.workers.dev` | Dev (link on page) | D1 `unstuck-cloud-staging` |
| production | `unstuck-cloud.<account>.workers.dev` → custom domain later | Cloudflare Email Service once the domain is on Cloudflare DNS | D1 `unstuck-cloud` |

`pnpm deploy:staging` and `pnpm deploy:prod` run wrangler, applying D1 migrations first. Each deploy is followed by a smoke check against the live URL. GitHub Actions deploy is out of C1.

## 8. Testing

| Layer | Approach |
|---|---|
| Worker | Vitest with `@cloudflare/vitest-pool-workers` (real local D1, email and rate-limit bindings): token expiry and reuse, scanner-safe verify, session cookie flags, CSRF, no enumeration, key lifecycle, max keys, account deletion, prod refuses dev email |
| Dashboard | Preact component tests (jsdom) |
| End to end | Playwright against `wrangler dev`: sign up via the dev link → create key → revoke → sign out; landing renders without JS |
| Deploy | Smoke check of staging: `/` 200, `/login` 200, dev-mode sign-up works |

Coverage above 90% per package (owner's rule).

## 9. Out of scope (C1)

Relay, billing and quotas (C2); demo and hosted browsers (C3); notifications and history (C4); AI watch (C5); teams; OAuth sign-in; GitHub Actions deploys; custom domain setup (a follow-up once bought).

## 10. Risks

1. **Email Service access and DNS:** production email needs the domain on Cloudflare DNS and Email Service available on the account. Until then production can't send sign-in emails. Staging uses dev mode, and production waits for the domain.
2. **Private repo:** the owner must create it before implementation; this session attaches it.
3. **Workers static assets + SPA routing:** dashboard deep links (`/dashboard/keys`) must fall back to the SPA's `index.html` while API routes stay in the Worker. The `assets.not_found_handling = "single-page-application"` setting is scoped to `/dashboard/*` by Worker routing.
