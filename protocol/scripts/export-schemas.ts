// Writes JSON Schemas for the wire protocol, consumed by the Python SDK (Plan 2).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EngineToViewerSchema, ViewerToEngineSchema, SessionStatusSchema } from '../src/viewer';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'schemas');
fs.mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries({
  'viewer-to-engine': ViewerToEngineSchema,
  'engine-to-viewer': EngineToViewerSchema,
  'session-status': SessionStatusSchema,
})) {
  fs.writeFileSync(path.join(out, `${name}.json`), JSON.stringify(schema, null, 2) + '\n');
  console.log(`wrote schemas/${name}.json`);
}
