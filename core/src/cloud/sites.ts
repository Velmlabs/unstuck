import { isPublicSuffix } from '../session/page-lock';

/** Keeps only plausible hostnames that aren't bare public suffixes (a leading "*." is accepted), at most 20. */
export function hostnames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h): h is string => typeof h === 'string' && /^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*\.?$/i.test(h) && h.length <= 253)
    // Never a bare public suffix ("com", "co.uk", "github.io"): that would open a whole TLD or platform.
    .filter((h) => h.toLowerCase() === 'localhost' || !isPublicSuffix(h))
    .slice(0, 20);
}
