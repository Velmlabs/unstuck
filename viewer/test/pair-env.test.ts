import { describe, it, expect } from 'vitest';
import { apiBaseFor, defaultLabel, pushNeedsHomeScreen, codeFromHash } from '../src/pair/env';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
const IPAD_DESKTOP = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15';

describe('apiBaseFor', () => {
  it('always uses unstuck.sh on view.unstuck.sh, ignoring ?api=', () => {
    expect(apiBaseFor('view.unstuck.sh', '?api=https://evil.example')).toBe('https://unstuck.sh');
    expect(apiBaseFor('view.unstuck.sh', '')).toBe('https://unstuck.sh');
  });
  it('elsewhere uses ?api= when https, or http on localhost / 127.0.0.1', () => {
    expect(apiBaseFor('staging-view.example.dev', '?api=https://staging.example.dev')).toBe('https://staging.example.dev');
    expect(apiBaseFor('127.0.0.1', '?api=http://127.0.0.1:8787')).toBe('http://127.0.0.1:8787');
    expect(apiBaseFor('x.dev', '?api=http://localhost:8787/')).toBe('http://localhost:8787');
  });
  it('falls back to unstuck.sh for anything else', () => {
    expect(apiBaseFor('x.dev', '?api=http://evil.example')).toBe('https://unstuck.sh');
    expect(apiBaseFor('x.dev', '?api=javascript:alert(1)')).toBe('https://unstuck.sh');
    expect(apiBaseFor('x.dev', '?api=not a url')).toBe('https://unstuck.sh');
    expect(apiBaseFor('x.dev', '?api=https://user:pw@a.dev')).toBe('https://unstuck.sh');
    expect(apiBaseFor('x.dev', '')).toBe('https://unstuck.sh');
  });
});

describe('defaultLabel', () => {
  it('names the phone and browser', () => {
    expect(defaultLabel(IPHONE, true)).toBe('iPhone · Home screen app');
    expect(defaultLabel(IPHONE, false)).toBe('iPhone · Safari');
    expect(defaultLabel(ANDROID, false)).toBe('Android · Chrome');
    expect(defaultLabel('Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0', false)).toBe('Android · Firefox');
    expect(defaultLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/124 SamsungBrowser/24 Mobile', false)).toBe('Android · Browser');
    expect(defaultLabel(IPAD_DESKTOP, false, 5)).toBe('iPad · Safari');
  });
  it('desktop browsers', () => {
    expect(defaultLabel('Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36 Edg/124.0', false)).toBe('Desktop · Edge');
    expect(defaultLabel('Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0', false)).toBe('Desktop · Firefox');
    expect(defaultLabel('Mozilla/5.0 (X11; Linux x86_64) Chrome/124.0 Safari/537.36', false)).toBe('Desktop · Chrome');
    expect(defaultLabel(IPAD_DESKTOP, false, 0)).toBe('Desktop · Safari');
    expect(defaultLabel('weird', false)).toBe('Desktop · Browser');
  });
});

describe('pushNeedsHomeScreen', () => {
  it('is true on iPhone/iPad Safari (also iPadOS posing as a Mac) and false in the home-screen app and elsewhere', () => {
    expect(pushNeedsHomeScreen(IPHONE, false, 5)).toBe(true);
    expect(pushNeedsHomeScreen(IPHONE, true, 5)).toBe(false);
    expect(pushNeedsHomeScreen(IPAD_DESKTOP, false, 5)).toBe(true);
    expect(pushNeedsHomeScreen(IPAD_DESKTOP, false, 0)).toBe(false);
    expect(pushNeedsHomeScreen(ANDROID, false, 5)).toBe(false);
  });
});

describe('codeFromHash', () => {
  it('reads #c=', () => {
    expect(codeFromHash('#c=AbC_-1')).toBe('AbC_-1');
    expect(codeFromHash('')).toBeNull();
    expect(codeFromHash('#x=1')).toBeNull();
    expect(codeFromHash('#c=')).toBeNull();
  });
});
