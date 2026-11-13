import fs from 'node:fs';
import { ENGINE } from './harness';

export function setup() {
  if (!fs.existsSync(ENGINE)) throw new Error(`No engine binary at ${ENGINE}. Build it first: pnpm --filter @unstuck/engine build`);
}
