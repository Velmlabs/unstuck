// What the agent does on a page, by snapshot ref: real mouse and keyboard input through CDP.
import type { CdpClient } from '@velmlabs/unstuck-core';
import type { Snapshot } from './snapshot';

export class RefError extends Error {
  constructor(ref: string) {
    super(`ref ${ref} is not on the page any more: take a new snapshot`);
    this.name = 'RefError';
  }
}

export class PasswordFieldError extends Error {
  constructor(ref: string) {
    super(`${ref} is a password field: call ask_human so the person types it`);
    this.name = 'PasswordFieldError';
  }
}

const node = (snap: Snapshot, ref: string): number => {
  const id = snap.refs.get(ref);
  if (id === undefined) throw new RefError(ref);
  return id;
};

/** A DOM call on a ref's node; a node that has gone (navigation, re-render) is a RefError. */
async function onNode<T>(cdp: CdpClient, ref: string, method: string, params: object): Promise<T> {
  try {
    return await cdp.send<T>(method, params);
  } catch {
    throw new RefError(ref);
  }
}

async function centre(cdp: CdpClient, ref: string, backendNodeId: number): Promise<{ x: number; y: number }> {
  await onNode(cdp, ref, 'DOM.scrollIntoViewIfNeeded', { backendNodeId });
  const { quads } = await onNode<{ quads: number[][] }>(cdp, ref, 'DOM.getContentQuads', { backendNodeId });
  const q = quads[0];
  if (!q) throw new RefError(ref);
  return { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
}

export async function clickRef(cdp: CdpClient, snap: Snapshot, ref: string): Promise<void> {
  const { x, y } = await centre(cdp, ref, node(snap, ref));
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}

const key = (cdp: CdpClient, o: object) =>
  cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...o }).then(() => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...o, commands: undefined, text: undefined }));

/** Replaces the field's text (never a password field's: the person types those). Enter afterwards when `submit`. */
export async function typeRef(cdp: CdpClient, snap: Snapshot, ref: string, text: string, submit = false): Promise<void> {
  const backendNodeId = node(snap, ref);
  if (snap.passwords.has(backendNodeId)) throw new PasswordFieldError(ref);
  await onNode(cdp, ref, 'DOM.focus', { backendNodeId });
  await key(cdp, { key: 'a', code: 'KeyA', commands: ['selectAll'] });
  await cdp.send('Input.insertText', { text });
  if (submit) await key(cdp, { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' });
}

const SELECT = `function (v) {
  const o = Array.from(this.options || []).find((x) => x.value === v) || Array.from(this.options || []).find((x) => x.label.trim() === v || x.text.trim() === v);
  if (!o) return false;
  this.value = o.value;
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}`;

/** Picks an option by value, else by its label. */
export async function selectRef(cdp: CdpClient, snap: Snapshot, ref: string, value: string): Promise<void> {
  const { object } = await onNode<{ object: { objectId: string } }>(cdp, ref, 'DOM.resolveNode', { backendNodeId: node(snap, ref) });
  const r = await cdp.send<{ result: { value?: boolean } }>('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: SELECT, arguments: [{ value }], returnByValue: true });
  if (!r.result.value) throw new Error(`no option "${value}" in ${ref}`);
}

export async function scrollPage(cdp: CdpClient, direction: 'up' | 'down' | 'top' | 'bottom'): Promise<void> {
  if (direction === 'top' || direction === 'bottom') {
    await cdp.send('Runtime.evaluate', { expression: direction === 'top' ? 'window.scrollTo(0, 0)' : 'window.scrollTo(0, document.documentElement.scrollHeight)' });
    return;
  }
  const { w, h } = (await cdp.send<{ result: { value: { w: number; h: number } } }>('Runtime.evaluate', { expression: '({ w: innerWidth, h: innerHeight })', returnByValue: true })).result.value;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: w / 2, y: h / 2, deltaX: 0, deltaY: (direction === 'down' ? 0.8 : -0.8) * h });
}

/** Polls every 250 ms until the text is on the page, or the ref's element is visible; false after timeoutS. */
export async function waitForTarget(cdp: CdpClient, o: { text?: string; ref?: string; snap?: Snapshot; timeoutS: number }): Promise<boolean> {
  const end = Date.now() + o.timeoutS * 1000;
  const present = async () => {
    if (o.text !== undefined) {
      const r = await cdp.send<{ result: { value?: boolean } }>('Runtime.evaluate', { expression: `!!document.body && document.body.innerText.includes(${JSON.stringify(o.text)})`, returnByValue: true });
      return r.result.value === true;
    }
    const id = o.snap?.refs.get(o.ref ?? '');
    if (id === undefined) return false;
    const { quads } = await cdp.send<{ quads: number[][] }>('DOM.getContentQuads', { backendNodeId: id });
    return quads.length > 0;
  };
  for (;;) {
    if (await present().catch(() => false)) return true;
    if (Date.now() >= end) return false;
    await new Promise((r) => setTimeout(r, 250));
  }
}

export async function screenshotViewport(cdp: CdpClient): Promise<string> {
  return (await cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png' })).data;
}
