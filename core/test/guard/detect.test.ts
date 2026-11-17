import { describe, it, expect } from 'vitest';
import { matchRules, detectHumanCheck, RULES, RULES_VERSION, APPROVAL_FAILED_RULES, type PageFacts } from '../../src/guard/detect';
import { FakeCdp } from '../../src/testing/fake-cdp';

const facts = (o: Partial<PageFacts> = {}): PageFacts => ({
  url: 'https://shop.example/',
  title: 'Shop',
  iframes: [],
  markers: [],
  tokenFields: {},
  passwordVisible: false,
  otpVisible: false,
  headings: [],
  bodyTextLength: 500,
  bodyTextHead: 'Welcome to the shop',
  ...o,
});

describe('matchRules', () => {
  it('cf-mitigated: challenge on the main document is a Cloudflare challenge', () =>
    expect(matchRules(facts({ url: 'https://shop.example/' }), { url: 'https://shop.example/', status: 403, headers: { 'cf-mitigated': 'challenge' } }, { scope: ['challenge'] })).toMatchObject({
      kind: 'challenge',
      vendor: 'cloudflare',
      ruleId: 'cloudflare.mitigated',
      site: 'shop.example',
      evidence: ['header cf-mitigated: challenge'],
    }));

  it('a header from an earlier document is not used for this page', () =>
    expect(matchRules(facts({ url: 'https://shop.example/next' }), { url: 'https://shop.example/', status: 403, headers: { 'cf-mitigated': 'challenge' } }, { scope: ['challenge'] })).toBeNull());

  it('a plain 403 is not a check', () => expect(matchRules(facts({ title: 'Forbidden' }), { url: 'u', status: 403, headers: {} }, { scope: ['challenge'] })).toBeNull());

  it('a long article that mentions CAPTCHAs is not a check', () =>
    expect(matchRules(facts({ headings: ['Are you a robot? How CAPTCHAs work'], bodyTextLength: 12_000 }), null, { scope: ['challenge'] })).toBeNull());

  it('a short "verify you are human" page is a generic challenge', () =>
    expect(matchRules(facts({ headings: ['Verify you are human'], bodyTextLength: 300 }), null, { scope: ['challenge'] })).toMatchObject({ ruleId: 'generic.heading', vendor: 'generic' }));

  it('a "Just a moment..." title with a challenge marker is the Cloudflare interstitial', () =>
    expect(matchRules(facts({ title: 'Just a moment...', markers: ['#challenge-form, #challenge-stage, #cf-challenge-running, script[src*="/cdn-cgi/challenge-platform/"]'] }), null, { scope: ['challenge'] })).toMatchObject({
      ruleId: 'cloudflare.interstitial',
      evidence: ['title "Just a moment..."', expect.stringMatching(/^marker /)],
    }));

  it('a visible Turnstile, reCAPTCHA v2 or hCaptcha widget with an empty token is a challenge', () => {
    const frame = (src: string) => ({ iframes: [{ src, width: 300, height: 65, visible: true }] });
    expect(matchRules(facts(frame('https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/x')), null, { scope: ['challenge'] })?.ruleId).toBe('cloudflare.turnstile');
    expect(matchRules(facts(frame('https://www.google.com/recaptcha/api2/anchor?ar=1&k=x')), null, { scope: ['challenge'] })?.ruleId).toBe('recaptcha.v2');
    expect(matchRules(facts(frame('https://newassets.hcaptcha.com/captcha/v1/x')), null, { scope: ['challenge'] })?.ruleId).toBe('hcaptcha');
    expect(matchRules(facts({ ...frame('https://newassets.hcaptcha.com/captcha/v1/x'), tokenFields: { 'h-captcha-response': 'P1_abc' } }), null, { scope: ['challenge'] })).toBeNull();
  });

  it('hidden or tiny widget frames are not checks', () => {
    const src = 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x';
    expect(matchRules(facts({ iframes: [{ src, width: 300, height: 65, visible: false }] }), null, { scope: ['challenge'] })).toBeNull();
    expect(matchRules(facts({ iframes: [{ src, width: 10, height: 10, visible: true }] }), null, { scope: ['challenge'] })).toBeNull();
  });

  it('login is only reported when in scope and reached by a redirect', () => {
    const f = facts({ url: 'https://app.example/account/login?next=/dash', passwordVisible: true });
    expect(matchRules(f, null, { scope: ['challenge'], requestedUrl: 'https://app.example/dash' })).toBeNull();
    expect(matchRules(f, null, { scope: ['challenge', 'login'], requestedUrl: 'https://app.example/account/login' })).toBeNull();
    expect(matchRules(f, null, { scope: ['challenge', 'login'] })).toBeNull();
    expect(matchRules(f, null, { scope: ['challenge', 'login'], requestedUrl: 'https://app.example/dash' })).toMatchObject({ kind: 'login', ruleId: 'login.redirect', site: 'app.example' });
  });

  it('a one-time code field with 2FA wording is a 2fa check when in scope', () => {
    const f = facts({ otpVisible: true, bodyTextHead: 'Enter the code we sent to your phone' });
    expect(matchRules(f, null, { scope: ['challenge'] })).toBeNull();
    expect(matchRules(f, null, { scope: ['2fa'] })).toMatchObject({ kind: '2fa', ruleId: '2fa.code' });
  });

  it('the site is the registrable domain of the page', () =>
    expect(matchRules(facts({ url: 'https://www.shop.example.co.uk/x', title: 'Just a moment...', headings: ['Verify you are human'], bodyTextLength: 10 }), null, { scope: ['challenge'] })?.site).toBe('example.co.uk'));

  it('every rule id is unique and the table is versioned', () => {
    expect(RULES_VERSION).toBe(2);
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    expect(RULES.map((r) => r.id)).toEqual(['cloudflare.mitigated', 'cloudflare.interstitial', 'cloudflare.turnstile', 'recaptcha.v2', 'hcaptcha', 'generic.title', 'generic.heading', 'login.redirect', '2fa.code', 'approval.prompt']);
  });

  // Review Focus 2
  it('a reCAPTCHA v3 badge (size=invisible) is not a check', () =>
    expect(matchRules(facts({ iframes: [{ src: 'https://www.google.com/recaptcha/api2/anchor?ar=1&k=x&size=invisible', width: 256, height: 60, visible: true }] }), null, { scope: ['challenge'] })).toBeNull());
});

describe('approval rules', () => {
  const a = (text: string, o: Partial<PageFacts> = {}) => matchRules(facts({ bodyTextHead: text, ...o }), null, { scope: ['approval'] });
  it.each([
    'Check your phone',
    'Check your device',
    'Tap Yes on the notification',
    'Approve this sign-in',
    'Approve login',
    'Approve request',
    'We sent a notification to your phone',
    'We sent a push to your phone',
    'Open the Okta Verify app to approve',
    'Open the Authenticator app to confirm',
    "Confirm it's you on your device",
    'Confirm it\u2019s you on your phone',
  ])('"%s" is an approval prompt', (text) => expect(a(text)).toMatchObject({ kind: 'approval', ruleId: 'approval.prompt' }));
  it.each(['Welcome to the shop', 'Enter the code we sent to your phone', 'Tap the menu', 'Please approve our terms', 'Open the app store'])('"%s" is not', (text) => expect(a(text)).toBeNull());
  it('is out of scope by default and never wins over earlier rules', () => {
    expect(matchRules(facts({ bodyTextHead: 'Check your phone' }), null, { scope: ['challenge', '2fa'] })).toBeNull();
  });
  it('needs no password or one-time code field', () => {
    expect(a('Check your phone', { passwordVisible: true })).toBeNull();
    expect(a('Check your phone', { otpVisible: true })).toBeNull();
  });
  it('is capped by the whole body length, not the head that was read', () => {
    expect(a('Check your phone', { bodyTextLength: 3000 })).not.toBeNull();
    expect(a('Check your phone', { bodyTextLength: 3001 })).toBeNull();
  });
  const failed = (text: string, o: Partial<PageFacts> = {}) => matchRules(facts({ bodyTextHead: text, ...o }), null, { scope: ['approval'], rules: APPROVAL_FAILED_RULES });
  it('failure rules', () => {
    expect(APPROVAL_FAILED_RULES.map((r) => r.id)).toEqual(['approval_failed.timed_out', 'approval_failed.denied', 'approval_failed.retry']);
    expect(APPROVAL_FAILED_RULES.every((r) => r.kind === 'approval')).toBe(true);
    for (const t of ['Request timed out', "We didn't hear from you", 'We didn\u2019t hear from you']) expect(failed(t)?.ruleId).toBe('approval_failed.timed_out');
    for (const t of ['Push was denied', 'Push rejected', 'Sign-in denied', 'Sign-in was denied']) expect(failed(t)?.ruleId).toBe('approval_failed.denied');
    expect(failed('Try again')?.ruleId).toBe('approval_failed.retry');
    expect(failed('Welcome to the shop')).toBeNull();
    expect(failed('Try again', { bodyTextLength: 3001 })).toBeNull();
  });
  it('failure rules do not match the approval prompt, nor the other way round', () => {
    expect(failed('Check your phone')).toBeNull();
    expect(a('Request timed out. Try again')).toBeNull();
  });
});

describe('detectHumanCheck', () => {
  const turnstile = (token: string) => facts({ iframes: [{ src: 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x', width: 300, height: 65, visible: true }], tokenFields: { 'cf-turnstile-response': token } });

  // Review Focus 2
  it('a Turnstile widget that fills its token within the grace period is not reported', async () => {
    const cdp = new FakeCdp();
    const answers = [turnstile(''), turnstile('XXXX.token')];
    cdp.respond('Runtime.evaluate', () => ({ result: { value: answers.shift() } }));
    await expect(detectHumanCheck(cdp, { widgetGraceMs: 10 })).resolves.toBeNull();
  });

  it('a widget still unsolved after the grace period is reported', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: turnstile('') } }));
    await expect(detectHumanCheck(cdp, { widgetGraceMs: 10 })).resolves.toMatchObject({ ruleId: 'cloudflare.turnstile' });
    expect(cdp.methods().filter((m) => m === 'Runtime.evaluate')).toHaveLength(2);
  });

  it("a widget whose iframe sits in a closed shadow root (today's Turnstile) is found through the DOM domain", async () => {
    const cdp = new FakeCdp();
    // In the page: the token field, but no iframe (the widget hides it in a closed shadow root).
    cdp.respond('Runtime.evaluate', () => ({ result: { value: facts({ tokenFields: { 'cf-turnstile-response': '' } }) } }));
    cdp.respond('DOM.getDocument', () => ({
      root: {
        nodeName: '#document',
        children: [
          {
            nodeName: 'DIV',
            shadowRoots: [{ nodeName: '#document-fragment', children: [{ nodeName: 'IFRAME', backendNodeId: 9, attributes: ['src', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/x/3x00000000000000000000FF/auto/normal'] }] }],
          },
        ],
      },
    }));
    cdp.respond('DOM.getBoxModel', () => ({ model: { width: 300, height: 65 } }));
    await expect(detectHumanCheck(cdp, { widgetGraceMs: 10 })).resolves.toMatchObject({ ruleId: 'cloudflare.turnstile', vendor: 'cloudflare' });
  });

  it('a shadow-root widget iframe that is tiny (an invisible widget) or has no box is not a check', async () => {
    for (const box of [() => ({ model: { width: 0, height: 0 } }), () => { throw new Error('Could not compute box model'); }]) {
      const cdp = new FakeCdp();
      cdp.respond('Runtime.evaluate', () => ({ result: { value: facts({ tokenFields: { 'cf-turnstile-response': '' } }) } }));
      cdp.respond('DOM.getDocument', () => ({ root: { nodeName: '#document', shadowRoots: [{ nodeName: '#document-fragment', children: [{ nodeName: 'IFRAME', backendNodeId: 9, attributes: ['src', 'https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/x'] }] }] } }));
      cdp.respond('DOM.getBoxModel', box);
      await expect(detectHumanCheck(cdp, { widgetGraceMs: 10 })).resolves.toBeNull();
    }
  });

  it('a page with no widget token field never pays for the DOM walk', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: facts() } }));
    await expect(detectHumanCheck(cdp, { widgetGraceMs: 10 })).resolves.toBeNull();
    expect(cdp.methods()).not.toContain('DOM.getDocument');
  });

  it('a non-widget check is reported at once', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: facts({ headings: ['Verify you are human'] }) } }));
    await expect(detectHumanCheck(cdp, { widgetGraceMs: 10_000 })).resolves.toMatchObject({ ruleId: 'generic.heading' });
  });

  it('uses the given scope, requested URL and main document', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: facts({ url: 'https://shop.example/' }) } }));
    await expect(detectHumanCheck(cdp, { document: { url: 'https://shop.example/', status: 503, headers: { 'cf-mitigated': 'challenge' } } })).resolves.toMatchObject({ ruleId: 'cloudflare.mitigated' });
    await expect(detectHumanCheck(cdp, { scope: ['login'] })).resolves.toBeNull();
  });

  it('uses the given rules', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ result: { value: facts({ bodyTextHead: 'Request timed out' }) } }));
    await expect(detectHumanCheck(cdp, { scope: ['approval'], rules: APPROVAL_FAILED_RULES })).resolves.toMatchObject({ ruleId: 'approval_failed.timed_out' });
    await expect(detectHumanCheck(cdp, { scope: ['approval'] })).resolves.toBeNull();
  });

  it('a page that cannot be read (mid-navigation) is not a check', async () => {
    const cdp = new FakeCdp();
    cdp.respond('Runtime.evaluate', () => ({ exceptionDetails: { text: 'Execution context was destroyed' } }));
    await expect(detectHumanCheck(cdp)).resolves.toBeNull();
    cdp.respond('Runtime.evaluate', () => {
      throw new Error('Cannot find context');
    });
    await expect(detectHumanCheck(cdp)).resolves.toBeNull();
  });
});
