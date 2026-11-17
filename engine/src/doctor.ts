import { probeCapabilities, type Capabilities, type CdpClient } from '@velmlabs/unstuck-core';
import { connectCdp, type DirectCdp } from './direct-cdp';
import { checkIframePaint, serveProbePages, waitFor } from './browser/paint-check';

export { serve } from './browser/paint-check';

export interface DoctorReport {
  browser: string;
  capabilities: Capabilities;
  crossOriginIframePaint: boolean | 'unknown';
  popupTracking: boolean | 'unknown';
  verdict: 'full' | 'limited' | 'unsupported';
  notes: string[];
}

const LIMITED_NOTE = 'CAPTCHA widgets in cross-origin iframes will not be visible; use Chromium for CAPTCHAs';
const POPUP_WAIT_MS = 3000;

async function checkPopups(tab: DirectCdp): Promise<{ seen: boolean; ids: string[] }> {
  const ids: string[] = [];
  let seen = false;
  const offCreated = tab.browser.on('Target.targetCreated', (e: { targetInfo: { targetId: string; openerId?: string } }) => {
    if (e.targetInfo.openerId === tab.targetId) ids.push(e.targetInfo.targetId);
  });
  const offPopup = tab.popups.onPopup(() => (seen = true));
  await tab.send('Runtime.evaluate', { expression: "window.open('about:blank#unstuck-doctor', '_blank')", userGesture: true }).catch(() => {});
  await waitFor(async () => seen, POPUP_WAIT_MS);
  offPopup();
  offCreated();
  return { seen, ids };
}

/** Checks a browser end to end in a tab of its own; never touches the user's tabs (spec §4.4). */
export async function runDoctor(cdpUrl: string, opts: { connect?: typeof connectCdp } = {}): Promise<DoctorReport> {
  const connect = opts.connect ?? connectCdp;
  const pages = await serveProbePages();
  let tab: DirectCdp | undefined;
  const opened: string[] = [];
  try {
    // One connection for everything: works on browsers with no tabs and on ones that scope tabs per connection.
    tab = await connect(cdpUrl, { createUrl: pages.url });
    opened.push(tab.targetId);
    const browser = await tab.browser
      .send<{ product: string }>('Browser.getVersion')
      .then((v) => v.product)
      .catch(() => 'unknown browser');
    const capabilities = await probeCapabilities(tab);
    const crossOriginIframePaint = await checkIframePaint(tab).catch(() => 'unknown' as const);
    const popups = await checkPopups(tab);
    opened.push(...popups.ids);
    const notes: string[] = [];
    if (!capabilities.screencast) notes.push('no screencast: Unstuck will poll screenshots (about 5 fps)');
    if (!capabilities.insertText) notes.push('no insertText: Unstuck will type text key by key');
    if (crossOriginIframePaint === false) notes.push(LIMITED_NOTE);
    if (crossOriginIframePaint === 'unknown')
      notes.push('could not load the test page from the browser (it may not reach this machine): CAPTCHA support was not checked');
    if (!popups.seen) notes.push('popups are not reported: a CAPTCHA that opens a window cannot be followed');
    // FULL only when CAPTCHA rendering was actually verified.
    const verdict = !capabilities.input ? 'unsupported' : crossOriginIframePaint === true ? 'full' : 'limited';
    return { browser, capabilities, crossOriginIframePaint, popupTracking: popups.seen, verdict, notes };
  } finally {
    if (tab) {
      for (const id of opened.reverse()) await tab.browser.send('Target.closeTarget', { targetId: id }).catch(() => {});
      await tab.close();
    }
    await pages.close();
  }
}

const mark = (v: boolean | 'unknown') => (v === 'unknown' ? '?' : v ? '✓' : '✗');

export function formatReport(r: DoctorReport): string {
  return [
    `Browser: ${r.browser}`,
    `${mark(r.capabilities.screencast)} live view (screencast)`,
    `${mark(r.capabilities.insertText)} paste (insertText)`,
    `${mark(r.capabilities.input)} mouse and keyboard input`,
    `${mark(r.crossOriginIframePaint)} cross-origin iframes painted (CAPTCHA widgets)`,
    `${mark(r.popupTracking)} popups reported`,
    `Verdict: ${r.verdict.toUpperCase()}`,
    ...r.notes.map((n) => `  - ${n}`),
    '',
  ].join('\n');
}
