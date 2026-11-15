import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/preact';
import { Pair, type PairProps } from '../src/pair/Pair';
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

  it('asks first; Keep current keeps the old pairing and sends nothing', async () => {
    const store = old();
    const { fetchFn } = setup({ store });
    await screen.findByText('This browser is already paired as Old Pixel. Pair it again?');
    expect(screen.queryByRole('button', { name: 'Pair this phone' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Keep current' }));
    await screen.findByText(/this phone is paired/i);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(store.rec?.deviceId).toBe('old');
  });

  it('Pair again pairs the new device, then removes the old one with its own token, then stores the new record', async () => {
    const store = old();
    const { fetchFn } = setup({ store });
    fireEvent.click(await screen.findByRole('button', { name: 'Pair again' }));
    await pairNow();
    await screen.findByText(/this phone is paired/i);
    const urls = fetchFn.mock.calls.map((c) => c[0]);
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
