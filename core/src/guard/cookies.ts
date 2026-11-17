import type { SiteSession, StoredCookie } from '@velmlabs/unstuck-protocol';
import type { CdpClient } from '../cdp';
import { siteOf } from '../session/page-lock';

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

const toStored = (c: CdpCookie): StoredCookie => ({
  name: c.name,
  value: c.value,
  domain: c.domain,
  path: c.path,
  expires: c.expires,
  httpOnly: c.httpOnly,
  secure: c.secure,
  ...(c.sameSite ? { sameSite: c.sameSite } : {}),
});

async function allCookies(cdp: CdpClient): Promise<CdpCookie[]> {
  try {
    return (await cdp.send<{ cookies: CdpCookie[] }>('Storage.getCookies')).cookies;
  } catch {
    // Page-level sessions (and some CDP browsers) don't offer the Storage domain.
    return (await cdp.send<{ cookies: CdpCookie[] }>('Network.getAllCookies')).cookies;
  }
}

const onSite = (domain: string, site: string) => {
  const d = domain.replace(/^\./, '').toLowerCase();
  return d === site || d.endsWith(`.${site}`);
};

/** The browser's cookies for a site and its subdomains. */
export async function readCookies(cdp: CdpClient, site: string): Promise<StoredCookie[]> {
  const s = siteOf(site);
  return (await allCookies(cdp)).filter((c) => onSite(c.domain, s)).map(toStored);
}

const key = (c: { name: string; domain: string; path: string }) => `${c.name}\u0000${c.domain}\u0000${c.path}`;

/** Sets the remembered cookies the browser doesn't have; never overwrites one it has. Returns how many were set. */
export async function setMissingCookies(cdp: CdpClient, cookies: StoredCookie[]): Promise<number> {
  const have = new Set((await allCookies(cdp)).map(key));
  const missing = cookies.filter((c) => !have.has(key(c)));
  if (missing.length > 0) await cdp.send('Network.setCookies', { cookies: missing });
  return missing.length;
}

export async function deleteCookies(cdp: CdpClient, cookies: StoredCookie[]): Promise<void> {
  for (const c of cookies) await cdp.send('Network.deleteCookies', { name: c.name, domain: c.domain, path: c.path });
}

export const cookieHeader = (cookies: StoredCookie[]): string => cookies.map((c) => `${c.name}=${c.value}`).join('; ');

/** The site's live session for an agent that asked for it: cookies plus the User-Agent that earned them. */
export async function sessionFor(cdp: CdpClient, site: string): Promise<SiteSession> {
  const s = siteOf(site);
  const cookies = await readCookies(cdp, s);
  const ua = await cdp.send<{ result?: { value?: string } }>('Runtime.evaluate', { expression: 'navigator.userAgent', returnByValue: true });
  return { site: s, userAgent: ua.result?.value ?? '', cookies, cookieHeader: cookieHeader(cookies) };
}
