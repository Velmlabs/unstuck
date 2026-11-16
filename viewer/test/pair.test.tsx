import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/preact';
import { Pair, type PairProps } from '../src/pair/Pair';
import { captureInstall, type Installer } from '../src/pair/install';
import type { DeviceRecord, DeviceStore } from '../src/device-store';

afterEach(() => cleanup());

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';

function memoryStore(rec: DeviceRecord | null = null): DeviceStore & { rec: DeviceRecord | null } {
  const s = {
    rec,
    get: async () => s.rec,
    put: async (r: DeviceRecord) => void (s.rec = r),
    clear: async () => void (s.rec = null),
  };
  return s;
}
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function setup(over: Partial<PairProps> = {}) {
  const store = memoryStore();
  const history = { replaceState: vi.fn() };
  const openUrl = vi.fn();
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/devices/pair')) return json(200, { deviceId: 'dev1', deviceToken: 'tok1' });
    if (url.endsWith('/push/vapid')) return json(200, { publicKey: 'VAPIDKEY' });
    if (url.endsWith('/devices/self/push')) return json(200, {});
    if (url.endsWith('/devices/self/telegram')) return json(200, { url: 'https://t.me/unstuck_bot?start=abc' });
    return json(404, {});
  });
  const props: PairProps = {
    code: 'CODE1',
    apiBase: 'https://unstuck.sh',
    pathname: '/pair',
    search: '?api=x',
    store,
    history,
    env: { userAgent: ANDROID, standalone: false, maxTouchPoints: 5, canPush: true },
    fetchFn: fetchFn as unknown as typeof fetch,
    subscribePush: vi.fn(async () => ({ endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } })),
    openUrl,
    ...over,
  };
  render(<Pair {...props} />);
  return { props, store, history, openUrl, fetchFn };
}
const pairNow = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Pair this phone' }));
};

describe('pairing', () => {
  it('removes the code from the address bar and offers a label that defaults from the user agent', async () => {
    const { history } = setup();
    expect(history.replaceState).toHaveBeenCalledWith(null, '', '/pair?api=x');
    expect((await screen.findByLabelText(/name/i)) as HTMLInputElement).toHaveProperty('value', 'Android · Chrome');
  });

  it('creates a key, posts code + public key + label, stores the device record and moves on', async () => {
    const { store, fetchFn } = setup();
    fireEvent.input(await screen.findByLabelText(/name/i), { target: { value: 'My Pixel' } });
    await pairNow();
    await screen.findByText(/this phone is paired/i);
    const call = fetchFn.mock.calls.find((c) => c[0] === 'https://unstuck.sh/api/v1/devices/pair')!;
    const body = JSON.parse(call[1]!.body as string);
    expect(body.code).toBe('CODE1');
    expect(body.label).toBe('My Pixel');
    expect(body.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect((call[1] as RequestInit).method).toBe('POST');
    expect(store.rec?.deviceId).toBe('dev1');
    expect(store.rec?.deviceToken).toBe('tok1');
    expect(store.rec?.privateKey.extractable).toBe(false);
  });

  it('shows the expired message for a used or expired code, and stores nothing', async () => {
    for (const status of [404, 410]) {
      cleanup();
      const { store } = setup({ fetchFn: (async () => json(status, { error: 'invalid_code' })) as unknown as typeof fetch });
      await pairNow();
      await screen.findByText('This pairing code has expired. Make a new one in your dashboard.');
      expect(store.rec).toBeNull();
    }
  });

  it('a 400 says to make a new code', async () => {
    const { store } = setup({ fetchFn: (async () => json(400, {})) as unknown as typeof fetch });
    await pairNow();
    await screen.findByText('Could not pair this phone. Make a new code in your dashboard and try again.');
    expect(store.rec).toBeNull();
  });

  it('shows a retry message when Cloud cannot be reached or fails', async () => {
    setup({ fetchFn: (async () => { throw new Error('offline'); }) as unknown as typeof fetch });
    await pairNow();
    await screen.findByText(/could not reach unstuck/i);
    cleanup();
    setup({ fetchFn: (async () => json(500, {})) as unknown as typeof fetch });
    await pairNow();
    await screen.findByText(/could not reach unstuck/i);
  });

  it('with no code and no paired phone asks for the code; with a stored phone shows it as paired', async () => {
    setup({ code: null });
    await screen.findByLabelText('Enter the pairing code from your dashboard');
    cleanup();
    setup({ code: null, store: memoryStore({ deviceId: 'd', deviceToken: 't', privateKey: {} as CryptoKey }) });
    await screen.findByText(/this phone is paired/i);
  });

  it('a typed code is normalised (uppercase, no dash) and sent; a malformed one is not sent', async () => {
    const { fetchFn, store } = setup({ code: null });
    const input = await screen.findByLabelText('Enter the pairing code from your dashboard');
    fireEvent.input(input, { target: { value: 'abc' } });
    await pairNow();
    await screen.findByText(/does not look right/i);
    expect(fetchFn).not.toHaveBeenCalled();
    fireEvent.input(input, { target: { value: 'abcd-efgh' } });
    await pairNow();
    await screen.findByText(/this phone is paired/i);
    expect(JSON.parse(fetchFn.mock.calls[0]![1]!.body as string).code).toBe('ABCDEFGH');
    expect(store.rec?.deviceId).toBe('dev1');
  });

  it('stores the API base and the label with the device record', async () => {
    const { store } = setup({ apiBase: 'https://staging.example' });
    fireEvent.input(await screen.findByLabelText(/name/i), { target: { value: 'My Pixel' } });
    await pairNow();
    await screen.findByText(/this phone is paired/i);
    expect(store.rec).toMatchObject({ apiBase: 'https://staging.example', label: 'My Pixel' });
  });
});

describe('pairing a browser that is already paired', () => {
  const old = () => memoryStore({ deviceId: 'old', deviceToken: 'oldtok', privateKey: {} as CryptoKey, label: 'Old Pixel' });

  it('asks first; Keep current keeps the old pairing and sends nothing but the status read', async () => {
    const store = old();
    const { fetchFn } = setup({ store });
    await screen.findByText('This browser is already paired as Old Pixel. Pair it again?');
    expect(screen.queryByRole('button', { name: 'Pair this phone' })).toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Keep current' }));
    await screen.findByText(/this phone is paired/i);
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    expect(fetchFn.mock.calls[0]![0]).toBe('https://unstuck.sh/api/v1/devices/self');
    expect((fetchFn.mock.calls[0]![1] as RequestInit).method).toBeUndefined();
    expect((fetchFn.mock.calls[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer oldtok' });
    expect(store.rec?.deviceId).toBe('old');
  });

  it('Pair again pairs the new device, then removes the old one with its own token, then stores the new record', async () => {
    const store = old();
    const { fetchFn } = setup({ store });
    fireEvent.click(await screen.findByRole('button', { name: 'Pair again' }));
    await pairNow();
    await screen.findByText(/this phone is paired/i);
    const urls = fetchFn.mock.calls.slice(0, 2).map((c) => c[0]);
    expect(urls).toEqual(['https://unstuck.sh/api/v1/devices/pair', 'https://unstuck.sh/api/v1/devices/self']);
    const del = fetchFn.mock.calls[1]![1] as RequestInit;
    expect(del.method).toBe('DELETE');
    expect(del.headers).toMatchObject({ Authorization: 'Bearer oldtok' });
    expect(store.rec?.deviceId).toBe('dev1');
  });

  it('still stores the new pairing when removing the old one fails', async () => {
    const store = old();
    const fetchFn = vi.fn(async (url: string) => (url.endsWith('/devices/pair') ? json(200, { deviceId: 'dev1', deviceToken: 'tok1' }) : Promise.reject(new Error('offline'))));
    setup({ store, fetchFn: fetchFn as unknown as typeof fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Pair again' }));
    await pairNow();
    await screen.findByText(/this phone is paired/i);
    expect(store.rec?.deviceId).toBe('dev1');
  });

  it('a failed new pairing keeps the old record and never removes the old device', async () => {
    const store = old();
    const fetchFn = vi.fn(async () => json(410, { error: 'code_expired' }));
    setup({ store, fetchFn: fetchFn as unknown as typeof fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Pair again' }));
    await pairNow();
    await screen.findByText(/has expired/i);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.rec?.deviceId).toBe('old');
  });

  it('an old record without a label is asked about without one', async () => {
    setup({ store: memoryStore({ deviceId: 'd', deviceToken: 't', privateKey: {} as CryptoKey }) });
    await screen.findByText('This browser is already paired. Pair it again?');
  });

  it('opened without a code it shows the paired state with Telegram and push, not the code field', async () => {
    setup({ code: null, store: old() });
    await screen.findByText(/this phone is paired as Old Pixel/i);
    expect(screen.queryByLabelText('Enter the pairing code from your dashboard')).toBeNull();
    expect(screen.getByRole('button', { name: /connect telegram/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /turn on phone notifications/i })).toBeTruthy();
  });
});

describe('phone notifications', () => {
  it('shown on Android Chrome: asks for permission through subscribePush and sends the subscription with the device token', async () => {
    const { fetchFn, props } = setup();
    await pairNow();
    fireEvent.click(await screen.findByRole('button', { name: /turn on phone notifications/i }));
    await screen.findByText(/phone notifications are on/i);
    expect(props.subscribePush).toHaveBeenCalledWith('VAPIDKEY');
    const put = fetchFn.mock.calls.find((c) => c[0] === 'https://unstuck.sh/api/v1/devices/self/push')!;
    expect((put[1] as RequestInit).method).toBe('PUT');
    expect((put[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok1' });
    expect(JSON.parse((put[1] as RequestInit).body as string)).toEqual({ subscription: { endpoint: 'https://push.example/1', keys: { p256dh: 'a', auth: 'b' } } });
  });

  it('says so when permission is refused or subscribing fails', async () => {
    setup({ subscribePush: vi.fn(async () => { throw new Error('denied'); }) });
    await pairNow();
    fireEvent.click(await screen.findByRole('button', { name: /turn on phone notifications/i }));
    await screen.findByText(/could not turn on phone notifications/i);
  });

  it('says so when Cloud refuses the subscription or the VAPID key', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/devices/pair')) return json(200, { deviceId: 'dev1', deviceToken: 'tok1' });
      return json(500, {});
    });
    setup({ fetchFn: fetchFn as unknown as typeof fetch });
    await pairNow();
    fireEvent.click(await screen.findByRole('button', { name: /turn on phone notifications/i }));
    await screen.findByText(/could not turn on phone notifications/i);
  });

  it('is not offered in iPhone Safari: two paths, and the home-screen path does not use the code', async () => {
    const { fetchFn } = setup({ env: { userAgent: IPHONE, standalone: false, maxTouchPoints: 5, canPush: false } });
    expect(await screen.findByRole('heading', { name: /add to home screen for phone notifications/i })).toBeTruthy();
    expect(screen.getByText(/enter a new pairing code from your dashboard/i)).toBeTruthy();
    expect(fetchFn).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pair Safari (for Telegram and email links)' }));
    await screen.findByText(/this phone is paired/i);
    expect(screen.queryByRole('button', { name: /turn on phone notifications/i })).toBeNull();
    expect(screen.getByRole('button', { name: /connect telegram/i })).toBeTruthy();
    // Paired, the steps sit behind Install Unstuck (see 'install').
    fireEvent.click(screen.getByRole('button', { name: 'Install Unstuck' }));
    expect(screen.getByRole('heading', { name: /add to home screen for phone notifications/i })).toBeTruthy();
  });

  it('is offered in the iPhone home-screen app', async () => {
    setup({ env: { userAgent: IPHONE, standalone: true, maxTouchPoints: 5, canPush: true } });
    await pairNow();
    await screen.findByRole('button', { name: /turn on phone notifications/i });
    expect(screen.queryByText(/add to home screen/i)).toBeNull();
    expect(screen.queryByText(/Safari/)).toBeNull();
  });

  it('is hidden where the browser cannot do push at all', async () => {
    setup({ env: { userAgent: ANDROID, standalone: false, maxTouchPoints: 5, canPush: false } });
    await pairNow();
    await screen.findByText(/this phone is paired/i);
    expect(screen.queryByRole('button', { name: /turn on phone notifications/i })).toBeNull();
  });
});

describe('telegram', () => {
  it('opens the returned t.me link, with the in-app browser tip shown', async () => {
    const { openUrl, fetchFn } = setup();
    await pairNow();
    expect(await screen.findByText(/in-app browser/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /connect telegram/i }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://t.me/unstuck_bot?start=abc'));
    const call = fetchFn.mock.calls.find((c) => c[0] === 'https://unstuck.sh/api/v1/devices/self/telegram')!;
    expect((call[1] as RequestInit).method).toBe('POST');
    expect((call[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok1' });
  });

  it('refuses to open anything that is not a t.me link, and reports failures', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/devices/pair')) return json(200, { deviceId: 'dev1', deviceToken: 'tok1' });
      return json(200, { url: 'https://evil.example/' });
    });
    const { openUrl } = setup({ fetchFn: fetchFn as unknown as typeof fetch });
    await pairNow();
    fireEvent.click(await screen.findByRole('button', { name: /connect telegram/i }));
    await screen.findByText(/could not start telegram/i);
    expect(openUrl).not.toHaveBeenCalled();
    cleanup();
    setup({ fetchFn: ((u: string) => (u.endsWith('/devices/pair') ? Promise.resolve(json(200, { deviceId: 'd', deviceToken: 't' })) : Promise.resolve(json(500, {})))) as unknown as typeof fetch });
    await pairNow();
    fireEvent.click(await screen.findByRole('button', { name: /connect telegram/i }));
    await screen.findByText(/could not start telegram/i);
  });
});

describe('alert channels once paired: Telegram recommended first, phone notifications optional second', () => {
  const DOCS = 'https://unstuck.sh/docs/alerts/#notifications-that-dont-show-up';
  const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('Telegram comes first, labelled recommended, with the one filled button; notifications follow, optional and outlined', async () => {
    setup();
    await pairNow();
    const tg = await screen.findByRole('region', { name: 'Get alerts on Telegram (recommended)' });
    const push = screen.getByRole('region', { name: 'Also show phone notifications (optional)' });
    expect(before(tg, push)).toBe(true);
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Get alerts on Telegram (recommended)', 'Also show phone notifications (optional)']);
    expect(tg.textContent).toContain('Arrives reliably, even when your phone saves battery.');
    expect(tg.textContent).not.toContain('Safari');
    const connect = screen.getByRole('button', { name: 'Connect Telegram' });
    const turnOn = screen.getByRole('button', { name: 'Turn on phone notifications' });
    expect(tg.contains(connect)).toBe(true);
    expect(push.contains(turnOn)).toBe(true);
    expect(connect.className).not.toContain('btn-ghost');
    expect(turnOn.className).toContain('btn-ghost');
    expect(push.textContent).toContain('Some phones hold browser notifications back to save battery.');
    const link = screen.getByRole('link', { name: 'Why notifications may not show up' });
    expect(link.getAttribute('href')).toBe(DOCS);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('Install Unstuck sits with phone notifications, outlined', async () => {
    const t = new EventTarget() as EventTarget & { matchMedia: (q: string) => { matches: boolean } };
    t.matchMedia = () => ({ matches: false });
    const install = captureInstall(t);
    const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
    e.prompt = async () => {};
    e.userChoice = Promise.resolve({ outcome: 'dismissed' });
    t.dispatchEvent(e);
    setup({ install });
    await pairNow();
    const push = await screen.findByRole('region', { name: 'Also show phone notifications (optional)' });
    const button = screen.getByRole('button', { name: 'Install Unstuck' });
    expect(push.contains(button)).toBe(true);
    expect(before(screen.getByRole('button', { name: 'Turn on phone notifications' }), button)).toBe(true);
    expect(button.className).toContain('btn-ghost');
  });

  it('iPhone Safari: Telegram works right here in Safari; notifications say they need the Home Screen app, behind Install Unstuck', async () => {
    setup({ install: captureInstall(new EventTarget()), env: { userAgent: IPHONE, standalone: false, maxTouchPoints: 5, canPush: false } });
    fireEvent.click(await screen.findByRole('button', { name: 'Pair Safari (for Telegram and email links)' }));
    const tg = await screen.findByRole('region', { name: 'Get alerts on Telegram (recommended)' });
    const push = screen.getByRole('region', { name: 'Also show phone notifications (optional)' });
    expect(before(tg, push)).toBe(true);
    expect(tg.textContent).toContain('Arrives reliably, even when your phone saves battery, and works right here in Safari.');
    expect(push.textContent).toContain('On iPhone, notifications need Unstuck on your Home Screen. Telegram does not.');
    expect(push.contains(screen.getByRole('link', { name: 'Why notifications may not show up' }))).toBe(true);
    expect(screen.queryByRole('button', { name: /turn on phone notifications/i })).toBeNull();
    expect(push.contains(screen.getByRole('button', { name: 'Install Unstuck' }))).toBe(true);
  });

  it('where the browser cannot do push at all, only Telegram is offered; an install option still shows after it', async () => {
    const win = new EventTarget() as EventTarget & { matchMedia: (q: string) => { matches: boolean } };
    win.matchMedia = (q) => ({ matches: q === '(display-mode: standalone)' });
    setup({ install: captureInstall(win), env: { userAgent: ANDROID, standalone: false, maxTouchPoints: 5, canPush: false } });
    await pairNow();
    const tg = await screen.findByRole('region', { name: 'Get alerts on Telegram (recommended)' });
    expect(screen.queryByRole('region', { name: /phone notifications/i })).toBeNull();
    expect(screen.queryByRole('link', { name: /notifications/i })).toBeNull();
    const installed = screen.getByText('Unstuck is installed on this phone.');
    expect(before(tg, installed)).toBe(true);
  });

  it('Telegram connected: its status shows under the recommended heading, before notifications', async () => {
    const fetchFn = vi.fn(async (url: string) => (url.endsWith('/api/v1/devices/self') ? json(200, { label: 'Galaxy', push: false, telegram: true, telegramAnyBrowser: false }) : json(404, {})));
    setup({ code: null, store: memoryStore({ deviceId: 'd', deviceToken: 't', privateKey: {} as CryptoKey }), fetchFn: fetchFn as unknown as typeof fetch });
    const connected = await screen.findByText('Telegram is connected: alerts for this phone arrive in your Telegram chat.');
    const tg = screen.getByRole('region', { name: 'Get alerts on Telegram (recommended)' });
    expect(tg.contains(connected)).toBe(true);
    expect(before(connected, screen.getByRole('button', { name: 'Turn on phone notifications' }))).toBe(true);
  });
});

describe('status once paired (what Cloud says is really set up)', () => {
  const paired = () => memoryStore({ deviceId: 'dev9', deviceToken: 'tok9', privateKey: {} as CryptoKey, label: 'Galaxy' });
  type Status = { label: string; push: boolean; telegram: boolean; telegramAnyBrowser: boolean };
  function withStatus(first: Status | number, extra: (url: string, init?: RequestInit) => Response | undefined = () => undefined) {
    let status: Status | number = first;
    const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
      const e = extra(url, init);
      if (e) return e;
      if (url.endsWith('/api/v1/devices/self') && (init?.method ?? 'GET') === 'GET') return typeof status === 'number' ? json(status, {}) : json(200, status);
      if (url.endsWith('/devices/self/telegram')) return json(200, { url: 'https://t.me/unstuck_bot?start=abc' });
      return json(404, {});
    });
    const set = (s: Status | number) => void (status = s);
    return { fetchFn, set };
  }
  const st = (o: Partial<Status> = {}): Status => ({ label: 'Galaxy', push: false, telegram: false, telegramAnyBrowser: false, ...o });
  const statusCalls = (fetchFn: ReturnType<typeof vi.fn>) => fetchFn.mock.calls.filter((c) => c[0] === 'https://unstuck.sh/api/v1/devices/self' && !(c[1] as RequestInit | undefined)?.method);
  afterEach(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  });

  it('loads the status with the device token on mount', async () => {
    const { fetchFn } = withStatus(st());
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    await waitFor(() => expect(statusCalls(fetchFn)).toHaveLength(1));
    expect((statusCalls(fetchFn)[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok9' });
  });

  it('Telegram linked: says so, with a smaller Reconnect Telegram button instead of Connect Telegram', async () => {
    const { fetchFn } = withStatus(st({ telegram: true }));
    const { openUrl } = setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    expect(await screen.findByText('Telegram is connected: alerts for this phone arrive in your Telegram chat.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Connect Telegram' })).toBeNull();
    const again = screen.getByRole('button', { name: 'Reconnect Telegram' });
    expect(again.className).toContain('btn-small');
    fireEvent.click(again);
    await waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://t.me/unstuck_bot?start=abc'));
  });

  it('not linked: Connect Telegram as before, and no any-browser toggle', async () => {
    const { fetchFn } = withStatus(st());
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    await waitFor(() => expect(statusCalls(fetchFn)).toHaveLength(1));
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeTruthy();
    expect(screen.queryByText(/Telegram is connected/)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /any browser/i })).toBeNull();
  });

  it('push on: "Phone notifications are on." and the button stays as Turn on again', async () => {
    const { fetchFn } = withStatus(st({ push: true }));
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    expect(await screen.findByText('Phone notifications are on.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn on again' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Turn on phone notifications' })).toBeNull();
  });

  it('a failed status load (error or network) keeps today’s buttons and shows nothing alarming', async () => {
    for (const fail of [500, 'throw'] as const) {
      cleanup();
      const fetchFn = vi.fn(async () => (fail === 'throw' ? Promise.reject(new Error('offline')) : json(fail, {})));
      setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
      await waitFor(() => expect(fetchFn).toHaveBeenCalled());
      expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Turn on phone notifications' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
    }
  });

  it('a malformed status body is ignored', async () => {
    const fetchFn = vi.fn(async () => json(200, { push: 'yes' }));
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    await waitFor(() => expect(fetchFn).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Connect Telegram' })).toBeTruthy();
  });

  it('refreshes when the page becomes visible again (back from Telegram) and on pageshow; not while hidden', async () => {
    const { fetchFn, set } = withStatus(st());
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    await waitFor(() => expect(statusCalls(fetchFn)).toHaveLength(1));
    set(st({ telegram: true }));
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(statusCalls(fetchFn)).toHaveLength(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByText(/Telegram is connected/)).toBeTruthy();
    expect(statusCalls(fetchFn)).toHaveLength(2);
    // pageshow only matters when restored from the back/forward cache.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }));
    expect(statusCalls(fetchFn)).toHaveLength(2);
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    await waitFor(() => expect(statusCalls(fetchFn)).toHaveLength(3));
  });

  it('skips a refresh while one is in flight', async () => {
    let answer: (r: Response) => void = () => {};
    const fetchFn = vi.fn(() => new Promise<Response>((r) => (answer = r)));
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(1));
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(fetchFn).toHaveBeenCalledTimes(1);
    answer(json(200, st({ telegram: true })));
    expect(await screen.findByText(/Telegram is connected/)).toBeTruthy();
    document.dispatchEvent(new Event('visibilitychange'));
    await waitFor(() => expect(fetchFn).toHaveBeenCalledTimes(2));
  });

  it('only the latest answer applies: a status read that started before a toggle cannot undo it', async () => {
    const answers: ((r: Response) => void)[] = [];
    const fetchFn = vi.fn((url: string) => {
      if (url.endsWith('/telegram-any-browser')) return Promise.resolve(json(200, st({ telegram: true, telegramAnyBrowser: true })));
      return new Promise<Response>((r) => answers.push(r));
    });
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    await waitFor(() => expect(answers).toHaveLength(1));
    answers[0]!(json(200, st({ telegram: true })));
    const box = (await screen.findByRole('checkbox', { name: 'Telegram links open in any browser' })) as HTMLInputElement;
    document.dispatchEvent(new Event('visibilitychange')); // a read in flight…
    await waitFor(() => expect(answers).toHaveLength(2));
    fireEvent.click(box); // …then the toggle
    await waitFor(() => expect(box.checked).toBe(true));
    answers[1]!(json(200, st({ telegram: true, telegramAnyBrowser: false }))); // the stale read lands last
    await new Promise((r) => setTimeout(r, 20));
    expect(box.checked).toBe(true);
  });

  it('stops listening once the page is gone', async () => {
    const { fetchFn } = withStatus(st());
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    await waitFor(() => expect(statusCalls(fetchFn)).toHaveLength(1));
    cleanup();
    window.dispatchEvent(new Event('pageshow'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(statusCalls(fetchFn)).toHaveLength(1);
  });

  it('a phone just paired loads its status too', async () => {
    const { fetchFn } = withStatus(st(), (url) => (url.endsWith('/devices/pair') ? json(200, { deviceId: 'dev1', deviceToken: 'tok1' }) : undefined));
    setup({ fetchFn: fetchFn as unknown as typeof fetch });
    await pairNow();
    await waitFor(() => expect(statusCalls(fetchFn)).toHaveLength(1));
    expect((statusCalls(fetchFn)[0]![1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok1' });
  });

  it('turning push on updates the status line', async () => {
    const { fetchFn } = withStatus(st(), (url) => {
      if (url.endsWith('/push/vapid')) return json(200, { publicKey: 'V' });
      if (url.endsWith('/devices/self/push')) return json(200, {});
      return undefined;
    });
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on phone notifications' }));
    expect(await screen.findByText('Phone notifications are on.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Turn on again' })).toBeTruthy();
  });
});

describe('"Telegram links open in any browser"', () => {
  const paired = () => memoryStore({ deviceId: 'dev9', deviceToken: 'tok9', privateKey: {} as CryptoKey, label: 'Galaxy' });
  const COPY = 'Telegram links then carry the key that opens them, so Unstuck Cloud, Telegram and anyone you forward the message to could open your takeovers. Phone notifications stay locked to this browser.';
  function server(initial: boolean, put: (enabled: boolean) => Response = (enabled) => json(200, { label: 'Galaxy', push: false, telegram: true, telegramAnyBrowser: enabled })) {
    return vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/devices/self/telegram-any-browser')) return put(JSON.parse(String(init!.body)).enabled);
      if (url.endsWith('/api/v1/devices/self')) return json(200, { label: 'Galaxy', push: false, telegram: true, telegramAnyBrowser: initial });
      return json(404, {});
    });
  }

  it('off by default, shown under Telegram with the plain trade-off; turning it on PUTs {enabled: true} with the device token', async () => {
    const fetchFn = server(false);
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    const box = (await screen.findByRole('checkbox', { name: 'Telegram links open in any browser' })) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(COPY)).toBeTruthy();
    // Left off: the in-app browser tip stays.
    expect(screen.getByText(/in-app browser/i)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    const put = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('/telegram-any-browser'))!;
    expect(put[0]).toBe('https://unstuck.sh/api/v1/devices/self/telegram-any-browser');
    expect((put[1] as RequestInit).method).toBe('PUT');
    expect((put[1] as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok9' });
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ enabled: true });
  });

  it('on: turning it off PUTs {enabled: false}', async () => {
    const fetchFn = server(true);
    setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
    const box = (await screen.findByRole('checkbox', { name: 'Telegram links open in any browser' })) as HTMLInputElement;
    await waitFor(() => expect(box.checked).toBe(true));
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(false));
    const put = fetchFn.mock.calls.find((c) => String(c[0]).endsWith('/telegram-any-browser'))!;
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ enabled: false });
  });

  it('a refused or failed change says so and keeps the old state', async () => {
    for (const put of [() => json(409, { error: 'telegram_not_linked' }), () => Promise.reject(new Error('offline')) as never]) {
      cleanup();
      const fetchFn = server(false, put);
      setup({ code: null, store: paired(), fetchFn: fetchFn as unknown as typeof fetch });
      const box = (await screen.findByRole('checkbox', { name: 'Telegram links open in any browser' })) as HTMLInputElement;
      fireEvent.click(box);
      expect(await screen.findByText('Could not change this setting. Try again.')).toBeTruthy();
      expect(box.checked).toBe(false);
    }
  });
});

describe('install', () => {
  /** A stand-in for Chrome's window: events can be fired at it, and display-mode is settable. */
  function fakeWindow(standalone = false) {
    const t = new EventTarget() as EventTarget & { matchMedia: (q: string) => { matches: boolean } };
    t.matchMedia = (q) => ({ matches: standalone && q === '(display-mode: standalone)' });
    return t;
  }
  function promptEvent(outcome: 'accepted' | 'dismissed') {
    const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: ReturnType<typeof vi.fn>; userChoice: Promise<{ outcome: string }> };
    e.prompt = vi.fn(async () => {});
    e.userChoice = Promise.resolve({ outcome });
    return e;
  }
  const paired = async (install: Installer, env: Partial<PairProps['env']> = {}) => {
    setup({ install, env: { userAgent: ANDROID, standalone: false, maxTouchPoints: 5, canPush: true, ...env } });
    fireEvent.click(await screen.findByRole('button', { name: /^Pair (this phone|Safari)/ }));
    await screen.findByText(/this phone is paired/i);
  };
  const LINE = 'Installs Unstuck as an app, so takeover links and notifications open in it.';

  it('offers Install Unstuck once Chrome gave its prompt, and hides it after the install is accepted', async () => {
    const win = fakeWindow();
    const install = captureInstall(win);
    await paired(install);
    expect(screen.queryByRole('button', { name: 'Install Unstuck' })).toBeNull();
    const e = promptEvent('accepted');
    act(() => void win.dispatchEvent(e));
    expect(e.defaultPrevented).toBe(true); // Chrome's own mini-infobar is kept away: the page offers it
    const button = screen.getByRole('button', { name: 'Install Unstuck' });
    expect(button.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByText(LINE)).toBeTruthy();
    fireEvent.click(button);
    // Gone as soon as the prompt is up (the event can't be used twice), before the person answers.
    expect(screen.queryByRole('button', { name: 'Install Unstuck' })).toBeNull();
    expect(e.prompt).toHaveBeenCalledOnce();
    act(() => void win.dispatchEvent(new Event('appinstalled')));
    expect(screen.getByText('Unstuck is installed on this phone.')).toBeTruthy();
  });

  it('after a dismissal the spent prompt goes, and a new one from the browser brings the button back', async () => {
    const win = fakeWindow();
    const install = captureInstall(win);
    act(() => void win.dispatchEvent(promptEvent('dismissed')));
    await paired(install);
    fireEvent.click(screen.getByRole('button', { name: 'Install Unstuck' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Install Unstuck' })).toBeNull());
    expect(screen.queryByText('Unstuck is installed on this phone.')).toBeNull();
    act(() => void win.dispatchEvent(promptEvent('dismissed')));
    expect(screen.getByRole('button', { name: 'Install Unstuck' })).toBeTruthy();
  });

  it('already installed (display-mode standalone, or the iPhone home-screen app): says so, no button', async () => {
    const win = fakeWindow(true);
    const install = captureInstall(win);
    act(() => void win.dispatchEvent(promptEvent('accepted')));
    await paired(install);
    expect(screen.getByText('Unstuck is installed on this phone.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Install Unstuck' })).toBeNull();
    cleanup();
    await paired(captureInstall(fakeWindow(), { standalone: true }), { userAgent: IPHONE, standalone: true });
    expect(screen.getByText('Unstuck is installed on this phone.')).toBeTruthy();
    cleanup();
    // A computer's installed app (no touch): no "on this phone", and no button.
    await paired(captureInstall(fakeWindow(true)), { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36', maxTouchPoints: 0 });
    expect(screen.queryByText(/installed on this phone/i)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Install Unstuck' })).toBeNull();
  });

  it('iPhone Safari (no prompt): the button opens and closes the Add to Home Screen steps', async () => {
    await paired(captureInstall(fakeWindow()), { userAgent: IPHONE, canPush: false });
    const button = screen.getByRole('button', { name: 'Install Unstuck' });
    expect(screen.getByText('Adds Unstuck to your Home Screen so it can show phone notifications (pair it again there).')).toBeTruthy();
    expect(screen.queryByText(LINE)).toBeNull(); // that line is for Chrome's prompt only
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByRole('heading', { name: /add to home screen/i })).toBeNull();
    fireEvent.click(button);
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/tap share, then add to home screen/i)).toBeTruthy();
    fireEvent.click(button);
    expect(screen.queryByRole('heading', { name: /add to home screen/i })).toBeNull();
  });

  it('browsers with no install prompt (and not iPhone) show nothing; so does a page with no installer', async () => {
    await paired(captureInstall(fakeWindow()));
    expect(screen.queryByRole('button', { name: 'Install Unstuck' })).toBeNull();
    expect(screen.queryByText(LINE)).toBeNull();
    expect(screen.queryByText(/installed on this phone/i)).toBeNull();
    cleanup();
    setup({ env: { userAgent: ANDROID, standalone: false, maxTouchPoints: 5, canPush: true } });
    await pairNow();
    await screen.findByText(/this phone is paired/i);
    expect(screen.queryByRole('button', { name: 'Install Unstuck' })).toBeNull();
  });
});

describe('captureInstall', () => {
  it('a prompt that fails, or none at all, is unavailable; a window without matchMedia is not standalone', async () => {
    const win = new EventTarget();
    const install = captureInstall(win);
    expect(install.installed()).toBe(false);
    expect(await install.prompt()).toBe('unavailable');
    const e = new Event('beforeinstallprompt', { cancelable: true }) as Event & { prompt: () => Promise<void>; userChoice: Promise<never> };
    e.prompt = async () => {
      throw new Error('not allowed');
    };
    e.userChoice = new Promise(() => {});
    const seen = vi.fn();
    const off = install.subscribe(seen);
    win.dispatchEvent(e);
    expect(install.available()).toBe(true);
    expect(await install.prompt()).toBe('unavailable');
    expect(install.available()).toBe(false);
    expect(seen).toHaveBeenCalledTimes(2); // the prompt arrived; it was used
    off();
    win.dispatchEvent(new Event('appinstalled'));
    expect(seen).toHaveBeenCalledTimes(2);
    expect(install.installed()).toBe(true);
  });
});
