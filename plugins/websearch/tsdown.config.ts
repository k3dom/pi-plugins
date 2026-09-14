import { defineConfig } from 'tsdown'

export default defineConfig({
  platform: 'node',
  exports: true,
  deps: {
    alwaysBundle: ['@pi-plugins/shared'],
  },
  sourcemap: true,
  dts: {
    sourcemap: true,
  },
})
