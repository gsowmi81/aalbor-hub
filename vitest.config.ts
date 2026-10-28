import { defineConfig } from 'vitest/config';

// The database tests share one test database, so files run one at a time.
export default defineConfig({ test: { fileParallelism: false, testTimeout: 20000 } });
