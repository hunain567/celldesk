import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@desktop-main': resolve(__dirname, '../desktop/src/main') } },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    env: { TZ: 'Asia/Karachi' },
    fileParallelism: false,
    testTimeout: 20000,
  },
});
