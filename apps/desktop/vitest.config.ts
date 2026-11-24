import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // SQLite files are created in per-test temp folders; run files one at a time for clear failures.
    fileParallelism: false,
  },
});
