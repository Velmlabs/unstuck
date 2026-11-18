// The Android app opens the viewer with the alert it already unsealed and whose sender it already checked natively:
// #t=…&k=…[&m=q|a]&from=<key>&r=<reason>&s=<site>[&q=<question>]. Only the app (its user agent says UnstuckAndroid/)
// may pass them: a plain link in a normal browser carrying them must not show a "From your key" line.
// The page title tells the app the session's state (live, ended, handed back).
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/preact';
import type { ConnectionHandlers } from '../src/connection';
import { App, type AppProps } from '../src/App';
import { inAppAlert } from '../src/url';

const APP_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36 UnstuckAndroid/0.1.0';
const BROWSER_UA = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36';
const KEY = 'A'.repeat(43);
const hash = (extra: string) => `#t=TOK&k=${KEY}${extra}`;
const NOW = 1_700_000_000_000;
let handlers: ConnectionHandlers;
const connectFn: AppProps['connectFn'] = (_u, _t, _c, h) => ((handlers = h), { send() {}, sendHello() {}, close() {}, wake() {}, ack() {} });
afterEach(() => cleanup());

describe('inAppAlert', () => {
  it('in-app params shown inside the app', () => {
    const a = inAppAlert(hash('&from=laptop&r=Solve%20the%20CAPTCHA&s=shop.example'), APP_UA)!;
    expect(a).toMatchObject({ reason: 'Solve the CAPTCHA', site: 'shop.example' });
    return expect(a.sender!()).resolves.toEqual({ keyName: 'laptop' });
  });

  it('in-app params ignored outside the app', () => {
    expect(inAppAlert(hash('&from=laptop&r=Pay%20now&s=bank.example'), BROWSER_UA)).toBeNull();
    expect(inAppAlert(hash(''), APP_UA)).toBeNull(); // the app always sends from/r/s; a bare link is a plain link
  });

  it('carries the mode and the question', () => {
    expect(inAppAlert(hash('&m=q&from=k&r=Your%20agent%20has%20a%20question&s=&q=Which%20flight%3F'), APP_UA)).toMatchObject({ mode: 'question', question: 'Which flight?' });
    expect(inAppAlert(hash('&m=a&from=k&r=Approve&s=mail.example'), APP_UA)).toMatchObject({ mode: 'approval', site: 'mail.example' });
  });
});

describe('the start page inside the app', () => {
  it('shows the reason as heading and the sender line', () => {
    const alert = inAppAlert(hash('&from=laptop&r=Solve%20the%20CAPTCHA&s=shop.example'), APP_UA)!;
    render(<App location={{ hash: hash(''), pathname: '/s/SESSION', origin: 'https://view.unstuck.sh' }} alert={alert} connectFn={connectFn} now={() => NOW} />);
    return screen.findByText(/From your key laptop · shop\.example/).then(() => expect(screen.getByRole('heading', { name: 'Solve the CAPTCHA' })).toBeTruthy());
  });
});

describe('document.title', () => {
  it('title follows the session: live, then handed back after Done', () => {
    render(<App location={{ hash: hash(''), pathname: '/s/SESSION2', origin: 'https://view.unstuck.sh' }} connectFn={connectFn} now={() => NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start takeover' }));
    act(() => {
      handlers.onReady({ t: 'ready', reason: 'r', site: '', expiresAt: NOW + 60_000, resumeKey: 'k' });
      handlers.onPhase('live');
    });
    expect(document.title).toBe('Unstuck · live');
    act(() => handlers.onState('resolved'));
    expect(document.title).toBe('Unstuck · handed back');
  });

  it('title says ended when the check ends without the person', () => {
    render(<App location={{ hash: hash(''), pathname: '/s/SESSION3', origin: 'https://view.unstuck.sh' }} connectFn={connectFn} now={() => NOW} />);
    fireEvent.click(screen.getByRole('button', { name: 'Start takeover' }));
    act(() => handlers.onPhase('ended'));
    expect(document.title).toBe('Unstuck · ended');
  });
});
