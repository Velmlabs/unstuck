// Keeps the agent's browser off this machine and its networks: a page (or a redirect) can't send it to localhost, an
// intranet host or cloud metadata and hand what it reads to the agent. --allow-private-network turns it off.
import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import type { CdpClient } from '@velmlabs/unstuck-core';

const PRIVATE = new net.BlockList();
for (const [a, p] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16],
  ['192.0.0.0', 24], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(a, p, 'ipv6');

/** Loopback, private, link-local (cloud metadata), carrier-grade NAT, multicast and reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return PRIVATE.check(mapped[1]!, 'ipv4');
  const family = net.isIP(ip);
  return family === 4 ? PRIVATE.check(ip, 'ipv4') : family === 6 ? PRIVATE.check(ip, 'ipv6') : false;
}

type Lookup = (host: string) => Promise<{ address: string }[]>;
const defaultLookup: Lookup = (host) => dnsLookup(host, { all: true });

/** Whether a host is (or resolves to) a private address. A name that doesn't resolve is the browser's to fail. */
export async function blockedHost(host: string, lookup: Lookup = defaultLookup): Promise<boolean> {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'metadata.google.internal') return true;
  if (net.isIP(h)) return isPrivateAddress(h);
  try {
    return (await lookup(h)).some((a) => isPrivateAddress(a.address));
  } catch {
    return false;
  }
}

/**
 * Pauses every request the tab makes (redirects too) and fails the ones bound for a private address. `onBlock` gets
 * the host, so a failed navigation can say why.
 */
export async function guardNetwork(cdp: CdpClient, o: { isBlocked?: (u: URL) => Promise<boolean>; onBlock: (host: string) => void }): Promise<void> {
  const isBlocked = o.isBlocked ?? ((u: URL) => blockedHost(u.hostname));
  cdp.on('Fetch.requestPaused', (p: { requestId: string; request: { url: string } }) => {
    void (async () => {
      let url: URL | null = null;
      try {
        url = new URL(p.request.url);
      } catch {
        // not a URL we can judge: let the browser handle it
      }
      const block = !!url && (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'ws:' || url.protocol === 'wss:') && (await isBlocked(url));
      if (block) {
        o.onBlock(url!.hostname);
        await cdp.send('Fetch.failRequest', { requestId: p.requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      } else await cdp.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
    })();
  });
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] });
}
