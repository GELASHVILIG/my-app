import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'infra/**/*.test.ts', 'tests/**/*.test.ts'],
    coverage: { reporter: ['text', 'lcov'] },
  },
});
