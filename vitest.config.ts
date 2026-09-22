import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'nx-ruby-on-rails',
    globals: true,
    // Plugin code is pure Node (fs, path, Nx devkit) — no DOM anywhere.
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: ['src/**/schema.d.ts', 'src/**/__fixtures__/**'],
    },
  },
});
