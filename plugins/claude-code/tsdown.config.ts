import { defineConfig } from 'tsdown'

export default defineConfig({
  platform: 'node',
  exports: { inlinedDependencies: false },
  deps: {
    alwaysBundle: ['@pi-plugins/shared', /^effect(\/|$)/, /^@effect\//],
  },
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
})
