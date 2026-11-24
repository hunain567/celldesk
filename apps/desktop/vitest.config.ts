import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Local-time rules (backup schedule, retention) are tested in the shops' time zone.
    env: { TZ: 'Asia/Karachi' },
    // SQLite files are created in per-test temp folders; run files one at a time for clear failures.
    fileParallelism: false,
    testTimeout: 20000,
  },
});
