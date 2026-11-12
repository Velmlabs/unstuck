import { packageConfig } from '../vitest.shared';
export default packageConfig({ exclude: ['src/index.ts', 'src/testing/index.ts', 'src/cdp.ts', 'src/transport.ts'] });
