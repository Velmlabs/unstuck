import { describe, it, expect } from 'vitest';
import { hostnames } from '../../src/cloud/sites';

describe('hostnames', () => {
  it('keeps plausible hostnames only, at most 20', () => {
    expect(hostnames(['accounts.google.com', '*.okta.com', 'localhost', 'https://x.com', 'a b', 7, '', 'x'.repeat(300)])).toEqual(['accounts.google.com', '*.okta.com', 'localhost']);
    expect(hostnames('example.com')).toEqual([]);
    // A bare public suffix would allow a whole TLD or platform (a prompt-injected agent could be talked into it).
    expect(hostnames(['com', 'co.uk', 'github.io', '*.co.uk', 'me.github.io', 'example.co.uk'])).toEqual(['me.github.io', 'example.co.uk']);
    expect(hostnames(undefined)).toEqual([]);
    expect(hostnames(Array.from({ length: 30 }, (_, i) => `s${i}.com`))).toHaveLength(20);
  });
});
