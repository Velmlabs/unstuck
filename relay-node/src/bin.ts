#!/usr/bin/env node
import { main } from './cli';

const r = await main(process.argv.slice(2), process.env, { stderr: process.stderr });
if (typeof r === 'number') process.exit(r);
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.once(sig, () => void r.close().then(() => process.exit(0)));
