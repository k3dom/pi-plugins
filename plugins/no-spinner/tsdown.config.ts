import { defineConfig } from 'tsdown'

export default defineConfig({
  platform: 'node',
  exports: { inlinedDependencies: false },
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
})
