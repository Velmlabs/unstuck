/**
 * The unit that per-IP limits count: an IPv4 address, or an IPv6 /64 (a subscriber usually gets a whole /64, so
 * counting single IPv6 addresses would let one client dodge every limit). Unparsable input is returned as is.
 */
export function ipKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1]!;
  if (!ip.includes(':')) return ip;
  const [head, tail, extra] = ip.toLowerCase().split('::');
  if (extra !== undefined) return ip;
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail ? tail.split(':') : [];
  const missing = 8 - left.length - right.length;
  if (tail === undefined ? missing !== 0 : missing < 1) return ip;
  const groups = [...left, ...Array(tail === undefined ? 0 : missing).fill('0'), ...right];
  if (groups.length !== 8 || !groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return ip;
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
