# @velmlabs/unstuck-core

The core of [Unstuck](https://unstuck.sh)'s takeover engine: screencast, input, takeover sessions and transports. It has no Node-only dependencies, so it also runs inside Cloudflare Workers, where there's no engine binary:

```ts
import { createEngine, createRelayTransport } from '@velmlabs/unstuck-core';

const engine = createEngine({ transport: createRelayTransport({ url: 'wss://relay.unstuck.sh', agentKey: env.UNSTUCK_API_KEY }) });
```

Most agents should use [`@velmlabs/unstuck`](https://www.npmjs.com/package/@velmlabs/unstuck) instead. Docs: https://unstuck.sh/docs · License: Apache-2.0
