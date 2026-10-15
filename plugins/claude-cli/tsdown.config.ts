import { defineConfig } from 'tsdown'

export default defineConfig({
  platform: 'node',
  exports: { inlinedDependencies: false },
  deps: {
    alwaysBundle: [/^effect(\/|$)/, /^@effect\//],
  },
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
})
