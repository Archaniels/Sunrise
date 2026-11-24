import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const sharedEntry = fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@sunrise/shared': sharedEntry,
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
  },
});
