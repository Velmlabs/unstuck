/**
 * Waits until the phone's viewer has the page's first frame (the canvas carries data-framed). A blank canvas is
 * already 300 px wide, so its width says nothing: a tap before the first frame has nothing to land on.
 */
export async function waitFramed(human: { waitForSelector: (s: string, o: { state: 'attached'; timeout: number }) => Promise<unknown> }, timeout = 20_000) {
  await human.waitForSelector('canvas[data-framed]', { state: 'attached', timeout });
}
