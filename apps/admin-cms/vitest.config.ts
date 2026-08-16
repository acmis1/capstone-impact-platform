import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      'server-only': path.resolve(__dirname, '../../node_modules/server-only/empty.js'),
    },
  },
  test: {
    environment: 'node',
    clearMocks: true,
    include: [
      'src/**/*.test.ts',
      'src/**/*.test.tsx',
    ],
  },
});
